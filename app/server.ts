// DebridTV local server. Runs on the viewer's own PC and listens on 127.0.0.1 only:
// nothing here is reachable from other devices (sharing and tuner export stay
// behind their gates). Provider keys live in the local data folder and never reach
// the browser. Media is proxied so every byte and every cancellation is measured.
//
//   node app/server.ts            then open http://127.0.0.1:7337

import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { StationClock } from "../src/clock/schedule.ts";
import type { Airing } from "../src/clock/types.ts";
import { WatchLedger } from "../src/history/watched.ts";
import { ProviderError } from "../src/providers/types.ts";
import { Gates } from "../src/gates.ts";
import { JsonFile, dataDir } from "./store.ts";
import { Library, displayTitle, type Config, type LibItem } from "./library.ts";
import { Lineup, autoRules, type StationChannel, type CustomChannel } from "./lineup.ts";
import { Meters } from "./meters.ts";
import { demoItems } from "./demo.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.PORT ?? 7337);
const HOST = "127.0.0.1";
const MIN = 60_000;

// ---------------------------------------------------------------- state

const config = new JsonFile<Config>("config.json", () => ({}));
const historyFile = new JsonFile<{ spans: Record<string, Array<[number, number]>>; recent: Array<{ at: number; itemId: string; channel: string }> }>(
  "history.json",
  () => ({ spans: {}, recent: [] }),
);
const meters = new Meters();
const gates = new Gates(); // Nothing is granted; no code path here asks for a gate.
const library = new Library(() => config.get(), meters, () => scheduleRebuild());
const liveLineup = new Lineup("lineup.json");
const demoLineup = new Lineup("lineup-demo.json");
const demo = demoItems();
const ledger = WatchLedger.import(historyFile.get().spans);
const ffmpeg = detectFfmpeg();
const ffprobe = ffmpeg ? detectFfprobe() : null;

function connected() {
  const c = config.get();
  return { torbox: !!c.torboxKey, realdebrid: !!c.rdToken, local: (c.localDirs ?? []).length > 0 };
}

function isDemo(): boolean {
  const c = connected();
  if (process.env.DEBRIDTV_DEMO === "1") return true;
  if (!(c.torbox || c.realdebrid || c.local)) return true;
  // Connected but nothing playable yet: keep the demo on air until the first channel exists.
  return liveLineup.channels().length === 0;
}

function allItems(): LibItem[] {
  return isDemo() ? demo : library.items();
}
function itemById(id: string): LibItem | undefined {
  return id.startsWith("demo-") ? demo.find((d) => d.id === id) : library.get(id);
}
function lineup(): Lineup {
  return isDemo() ? demoLineup : liveLineup;
}

let clock = new StationClock([]);
let rebuildTimer: NodeJS.Timeout | null = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild();
  }, 300);
}
function rebuild() {
  const now = Date.now();
  // Live channels are kept in sync even while the demo is showing, so the switch is seamless.
  const liveItems = library.items();
  const liveClock = new StationClock(library.mediaItems());
  liveLineup.sync(liveClock, autoRules(liveItems, liveLineup.custom()), now);
  const demoClock = new StationClock(demoMedia());
  demoLineup.sync(demoClock, autoRules(demo, demoLineup.custom()), now);
  clock = isDemo() ? demoClock : liveClock;
}
function demoMedia() {
  return demo.map((i) => ({
    id: i.id,
    title: displayTitle(i),
    showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined,
    season: i.parsed.kind === "episode" ? i.parsed.season : undefined,
    episode: i.parsed.kind === "episode" ? i.parsed.episode : undefined,
    durationMs: i.durationMs,
    source: { provider: i.provider, ref: i.ref },
  }));
}
rebuild();

// ---------------------------------------------------------------- views

function channelView(c: StationChannel) {
  return { id: c.id, number: c.number, name: c.name, hue: c.meta.hue, kind: c.meta.kind, tagline: c.meta.tagline, ruleKey: c.meta.ruleKey };
}

function airingView(a: Airing) {
  const it = itemById(a.itemId);
  const p = it?.parsed;
  return {
    start: a.startMs,
    end: a.endMs,
    itemId: a.itemId,
    title: p?.kind === "episode" ? p.show : p?.kind === "movie" ? p.title : (it?.name ?? "Unknown"),
    episode: p?.kind === "episode" ? (p.absolute ? `Ep. ${p.episode}` : `S${p.season} · E${p.episode}`) : undefined,
    year: p?.kind === "movie" ? p.year : undefined,
    subtitle: it?.subtitle,
    genre: it?.genre,
    kind: p?.kind,
    durationMs: it?.durationMs ?? null,
    availability: it?.availability ?? "unknown",
    availabilityReason: it?.availabilityReason,
    provider: it?.provider,
    codecs: it ? { container: it.container, video: it.video, audio: it.audio } : undefined,
    watched: it?.durationMs ? ledger.isWatched(a.itemId, it.durationMs) : false,
    segments: a.segments.map((s) => (s.kind === "program" ? { kind: s.kind, start: s.startMs, end: s.endMs, fileFrom: s.fileFromMs } : { kind: s.kind, start: s.startMs, end: s.endMs, reason: s.reason })),
  };
}

function sourcesView() {
  const c = config.get();
  const items = library.items();
  const by = (p: string) => items.filter((i) => i.provider === p);
  const summary = (p: "torbox" | "realdebrid" | "local") => {
    const list = by(p);
    const video = list.filter((i) => i.parsed.kind !== "other" && i.present);
    return {
      connected: p === "local" ? (c.localDirs ?? []).length > 0 : p === "torbox" ? !!c.torboxKey : !!c.rdToken,
      refreshedAt: library.refreshedAt()[p] ?? null,
      files: list.filter((i) => i.present).length,
      video: video.length,
      timed: video.filter((i) => i.durationMs).length,
      policyBlocked: list.filter((i) => i.availability === "policy-blocked").length,
      unavailable: list.filter((i) => i.availability === "unavailable").length,
      probeErrors: video.filter((i) => i.probe?.error && i.probe.error !== "policy").length,
    };
  };
  return {
    torbox: summary("torbox"),
    realdebrid: { ...summary("realdebrid"), packsToExpand: library.pendingPacks() },
    local: { ...summary("local"), dirs: c.localDirs ?? [] },
    scan: { ...library.scan, needed: library.needsScan(), perMinute: c.scanPerMinute ?? 30 },
    dataDir: dataDir(),
  };
}

// ---------------------------------------------------------------- media

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".ts": "video/mp2t" };

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, id: string, internal: boolean) {
  const it = itemById(id);
  if (!it || it.provider === "demo") return json(res, 404, { error: "no media for this item" });
  const label = displayTitle(it).slice(0, 60);
  const range = req.headers.range ?? "bytes=0-";

  if (it.provider === "local") {
    if (!existsSync(it.ref)) return json(res, 410, { error: "file is gone" });
    const size = statSync(it.ref).size;
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    res.writeHead(206, { "content-type": MIME[extname(it.ref).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes",
      "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
    createReadStream(it.ref, { start, end }).pipe(res);
    return;
  }

  const client = library.client(it.provider);
  if (!client) return json(res, 409, { error: `${it.provider} is not connected` });
  const ac = new AbortController();
  let finished = false;
  let opened = false;
  req.on("close", () => {
    if (!finished) {
      ac.abort();
      if (opened) meters.close(label, true);
    }
  });
  try {
    let upstream: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const grant = await library.grants.get(client, it.ref, ac.signal);
      upstream = await fetch(grant.url, { headers: { range }, signal: ac.signal });
      if (upstream.status !== 403 && upstream.status !== 404 && upstream.status !== 410) break;
      // A refused link is re-resolved exactly once (ADR-0002).
      await upstream.body?.cancel();
      library.grants.invalidate(client, it.ref);
    }
    if (!upstream || !upstream.ok || !upstream.body) {
      library.markAvailability(id, "unavailable", `Media host said ${upstream?.status}`);
      return json(res, 502, { error: `media host ${upstream?.status}` });
    }
    if (it.availability !== "playable") library.markAvailability(id, "playable");
    const headers: Record<string, string> = { "content-type": MIME[extname(it.name).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes" };
    for (const h of ["content-length", "content-range"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    opened = true;
    meters.open(`${internal ? "[compat] " : ""}${label}`);
    const body = Readable.fromWeb(upstream.body as any);
    body.on("data", (chunk: Buffer) => meters.add("playback", chunk.length));
    body.on("end", () => {
      finished = true;
      meters.close(label, false);
    });
    body.on("error", () => {});
    body.pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    if (e instanceof ProviderError && e.kind === "policy") {
      library.markAvailability(id, "policy-blocked", "The provider refused this file");
      scheduleRebuild();
      return json(res, 451, { error: "policy", message: "The provider refused this file. DebridTV won't retry it or fetch it elsewhere." });
    }
    library.markAvailability(id, "unavailable", e instanceof Error ? e.message : String(e));
    meters.log("error", `${label}: ${e instanceof Error ? e.message : e}`);
    json(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Compatibility path: ffmpeg reads through our own metered proxy, starts at the
 * live position, copies video when the browser can decode it, converts audio to
 * AAC, and emits fragmented MP4. Like real TV, this stream can't be seeked.
 */
function serveLive(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL) {
  if (!ffmpeg) return json(res, 501, { error: "ffmpeg not found" });
  const it = itemById(id);
  if (!it) return json(res, 404, { error: "unknown item" });
  const start = Math.max(0, Number(url.searchParams.get("start") ?? 0));
  const canDecode = (url.searchParams.get("v") ?? "h264").split(",");
  const copyVideo = it.video ? canDecode.includes(it.video) : false;
  const input = it.provider === "local" ? it.ref : `http://${HOST}:${PORT}/media/${id}?internal=1`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", start.toFixed(2), "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    ...(copyVideo ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-vf", "scale='min(1920,iw)':-2"]),
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
  ];
  // Copying video can only start on a keyframe, so the picture begins a little
  // before the live position. Find that keyframe (the same seek ffmpeg makes) so the
  // player can skip ahead to the exact station time.
  const tok = url.searchParams.get("tok");
  if (tok && liveStarts.has(tok)) {
    // The browser often re-requests the same stream; the keyframe is already known.
  } else if (tok && copyVideo && ffprobe) {
    const p = spawn(ffprobe, ["-v", "error", "-read_intervals", `${start.toFixed(2)}%+#1`, "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", input],
      { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.on("exit", () => {
      const k = parseFloat(out);
      liveStarts.set(tok, Number.isFinite(k) && k <= start ? k * 1000 : start * 1000);
      if (liveStarts.size > 50) liveStarts.delete(liveStarts.keys().next().value!);
    });
    setTimeout(() => p.exitCode == null && p.kill("SIGKILL"), 15_000).unref();
  } else if (tok) liveStarts.set(tok, start * 1000);
  const child: ChildProcess = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d) => (err = (err + d).slice(-2000)));
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  child.stdout!.pipe(res);
  const kill = () => {
    if (child.exitCode == null) child.kill("SIGKILL");
  };
  req.on("close", kill);
  child.on("exit", (code) => {
    if (code && code !== 255 && err) meters.log("error", `compat: ${err.split("\n").filter(Boolean).pop()}`);
    res.end();
  });
}

const liveStarts = new Map<string, number>();

function detectFfmpeg(): string | null {
  return detect([process.env.FFMPEG, "ffmpeg"]);
}
function detectFfprobe(): string | null {
  // ffprobe ships next to ffmpeg in every common Windows/macOS/Linux build.
  const sibling = ffmpeg && /ffmpeg(\.exe)?$/i.test(ffmpeg) ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe")) : null;
  return detect([process.env.FFPROBE, sibling, "ffprobe"]);
}
function detect(list: Array<string | null | undefined>): string | null {
  const candidates = list.filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"], { timeout: 4000 });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- http

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = url.pathname;
  // Same-origin only: refuse cross-site requests so a web page can't drive the TV.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) return json(res, 403, { error: "cross-origin" });
  try {
    if (p.startsWith("/api/")) return await api(req, res, url);
    const live = /^\/media\/([\w-]+)\/live$/.exec(p);
    if (live) return serveLive(req, res, live[1]!, url);
    const media = /^\/media\/([\w-]+)$/.exec(p);
    if (media) return await serveMedia(req, res, media[1]!, url.searchParams.get("internal") === "1");
    return serveStatic(res, p);
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  const m = req.method ?? "GET";
  const body = m === "POST" || m === "PUT" ? await readJson(req) : {};

  if (p === "/api/bootstrap") {
    return json(res, 200, {
      now: Date.now(),
      demo: isDemo(),
      channels: lineup().channels().map(channelView),
      ffmpeg: !!ffmpeg,
      connected: connected(),
      gates: { sharing: gates.isGranted("sharing"), cloudRelay: gates.isGranted("cloud-relay"), tunerExport: gates.isGranted("tuner-export") },
      version: "0.1.0",
    });
  }
  if (p === "/api/guide") {
    const from = Number(url.searchParams.get("from") ?? Date.now() - 30 * MIN);
    const to = Math.min(from + 12 * 60 * MIN, Number(url.searchParams.get("to") ?? from + 3 * 60 * MIN));
    const out = lineup().channels().map((c) => ({ channel: channelView(c), airings: clock.airingsBetween(c, from, to).map(airingView) }));
    return json(res, 200, { now: Date.now(), from, to, rows: out });
  }
  if (p === "/api/now") {
    const ch = lineup().channels().find((c) => c.id === url.searchParams.get("channel"));
    if (!ch) return json(res, 404, { error: "no such channel" });
    const t = Number(url.searchParams.get("at") ?? Date.now());
    const target = clock.tune(ch, t);
    meters.tunes += url.searchParams.get("count") === "1" ? 1 : 0;
    if (!target) return json(res, 200, { now: Date.now(), channel: channelView(ch), offAir: true });
    const next = clock.airingAt(ch, target.airing.endMs);
    return json(res, 200, {
      now: Date.now(),
      channel: channelView(ch),
      airing: airingView(target.airing),
      segment: target.segment.kind === "program"
        ? { kind: "program", start: target.segment.startMs, end: target.segment.endMs, fileFrom: target.segment.fileFromMs }
        : { kind: "break", start: target.segment.startMs, end: target.segment.endMs, reason: target.segment.reason },
      fileOffsetMs: target.fileOffsetMs,
      next: next ? airingView(next) : null,
    });
  }
  if (p === "/api/prefetch" && m === "POST") {
    // Resolve the playback link early (EXP-006); no media is read here.
    const it = itemById(String(body.itemId ?? ""));
    if (!it || it.provider === "demo" || it.provider === "local") return json(res, 200, { ok: true, skipped: true });
    const client = library.client(it.provider);
    if (!client) return json(res, 409, { error: "not connected" });
    try {
      await library.grants.get(client, it.ref);
      return json(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        library.markAvailability(it.id, "policy-blocked", "The provider refused this file");
        scheduleRebuild();
        return json(res, 200, { ok: false, policy: true });
      }
      return json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (p === "/api/item") {
    const it = itemById(url.searchParams.get("id") ?? "");
    if (!it) return json(res, 404, {});
    return json(res, 200, {
      id: it.id, title: displayTitle(it), provider: it.provider, container: it.container, video: it.video, audio: it.audio,
      durationMs: it.durationMs, availability: it.availability, availabilityReason: it.availabilityReason, seenMs: ledger.seenMs(it.id),
    });
  }
  if (p === "/api/watch" && m === "POST") {
    const { itemId, fromMs, toMs, channel } = body as { itemId: string; fromMs: number; toMs: number; channel: string };
    const it = itemById(itemId);
    if (!it || !(toMs > fromMs) || toMs - fromMs > 10 * MIN) return json(res, 400, { error: "bad span" });
    ledger.record(itemId, fromMs, toMs);
    historyFile.update((h) => {
      h.spans = ledger.export();
      const last = h.recent[0];
      if (!last || last.itemId !== itemId) h.recent.unshift({ at: Date.now(), itemId, channel });
      else last.at = Date.now();
      h.recent = h.recent.slice(0, 200);
    });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history") {
    const h = historyFile.get();
    return json(res, 200, {
      recent: h.recent.slice(0, 60).map((r) => {
        const it = itemById(r.itemId);
        return { ...r, title: it ? displayTitle(it) : "Removed item", seenMs: ledger.seenMs(r.itemId), durationMs: it?.durationMs ?? null,
          watched: it?.durationMs ? ledger.isWatched(r.itemId, it.durationMs) : false };
      }),
      threshold: 0.9,
    });
  }
  if (p === "/api/history/clear" && m === "POST") {
    historyFile.set({ spans: {}, recent: [] });
    for (const id of Object.keys(ledger.export())) ledger.record(id, 0, 0);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/livestart") {
    const v = liveStarts.get(url.searchParams.get("tok") ?? "");
    return v == null ? json(res, 404, { pending: true }) : json(res, 200, { startMs: v });
  }
  if (p === "/api/meters") return json(res, 200, meters.snapshot());
  if (p === "/api/sources" && m === "GET") return json(res, 200, sourcesView());
  if (p === "/api/sources" && m === "POST") {
    const { provider, key, dirs } = body as { provider: string; key?: string; dirs?: string[] };
    if (provider === "torbox" || provider === "realdebrid") {
      const k = String(key ?? "").trim();
      if (!/^[\w-]{16,128}$/.test(k)) return json(res, 400, { error: "That doesn't look like an API key." });
      config.update((c) => {
        if (provider === "torbox") c.torboxKey = k;
        else c.rdToken = k;
      }, { secret: true });
      try {
        const r = await library.refresh(provider);
        scheduleRebuild();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "auth") {
          config.update((c) => {
            if (provider === "torbox") delete c.torboxKey;
            else delete c.rdToken;
          }, { secret: true });
          return json(res, 400, { error: "The provider rejected this key. Nothing was saved." });
        }
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (provider === "local") {
      const list = (dirs ?? []).map((d) => resolve(String(d))).filter((d) => existsSync(d) && statSync(d).isDirectory());
      config.update((c) => {
        c.localDirs = list;
      });
      const n = library.refreshLocal();
      scheduleRebuild();
      return json(res, 200, { ok: true, files: n, dirs: list });
    }
    return json(res, 400, { error: "unknown provider" });
  }
  if (p === "/api/sources/disconnect" && m === "POST") {
    // Removing a provider deletes its key (gate A4). Library facts stay for history.
    const provider = String(body.provider);
    library.stopScan("Provider disconnected");
    config.update((c) => {
      if (provider === "torbox") delete c.torboxKey;
      if (provider === "realdebrid") delete c.rdToken;
      if (provider === "local") c.localDirs = [];
    }, { secret: true });
    scheduleRebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/sources/refresh" && m === "POST") {
    const provider = String(body.provider);
    try {
      const r = provider === "local" ? { files: library.refreshLocal() } : await library.refresh(provider as "torbox" | "realdebrid");
      scheduleRebuild();
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (p === "/api/scan/start" && m === "POST") {
    if (typeof body.perMinute === "number") config.update((c) => {
      c.scanPerMinute = Math.max(1, Math.min(120, body.perMinute as number));
    }, { secret: true });
    void library.runScan().then(() => scheduleRebuild());
    return json(res, 200, { ok: true });
  }
  if (p === "/api/scan/stop" && m === "POST") {
    library.stopScan();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/library") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = allItems().filter((i) => i.parsed.kind !== "other" && i.present);
    const shows = new Map<string, { key: string; name: string; episodes: number; timed: number }>();
    const movies: Array<{ id: string; title: string; year?: number; timed: boolean }> = [];
    for (const i of items) {
      if (i.parsed.kind === "episode") {
        const s = shows.get(i.parsed.showKey) ?? { key: i.parsed.showKey, name: i.parsed.show, episodes: 0, timed: 0 };
        s.episodes++;
        if (i.durationMs) s.timed++;
        shows.set(i.parsed.showKey, s);
      } else if (i.parsed.kind === "movie") movies.push({ id: i.id, title: i.parsed.title, year: i.parsed.year, timed: !!i.durationMs });
    }
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    return json(res, 200, {
      shows: [...shows.values()].filter((s) => match(s.name)).sort((a, b) => b.episodes - a.episodes),
      movies: movies.filter((x) => match(x.title)).sort((a, b) => a.title.localeCompare(b.title)),
    });
  }
  if (p === "/api/channels" && m === "GET") {
    const l = lineup();
    return json(res, 200, { channels: l.allChannels().map((c) => ({ ...channelView(c), hidden: l.hidden().includes(c.meta.ruleKey),
      items: c.revisions[c.revisions.length - 1]!.itemIds.length, ordering: c.revisions[c.revisions.length - 1]!.ordering })), custom: l.custom() });
  }
  if (p === "/api/channels/hide" && m === "POST") {
    lineup().setHidden(String(body.ruleKey), !!body.hidden);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/custom" && m === "POST") {
    const c = body as unknown as CustomChannel;
    if (!c.name || !Array.isArray(c.showKeys) || !Array.isArray(c.movieIds)) return json(res, 400, { error: "bad channel" });
    lineup().saveCustom({ id: c.id || Math.random().toString(36).slice(2, 9), name: String(c.name).slice(0, 40), showKeys: c.showKeys, movieIds: c.movieIds,
      ordering: c.ordering ?? "block-shuffle", slotMinutes: c.slotMinutes ?? 30 });
    rebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/custom/delete" && m === "POST") {
    lineup().deleteCustom(String(body.id));
    rebuild();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "no route" });
}

function serveStatic(res: http.ServerResponse, p: string) {
  const rel = p === "/" ? "index.html" : p.slice(1);
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(file));
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Keep channels in step as time passes (rules may add items as scans finish).
setInterval(scheduleRebuild, 5 * MIN).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  📺  DebridTV is on the air:  http://${HOST}:${PORT}\n`);
  console.log(`  Mode: ${isDemo() ? "demo (connect a source in Settings)" : "your library"}`);
  console.log(`  Compatibility mode (ffmpeg): ${ffmpeg ? "available" : "not found — some files may not play in the browser"}`);
  console.log(`  Data folder: ${dataDir()}\n`);
});
