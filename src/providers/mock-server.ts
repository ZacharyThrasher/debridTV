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
  reset(): void;
  close(): Promise<void>;
}

const CHUNK = 64 * 1024;
const ZEROES = Buffer.alloc(CHUNK, 0x47);

export async function startMockProviders(opts: MockOptions): Promise<MockProviders> {
  const files = new Map(opts.files.map((f) => [f.ref, f]));
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
      return json(res, 429, { error: "too_many_requests" });
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
        json(res, 200, opts.files.filter((f) => f.ref.startsWith("rd:")).map((f) => ({
          id: f.ref.slice(3), filename: f.name, bytes: f.bytes, status: "downloaded",
          links: [`https://real-debrid.example/d/${f.ref.slice(3)}`],
        }))),
      );
    }
    if (p === "/rd/rest/1.0/unrestrict/link" && req.method === "POST") {
      return void api(req, res, "rd.unrestrict", "rd", rdLimit, (_u, body) => {
        const link = new URLSearchParams(body).get("link") ?? "";
        const ref = `rd:${link.split("/").pop()}`;
        const f = files.get(ref);
        if (!f) return json(res, 404, { error: "unknown_ressource" });
        json(res, 200, { id: f.ref, filename: f.name, filesize: f.bytes, download: issueGrant(ref) });
      });
    }
    if (p === "/tb/v1/api/torrents/mylist") {
      return void api(req, res, "tb.mylist", "tb.mylist", tbLimit, () =>
        json(res, 200, { success: true, data: opts.files.filter((f) => f.ref.startsWith("tb:")).map((f) => {
          const [, tid, fid] = f.ref.split(":");
          return { id: Number(tid), name: f.name, download_finished: true, download_present: true,
            files: [{ id: Number(fid), name: f.name, size: f.bytes }] };
        }) }),
      );
    }
    if (p === "/tb/v1/api/torrents/requestdl") {
      return void api(req, res, "tb.requestdl", "tb.requestdl", tbLimit, (q) => {
        const ref = `tb:${q.searchParams.get("torrent_id")}:${q.searchParams.get("file_id")}`;
        if (!files.has(ref)) return json(res, 404, { success: false, error: "NOT_FOUND" });
        const url = issueGrant(ref);
        if (q.searchParams.get("redirect") === "true") {
          res.writeHead(302, { location: url });
          return res.end();
        }
        json(res, 200, { success: true, data: url });
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
      remaining -= n;
      counters.mediaBytes += n;
      const ok = res.write(n === CHUNK ? ZEROES : ZEROES.subarray(0, n));
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
