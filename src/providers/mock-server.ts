// An in-process stand-in for Real-Debrid, TorBox and their download hosts. It
// exists so cancellation, request counts and media bytes can be measured from the
// server side (the honest side) without touching a real account. Route shapes
// follow the public docs cited in the handoff (R02, T10) but are NOT verified
// against the live services; treat them as fixtures, not as API truth.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockFile {
  /** Provider-side reference, e.g. "rd:<id>" or "tb:<torrent>:<file>". */
  ref: string;
  name: string;
  bytes: number;
  /** Real bytes to serve (e.g. a small fixture). Without it the file is filler. */
  content?: Uint8Array;
  /** Provider readiness wording (RD status / TorBox finished flag). Default: ready. */
  state?: "ready" | "downloading" | "magnet_error";
  /** The provider refuses this file on link generation (RD infringing_file, code 35). */
  policy?: boolean;
  /** ETag the media host sends for this file. Default: derived from ref and size. */
  etag?: string;
  /** Real-Debrid: files sharing a pack name are listed as one multi-file torrent. */
  pack?: string;
  /** Real-Debrid pack member that /torrents/info lists without a link (files and links no longer pair). */
  noLink?: boolean;
}

export interface MockAccount {
  /** The only key(s) the mock accepts (Bearer header, or `token` on TorBox requestdl). */
  token?: string | string[];
  premiumUntilMs?: number | null;
  plan?: string;
}

export interface MockOptions {
  files: MockFile[];
  /** Simulated latency of each API call. */
  apiLatencyMs?: number;
  /** Delay before a media response starts (LIVE-001 TorBox CDN: ~130–250 ms). */
  mediaTtfbMs?: number;
  /** Pacing of media responses (bytes per second, per connection). */
  linkBytesPerSec?: number;
  /** How long a generated download URL works. */
  grantTtlMs?: number;
  /** Real-Debrid: requests per minute, all endpoints together (R02: 250). */
  rdPerMinute?: number;
  /** TorBox: requests per minute per endpoint (T04: 300). */
  tbPerMinutePerEndpoint?: number;
  /** Account facts and key check. Without it any key is accepted. */
  account?: MockAccount;
  /** Real-Debrid: while this returns true, link requests answer 503 with no error code (as seen live under load). */
  rdDown?: () => boolean;
  /** Sent as Retry-After with those 503s. */
  rdDownRetryAfterSec?: number;
  /** Those 503s carry this Real-Debrid error code (an answer about the file, e.g. 19 hoster_unavailable). */
  rdDownCode?: number;
}

export interface ServerCounters {
  api: Record<string, number>;
  rateLimited: number;
  mediaRequests: number;
  mediaBytes: number;
  mediaAborted: number;
  activeMedia: number;
  peakActiveMedia: number;
  expiredGrantHits: number;
}

export interface MockProviders {
  baseUrl: string;
  counters: ServerCounters;
  /** Change the library between calls (files added, removed, finished). */
  setFiles(files: MockFile[]): void;
  /** Change account facts (e.g. premium expiry) between calls. */
  setAccount(account: MockAccount): void;
  reset(): void;
  close(): Promise<void>;
}

const CHUNK = 64 * 1024;
const ZEROES = Buffer.alloc(CHUNK, 0x47);

export async function startMockProviders(opts: MockOptions): Promise<MockProviders> {
  let list = opts.files.slice();
  let files = new Map(list.map((f) => [f.ref, f]));
  let account: MockAccount = opts.account ?? {};
  const grants = new Map<string, { ref: string; expiresAt: number }>();
  const windows = new Map<string, number[]>();
  const counters = freshCounters();
  const latency = opts.apiLatencyMs ?? 0;
  const pace = opts.linkBytesPerSec ?? 12_500_000;
  const ttl = opts.grantTtlMs ?? 60 * 60_000;
  let seq = 0;
  let baseUrl = "";

  const limited = (bucket: string, perMinute: number): boolean => {
    const now = Date.now();
    const w = (windows.get(bucket) ?? []).filter((t) => now - t < 60_000);
    w.push(now); // refused requests count too (R02)
    windows.set(bucket, w);
    return w.length > perMinute;
  };

  const rdLink = (f: MockFile) => `https://real-debrid.example/d/${f.ref.slice(3)}`;
  /** RD view of the library: one torrent per file, or per pack. */
  const rdTorrents = () => {
    const out: Array<{ id: string; name: string; status: string; files: MockFile[] }> = [];
    for (const f of list.filter((x) => x.ref.startsWith("rd:"))) {
      const status = f.state === "downloading" ? "downloading" : f.state === "magnet_error" ? "magnet_error" : "downloaded";
      const t = f.pack ? out.find((x) => x.id === `pack-${f.pack}`) : undefined;
      if (t) t.files.push(f);
      else out.push({ id: f.pack ? `pack-${f.pack}` : f.ref.slice(3), name: f.pack ?? f.name, status, files: [f] });
    }
    return out;
  };

  const issueGrant = (ref: string): string => {
    const token = `g${++seq}`;
    grants.set(token, { ref, expiresAt: Date.now() + ttl });
    return `${baseUrl}/cdn/${token}`;
  };

  const api = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    name: string,
    bucket: string,
    perMinute: number,
    handler: (u: URL, body: string) => void,
  ) => {
    counters.api[name] = (counters.api[name] ?? 0) + 1;
    const body = await readBody(req);
    if (limited(bucket, perMinute)) {
      counters.rateLimited++;
      return json(res, 429, name.startsWith("rd.") ? { error: "too_many_requests", error_code: 34 } : { success: false, error: "TOO_MANY_REQUESTS" });
    }
    if (account.token) {
      const u = new URL(req.url!, "http://x");
      const given = (req.headers.authorization ?? "").replace(/^Bearer /, "") || u.searchParams.get("token");
      if (!given || ![account.token].flat().includes(given))
        return json(res, 401, name.startsWith("rd.") ? { error: "bad_token", error_code: 8 } : { success: false, error: "AUTH_ERROR" });
    }
    if (latency) await sleep(latency);
    if (res.destroyed) return; // client gave up (aborted tune)
    handler(new URL(req.url!, baseUrl), body);
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    const p = u.pathname;
    const rdLimit = opts.rdPerMinute ?? 250;
    const tbLimit = opts.tbPerMinutePerEndpoint ?? 300;

    if (p === "/rd/rest/1.0/torrents") {
      return void api(req, res, "rd.torrents", "rd", rdLimit, () =>
        json(res, 200, rdTorrents().map((t) => ({ id: t.id, filename: t.name, bytes: t.files.reduce((n, f) => n + f.bytes, 0), status: t.status,
          links: t.status === "downloaded" ? t.files.map(rdLink) : [] }))),
      );
    }
    const info = /^\/rd\/rest\/1\.0\/torrents\/info\/(.+)$/.exec(p);
    if (info) {
      return void api(req, res, "rd.torrents.info", "rd", rdLimit, () => {
        const t = rdTorrents().find((x) => x.id === decodeURIComponent(info[1]!));
        if (!t) return json(res, 404, { error: "unknown_ressource", error_code: 20 });
        json(res, 200, { id: t.id, filename: t.name, status: t.status,
          files: t.files.map((f, i) => ({ id: i + 1, path: `/${f.name}`, bytes: f.bytes, selected: 1 })), links: t.files.filter((f) => !f.noLink).map(rdLink) });
      });
    }
    if (p === "/rd/rest/1.0/unrestrict/link" && req.method === "POST") {
      return void api(req, res, "rd.unrestrict", "rd", rdLimit, (_u, body) => {
        const link = new URLSearchParams(body).get("link") ?? "";
        const ref = `rd:${link.split("/").pop()}`;
        const f = files.get(ref);
        if (!f) return json(res, 404, { error: "unknown_ressource", error_code: 20 });
        if (f.policy) return json(res, 503, { error: "infringing_file", error_code: 35 });
        if (opts.rdDown?.()) {
          if (opts.rdDownRetryAfterSec) res.setHeader("retry-after", String(opts.rdDownRetryAfterSec));
          return json(res, 503, opts.rdDownCode ? { error: "hoster_unavailable", error_code: opts.rdDownCode } : { error: "service_unavailable" });
        }
        json(res, 200, { id: f.ref, filename: f.name, filesize: f.bytes, download: issueGrant(ref) });
      });
    }
    if (p === "/tb/v1/api/torrents/mylist") {
      return void api(req, res, "tb.mylist", "tb.mylist", tbLimit, () =>
        json(res, 200, { success: true, data: list.filter((f) => f.ref.startsWith("tb:")).map((f) => {
          const [, tid, fid] = f.ref.split(":");
          const ready = !f.state || f.state === "ready";
          return { id: Number(tid), name: f.name, download_finished: ready, download_present: ready,
            files: [{ id: Number(fid), name: f.name, size: f.bytes }] };
        }) }),
      );
    }
    if (p === "/tb/v1/api/torrents/requestdl") {
      return void api(req, res, "tb.requestdl", "tb.requestdl", tbLimit, (q) => {
        const ref = `tb:${q.searchParams.get("torrent_id")}:${q.searchParams.get("file_id")}`;
        const f = files.get(ref);
        if (!f) return json(res, 404, { success: false, error: "NOT_FOUND" });
        if (f.state && f.state !== "ready") return json(res, 400, { success: false, error: "DOWNLOAD_NOT_READY" });
        const url = issueGrant(ref);
        if (q.searchParams.get("redirect") === "true") {
          res.writeHead(302, { location: url });
          return res.end();
        }
        json(res, 200, { success: true, data: url });
      });
    }
    if (p === "/rd/rest/1.0/user") {
      return void api(req, res, "rd.user", "rd", rdLimit, () => {
        const until = account.premiumUntilMs ?? null;
        const left = until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0;
        json(res, 200, { id: 1, username: "mock", email: "mock@example.invalid", points: 0, type: left > 0 ? "premium" : "free",
          premium: left, expiration: until ? new Date(until).toISOString() : null });
      });
    }
    if (p === "/tb/v1/api/user/me") {
      return void api(req, res, "tb.user", "tb.user", tbLimit, () => {
        const until = account.premiumUntilMs ?? null;
        json(res, 200, { success: true, data: { id: 1, email: "mock@example.invalid", plan: Number(account.plan ?? 2),
          premium_expires_at: until ? new Date(until).toISOString() : null } });
      });
    }
    if (p.startsWith("/cdn/")) return serveMedia(req, res, p.slice(5));
    json(res, 404, { error: "no_route" });
  });

  const serveMedia = (req: http.IncomingMessage, res: http.ServerResponse, token: string) => {
    counters.mediaRequests++;
    const ttfb = opts.mediaTtfbMs ?? 0;
    if (ttfb > 0) setTimeout(() => !res.destroyed && serveMediaNow(req, res, token), ttfb);
    else serveMediaNow(req, res, token);
  };

  const serveMediaNow = (req: http.IncomingMessage, res: http.ServerResponse, token: string) => {
    const g = grants.get(token);
    if (!g) return json(res, 404, { error: "unknown_grant" });
    if (Date.now() > g.expiresAt) {
      counters.expiredGrantHits++;
      return json(res, 403, { error: "expired" });
    }
    const f = files.get(g.ref)!;
    let start = 0;
    let end = f.bytes - 1;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${f.bytes}` });
      return res.end();
    }
    res.writeHead(m ? 206 : 200, {
      "content-type": "video/x-matroska",
      "accept-ranges": "bytes",
      etag: f.etag ?? `"${f.ref.replace(/\W/g, "")}-${f.bytes.toString(16)}"`,
      "content-length": String(end - start + 1),
      ...(m ? { "content-range": `bytes ${start}-${end}/${f.bytes}` } : {}),
    });
    counters.activeMedia++;
    counters.peakActiveMedia = Math.max(counters.peakActiveMedia, counters.activeMedia);
    let remaining = end - start + 1;
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      counters.activeMedia--;
      if (aborted) counters.mediaAborted++;
    };
    res.on("close", () => finish(remaining > 0));
    const tickMs = Math.max(1, Math.round((CHUNK / pace) * 1000));
    const pump = () => {
      if (res.destroyed || done) return finish(true);
      if (remaining <= 0) {
        res.end();
        return finish(false);
      }
      const n = Math.min(CHUNK, remaining);
      const at = end + 1 - remaining;
      remaining -= n;
      counters.mediaBytes += n;
      const ok = res.write(f.content ? filled(f.content, at, n) : n === CHUNK ? ZEROES : ZEROES.subarray(0, n));
      if (ok) setTimeout(pump, tickMs);
      else res.once("drain", () => setTimeout(pump, tickMs));
    };
    pump();
  };

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    counters,
    setFiles(next) {
      list = next.slice();
      files = new Map(list.map((f) => [f.ref, f]));
    },
    setAccount(next) {
      account = next;
    },
    reset() {
      Object.assign(counters, freshCounters(), { activeMedia: counters.activeMedia });
      windows.clear();
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Bytes [at, at+n) of a fixture; past its end, filler (so a small fixture can pose as a big file). */
function filled(content: Uint8Array, at: number, n: number): Buffer {
  const out = Buffer.alloc(n, 0x47);
  if (at < content.byteLength) out.set(content.subarray(at, Math.min(content.byteLength, at + n)));
  return out;
}

function freshCounters(): ServerCounters {
  return { api: {}, rateLimited: 0, mediaRequests: 0, mediaBytes: 0, mediaAborted: 0,
    activeMedia: 0, peakActiveMedia: 0, expiredGrantHits: 0 };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", () => resolve(s));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
