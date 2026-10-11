// DebridTV local server. Runs on the viewer's own PC and listens on 127.0.0.1 only:
// nothing here is reachable from other devices (sharing and tuner export stay
// behind their gates). Provider keys live in the local data folder and never reach
// the browser. Media is proxied so every byte and every cancellation is measured.
//
//   node app/server.ts            then open http://127.0.0.1:7337
//
// `createApp()` builds the whole thing without listening, so tests can run it
// against the mock providers on a spare port.

import http from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { StationClock } from "../src/clock/schedule.ts";
import type { Airing } from "../src/clock/types.ts";
import { WatchLedger } from "../src/history/watched.ts";
import { ProviderError } from "../src/providers/types.ts";
import { Gates } from "../src/gates.ts";
import { JsonFile, dataDir } from "./store.ts";
import { validTimeZone } from "../src/clock/dayparts.ts";
import { parseVttBlock } from "../src/library/vtt.ts";
import { RATINGS, normalizeRating, ratingRank } from "../src/clock/ratings.ts";
import { Library, displayTitle, effectiveRating, fileStatus, plainError, PROVIDER_NAMES, STATUS_ORDER, type Config, type LibItem, type ProviderBases, type RemoteProvider } from "./library.ts";
import { Lineup, autoRules, cleanLogo, cleanRestricted, cleanSlots, type StationChannel, type CustomChannel } from "./lineup.ts";
import { Meters } from "./meters.ts";
import { ORDERINGS } from "../src/clock/ordering.ts";
import { demoItems } from "./demo.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const HOST = "127.0.0.1";
const MIN = 60_000;
const VERSION = "0.2.0";

export interface AppOptions {
  /** 0 picks a free port (tests). Default 7337 or $PORT. */
  port?: number;
  /** Provider API bases; tests point these at the mock providers. */
  bases?: Partial<ProviderBases>;
  /** Look for ffmpeg (slow-ish); tests turn it off. */
  ffmpeg?: boolean;
  /** Background timers (periodic lineup refresh). */
  timers?: boolean;
}

interface HistoryState {
  spans: Record<string, Array<[number, number]>>;
  recent: Array<{ at: number; itemId: string; channel: string }>;
  /** Marks the viewer set by hand; they win over measured viewing. */
  manual?: Record<string, "watched" | "unwatched">;
}

export function createApp(opts: AppOptions = {}) {
let port = opts.port ?? Number(process.env.PORT ?? 7337);

// ---------------------------------------------------------------- state

const config = new JsonFile<Config>("config.json", () => ({}));
const historyFile = new JsonFile<HistoryState>("history.json", () => ({ spans: {}, recent: [], manual: {} }));
const meters = new Meters();
const gates = new Gates(); // Nothing is granted; no code path here asks for a gate.
const library = new Library(() => config.get(), meters, () => scheduleRebuild(), opts.bases);
const liveLineup = new Lineup("lineup.json");
const demoLineup = new Lineup("lineup-demo.json");
const demo = demoItems();
let ledger = WatchLedger.import(historyFile.get().spans);
const ffmpeg = opts.ffmpeg === false ? null : detectFfmpeg();
const ffprobe = ffmpeg ? detectFfprobe(ffmpeg) : null;

function connected() {
  const c = config.get();
  return { torbox: !!c.torboxKey, realdebrid: !!c.rdToken, local: (c.localDirs ?? []).length > 0 };
}
function isConnected(provider: string): boolean {
  const c = connected();
  return provider === "torbox" ? c.torbox : provider === "realdebrid" ? c.realdebrid : provider === "local" ? c.local : false;
}
/** Library items from sources that are still connected. A disconnected source leaves the air. */
function liveLibrary(): LibItem[] {
  return library.items().filter((i) => isConnected(i.provider));
}
function isWatched(id: string, durationMs: number | null | undefined): boolean {
  const m = historyFile.get().manual?.[id];
  if (m) return m === "watched";
  return durationMs ? ledger.isWatched(id, durationMs) : false;
}

function isDemo(): boolean {
  const c = connected();
  if (process.env.DEBRIDTV_DEMO === "1") return true;
  if (!(c.torbox || c.realdebrid || c.local)) return true;
  // Connected but nothing playable yet: keep the demo on air until the first channel exists.
  return liveLineup.channels().length === 0;
}

function allItems(): LibItem[] {
  return isDemo() ? demo : liveLibrary();
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
  const liveItems = liveLibrary();
  const ids = new Set(liveItems.map((i) => i.id));
  const liveClock = new StationClock(library.mediaItems().filter((m) => ids.has(m.id)));
  const timeZone = stationTimeZone();
  liveLineup.sync(liveClock, autoRules(liveItems, liveLineup.custom()), now, { timeZone });
  const demoClock = new StationClock(demoMedia());
  demoLineup.sync(demoClock, autoRules(demo, demoLineup.custom()), now, { timeZone });
  clock = isDemo() ? demoClock : liveClock;
}
/** Restricted hours and time slots follow this zone: $DEBRIDTV_TZ, else this computer's. */
function stationTimeZone(): string {
  const env = process.env.DEBRIDTV_TZ;
  return env && validTimeZone(env) ? env : Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function demoMedia() {
  const manual = library.manualRatings();
  return demo.map((i) => ({
    rating: effectiveRating(i, manual)?.rating,
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
  const st = lineup().settingsFor(c.meta.ruleKey);
  const hue = st.logo && "hue" in st.logo && st.logo.hue != null ? st.logo.hue : c.meta.hue;
  return { id: c.id, number: c.number, name: c.name, hue, kind: c.meta.kind, tagline: c.meta.tagline, ruleKey: c.meta.ruleKey,
    favorite: !!st.favorite, logo: st.logo ?? null, kid: !!st.kid };
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
    subtitle: it?.subtitle ?? (p?.kind === "episode" ? it?.meta?.title : undefined),
    genre: it?.genre ?? it?.meta?.genres?.[0],
    rating: it ? (effectiveRating(it, library.manualRatings())?.rating ?? null) : null,
    description: it?.meta?.plot,
    kind: p?.kind,
    durationMs: it?.durationMs ?? null,
    ...availabilityView(it),
    provider: it?.provider,
    codecs: it ? { container: it.container, video: it.video, audio: it.audio } : undefined,
    watched: isWatched(a.itemId, it?.durationMs),
    segments: a.segments.map((s) => (s.kind === "program" ? { kind: s.kind, start: s.startMs, end: s.endMs, fileFrom: s.fileFromMs } : { kind: s.kind, start: s.startMs, end: s.endMs, reason: s.reason })),
  };
}

/**
 * Availability as the player and guide see it. The stored value is what the media
 * host last said; an account that is no longer paid up or a file that left the
 * library overrides it with its own distinct reason (gate D5).
 */
/**
 * How much of a channel's lineup has a known age rating, so the editor can say
 * what a kid flag or restricted hours will actually leave on the air.
 */
function ratingCoverage(c: StationChannel) {
  const manual = library.manualRatings();
  const ids = c.revisions[c.revisions.length - 1]!.itemIds;
  const counts: Record<string, number> = Object.fromEntries([...RATINGS, "unrated"].map((r) => [r, 0]));
  for (const id of ids) {
    const it = itemById(id);
    const r = it ? effectiveRating(it, manual)?.rating : undefined;
    counts[r ?? "unrated"]!++;
  }
  const kidOk = ids.filter((id) => { const it = itemById(id); return it && ratingRank(effectiveRating(it, manual)?.rating) <= RATINGS.indexOf("PG"); }).length;
  return { total: ids.length, byRating: counts, unrated: counts.unrated!, kidSafe: kidOk };
}

/** How many season-0 specials this channel's rule could air (shown or not). */
function specialsOf(c: StationChannel): number {
  const rule = autoRules(allItems(), lineup().custom()).find((r) => r.key === c.meta.ruleKey);
  return rule?.specialIds?.length ?? 0;
}

function availabilityView(it: LibItem | undefined) {
  if (!it) return { availability: "unknown", availabilityReason: undefined };
  if (it.provider === "demo") return { availability: it.availability, availabilityReason: it.availabilityReason };
  const st = fileStatus(it, accountOf(it.provider));
  if (st.status === "account" || st.status === "gone" || st.status === "not-ready")
    return { availability: "unavailable", availabilityReason: st.message.replace(/\.$/, "") };
  return { availability: it.availability ?? "unknown", availabilityReason: it.availabilityReason };
}
function accountOf(provider: string) {
  return provider === "torbox" || provider === "realdebrid" ? library.account(provider) : undefined;
}

function sourcesView() {
  const c = config.get();
  const items = library.items();
  const by = (p: string) => items.filter((i) => i.provider === p);
  const summary = (p: "torbox" | "realdebrid" | "local") => {
    const list = by(p);
    const account = p === "local" ? undefined : library.account(p);
    const counts = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0])) as Record<string, number>;
    for (const i of list) counts[fileStatus(i, account).status]!++;
    const video = list.filter((i) => i.parsed.kind !== "other" && i.present);
    return {
      connected: isConnected(p),
      refreshedAt: library.refreshedAt()[p] ?? null,
      files: list.filter((i) => i.present).length,
      video: video.length,
      timed: video.filter((i) => i.durationMs).length,
      policyBlocked: counts.refused!,
      unavailable: counts.problem! + counts.account!,
      probeErrors: 0,
      counts,
      account: account ? { plan: account.plan ?? null, premium: account.premium ?? null, premiumUntil: account.premiumUntilMs ?? null,
        checkedAt: account.checkedAtMs, error: account.error ?? null } : null,
    };
  };
  return {
    torbox: summary("torbox"),
    realdebrid: { ...summary("realdebrid"), packsToExpand: library.pendingPacks() },
    local: { ...summary("local"), dirs: c.localDirs ?? [] },
    scan: { ...library.scan, needed: library.needsScan(), perMinute: c.scanPerMinute ?? 30,
      failed: library.items().filter((i) => isConnected(i.provider) && i.present && i.durationMs == null && i.probe?.error && i.probe.error !== "policy").length },
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
  if (!client) return json(res, 409, { error: `${PROVIDER_NAMES[it.provider]} is not connected` });
  const st = fileStatus(it, accountOf(it.provider));
  if (st.status === "refused") return json(res, 451, { error: "policy", message: st.message });
  if (st.status === "account" || st.status === "gone" || st.status === "not-ready") return json(res, 409, { error: st.status, message: st.message });
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
      library.markAvailability(id, "unavailable", `The media host said ${upstream?.status}`);
      return json(res, 502, { error: `media host ${upstream?.status}` });
    }
    library.notePlayback(id, upstream.headers);
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
      library.markAvailability(id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
      scheduleRebuild();
      return json(res, 451, { error: "policy", message: `${PROVIDER_NAMES[it.provider]} refused this file. DebridTV won't retry it or fetch it elsewhere.` });
    }
    if (e instanceof ProviderError && e.kind === "auth") void library.checkAccount(it.provider as RemoteProvider).catch(() => {});
    // A rate limit is about the account, not this file: don't mark the file.
    if (!(e instanceof ProviderError && e.kind === "rate-limited")) library.markAvailability(id, "unavailable", plainError(e));
    meters.log("error", `${label}: ${plainError(e)}`);
    json(res, 502, { error: plainError(e) });
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
  // Track choice (N-18a): indexes count within their kind, as ffmpeg's 0:a:N / 0:s:N do.
  const pick = (name: string, kind: "audio" | "subtitle") => {
    const raw = url.searchParams.get(name);
    if (raw == null || raw === "") return { ok: true as const, index: null };
    const n = Number(raw);
    const known = it.tracks?.filter((t) => t.kind === kind);
    if (!Number.isInteger(n) || n < 0 || (known && known.length > 0 && n >= known.length)) return { ok: false as const, index: null };
    return { ok: true as const, index: n, track: known?.[n] };
  };
  const a = pick("a", "audio");
  const sub = pick("s", "subtitle");
  if (!a.ok || !sub.ok) return json(res, 400, { error: "No such audio or subtitle track." });
  const subCodec = sub.index != null ? (sub as { track?: { codec: string } }).track?.codec : undefined;
  const textSub = sub.index != null && (!subCodec || TEXT_SUBS.has(subCodec));
  const burn = sub.index != null && !textSub && url.searchParams.get("burn") === "1" && IMAGE_SUBS.has(subCodec ?? "");
  const copyVideo = !burn && (it.video ? canDecode.includes(it.video) : false);
  const tok = url.searchParams.get("tok");
  const subsOut = textSub && tok ? 3 : null;
  const input = it.provider === "local" ? it.ref : `http://${HOST}:${port}/media/${id}?internal=1`;
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"];
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", start.toFixed(2), "-i", input,
    ...(burn
      ? ["-filter_complex", `[0:v:0][0:s:${sub.index}]overlay=eof_action=pass,scale='min(1920,iw)':-2[v]`, "-map", "[v]", ...encode]
      : ["-map", "0:v:0", ...(copyVideo ? ["-c:v", "copy"] : [...encode, "-vf", "scale='min(1920,iw)':-2"])]),
    // An index we couldn't check against the file's track list is optional, so a wrong guess plays without sound rather than failing.
    "-map", a.index == null ? "0:a:0?" : `0:a:${a.index}${it.tracks?.length ? "" : "?"}`, "-sn", "-dn", "-map_chapters", "-1",
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    // Text subtitles ride along as a second output of the same process: no second read.
    // Shifted by the seek so cue times are file times; /api/livesubs makes them stream-relative.
    ...(subsOut ? ["-map", `0:s:${sub.index}`, "-c:s", "webvtt", "-output_ts_offset", start.toFixed(3), "-f", "webvtt", `pipe:${subsOut}`] : []),
  ];
  // Copying video can only start on a keyframe, so the picture begins a little
  // before the live position. Find that keyframe (the same seek ffmpeg makes) so the
  // player can skip ahead to the exact station time.
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
  const child: ChildProcess = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe", ...(subsOut ? ["pipe" as const] : [])] });
  if (subsOut && tok) collectSubs(tok, child.stdio[subsOut] as NodeJS.ReadableStream);
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

const TEXT_SUBS = new Set(["srt", "ass", "webvtt", "mov_text", "subrip", "ssa", "text"]);
const IMAGE_SUBS = new Set(["pgs", "vobsub", "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"]);

interface LiveCue {
  n: number;
  /** File time. */
  startMs: number;
  endMs: number;
  text: string;
}
const liveSubs = new Map<string, { cues: LiveCue[]; done: boolean; next: number }>();

/** Read ffmpeg's WebVTT output as it arrives into cues for one stream token. */
function collectSubs(tok: string, stream: NodeJS.ReadableStream) {
  // A re-request of the same stream adds only cues not seen yet, so `n` keeps counting up.
  const st = liveSubs.get(tok) ?? { cues: [], done: false, next: 1 };
  st.done = false;
  liveSubs.delete(tok);
  liveSubs.set(tok, st);
  if (liveSubs.size > 20) liveSubs.delete(liveSubs.keys().next().value!);
  const seen = new Set(st.cues.map((c) => `${c.startMs}|${c.endMs}|${c.text}`));
  let buf = "";
  const flush = (final: boolean) => {
    const blocks = buf.replace(/\r/g, "").split(/\n\n+/);
    buf = final ? "" : blocks.pop()!;
    for (const b of blocks) {
      const c = parseVttBlock(b);
      if (!c) continue;
      const key = `${c.startMs}|${c.endMs}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      st.cues.push({ n: st.next++, ...c });
      if (st.cues.length > 2000) st.cues.shift();
    }
  };
  stream.setEncoding?.("utf8");
  stream.on("data", (d: string | Buffer) => {
    buf += String(d);
    flush(false);
  });
  stream.on("end", () => {
    flush(true);
    st.done = true;
  });
  stream.on("error", () => (st.done = true));
}


const liveStarts = new Map<string, number>();

// ---------------------------------------------------------------- http

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = url.pathname;
  // Same-origin only: refuse cross-site requests so a web page can't drive the TV.
  // Host check blocks DNS-rebinding pages from reading this server as if it were theirs.
  const host = req.headers.host ?? "";
  if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "unexpected host" });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) return json(res, 403, { error: "cross-origin" });
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
      version: VERSION,
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
    const st = fileStatus(it, accountOf(it.provider)).status;
    // Never ask for a link the provider already refused, or for a file it hasn't finished.
    if (st === "refused" || st === "account" || st === "gone" || st === "not-ready") return json(res, 200, { ok: false, skipped: true, status: st });
    try {
      await library.grants.get(client, it.ref);
      return json(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        library.markAvailability(it.id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
        scheduleRebuild();
        return json(res, 200, { ok: false, policy: true });
      }
      return json(res, 200, { ok: false, error: plainError(e) });
    }
  }
  if (p === "/api/item") {
    const it = itemById(url.searchParams.get("id") ?? "");
    if (!it) return json(res, 404, {});
    return json(res, 200, {
      id: it.id, title: displayTitle(it), provider: it.provider, container: it.container, video: it.video, audio: it.audio,
      tracks: it.tracks ?? [], chaptersMs: it.chaptersMs ?? [],
      durationMs: it.durationMs, ...availabilityView(it), seenMs: ledger.seenMs(it.id), watched: isWatched(it.id, it.durationMs),
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
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 60));
    return json(res, 200, {
      recent: h.recent.slice(0, limit).map((r) => historyRow(r, h)),
      total: h.recent.length,
      threshold: 0.9,
    });
  }
  if (p === "/api/history/clear" && m === "POST") {
    historyFile.set({ spans: {}, recent: [], manual: {} });
    ledger = new WatchLedger();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/mark" && m === "POST") {
    // A hand mark is a separate, labelled fact; it never invents viewing time.
    const id = String(body.itemId ?? "");
    const mark = body.mark === "watched" || body.mark === "unwatched" ? body.mark : null;
    if (!itemById(id)) return json(res, 404, { error: "unknown item" });
    historyFile.update((h) => {
      h.manual = { ...h.manual };
      if (mark) h.manual[id] = mark;
      else delete h.manual[id];
      if (mark && !h.recent.some((r) => r.itemId === id)) h.recent.unshift({ at: Date.now(), itemId: id, channel: "" });
    });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/forget" && m === "POST") {
    const id = String(body.itemId ?? "");
    historyFile.update((h) => {
      delete h.spans[id];
      if (h.manual) delete h.manual[id];
      h.recent = h.recent.filter((r) => r.itemId !== id);
    });
    ledger = WatchLedger.import(historyFile.get().spans);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/export") {
    const h = historyFile.get();
    return download(res, "debridtv-history.json", {
      exportedAt: new Date().toISOString(), app: "DebridTV", version: VERSION, watchedThreshold: 0.9,
      note: "Viewing history only. No keys, links or account details.",
      recent: h.recent.map((r) => historyRow(r, h)), spans: h.spans, manual: h.manual ?? {},
    });
  }
  if (p === "/api/livesubs") {
    // Text subtitles for a compatibility stream, times relative to the stream's start (the /api/livestart zero).
    const tok = url.searchParams.get("tok") ?? "";
    const st = liveSubs.get(tok);
    const zero = liveStarts.get(tok);
    if (!st) return json(res, 404, { error: "no subtitles for this stream" });
    if (zero == null) return json(res, 200, { cues: [], done: false, pending: true });
    const since = Number(url.searchParams.get("since") ?? 0);
    return json(res, 200, {
      cues: st.cues.filter((c) => c.n > since).map((c) => ({ n: c.n, startMs: c.startMs - zero, endMs: c.endMs - zero, text: c.text })),
      done: st.done,
    });
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
      const previous = provider === "torbox" ? config.get().torboxKey : config.get().rdToken;
      config.update((c) => {
        if (provider === "torbox") c.torboxKey = k;
        else c.rdToken = k;
      }, { secret: true });
      if (previous !== k) library.forgetAccount(provider);
      try {
        // Two reads: the account (plan and premium end), then the library list.
        const account = await library.checkAccount(provider);
        const r = await library.refresh(provider);
        scheduleRebuild();
        return json(res, 200, { ok: true, ...r, account: { plan: account.plan ?? null, premium: account.premium ?? null, premiumUntil: account.premiumUntilMs ?? null } });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "auth") {
          config.update((c) => {
            if (provider === "torbox") delete c.torboxKey;
            else delete c.rdToken;
          }, { secret: true });
          library.forgetAccount(provider);
          return json(res, 400, { error: `${PROVIDER_NAMES[provider]} rejected this key. Nothing was saved.` });
        }
        return json(res, 502, { error: plainError(e) });
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
    if (provider === "torbox" || provider === "realdebrid") library.forgetAccount(provider);
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
    if (!isConnected(provider)) return json(res, 409, { error: "not connected" });
    try {
      if (provider === "local") {
        const files = library.refreshLocal();
        scheduleRebuild();
        return json(res, 200, { ok: true, files });
      }
      const account = await library.checkAccount(provider as RemoteProvider);
      const r = await library.refresh(provider as RemoteProvider);
      scheduleRebuild();
      return json(res, 200, { ok: true, ...r, premium: account.premium ?? null });
    } catch (e) {
      return json(res, 502, { error: plainError(e) });
    }
  }
  if (p === "/api/sources/account" && m === "POST") {
    const provider = String(body.provider);
    if ((provider !== "torbox" && provider !== "realdebrid") || !isConnected(provider)) return json(res, 409, { error: "not connected" });
    try {
      const a = await library.checkAccount(provider);
      scheduleRebuild();
      return json(res, 200, { ok: true, plan: a.plan ?? null, premium: a.premium ?? null, premiumUntil: a.premiumUntilMs ?? null, error: a.error ?? null });
    } catch (e) {
      return json(res, 400, { error: plainError(e) });
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
  if (p === "/api/scan/retry-failed" && m === "POST") {
    return json(res, 200, { ok: true, cleared: library.retryFailedProbes() });
  }
  if (p === "/api/library/files") {
    // Every file, with its state in plain words. Reads only local facts: no provider calls.
    const want = url.searchParams.get("status") ?? "";
    const prov = url.searchParams.get("provider") ?? "";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const counts = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0])) as Record<string, number>;
    const rows: Array<{ it: LibItem; status: string; message: string }> = [];
    for (const it of liveLibrary()) {
      if (prov && it.provider !== prov) continue;
      if (q && !`${displayTitle(it)} ${it.name}`.toLowerCase().includes(q)) continue;
      const st = fileStatus(it, accountOf(it.provider));
      counts[st.status]!++;
      if (!want || want === st.status) rows.push({ it, ...st });
    }
    rows.sort((a, b) => STATUS_ORDER.indexOf(a.status as never) - STATUS_ORDER.indexOf(b.status as never) || displayTitle(a.it).localeCompare(displayTitle(b.it)));
    return json(res, 200, {
      counts, total: rows.length, offset, limit,
      files: rows.slice(offset, offset + limit).map(({ it, status, message }) => ({
        id: it.id, title: displayTitle(it), name: it.name, provider: it.provider, status, message,
        kind: it.parsed.kind, durationMs: it.durationMs, bytes: it.bytes, providerState: it.providerState,
        container: it.container, video: it.video, audio: it.audio, excluded: !!it.excluded,
        checkedAt: it.availabilityAt ?? null, playableAt: it.playableAt ?? null, goneAt: it.goneAt ?? null,
        etagChanges: it.etagChanges ?? 0, watched: isWatched(it.id, it.durationMs), seenMs: ledger.seenMs(it.id),
      })),
    });
  }
  if (p === "/api/library/exclude" && m === "POST") {
    if (!library.setExcluded(String(body.id ?? ""), !!body.excluded)) return json(res, 404, { error: "unknown item" });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/library/check" && m === "POST") {
    // The viewer asked: is this one playable right now? One link request, nothing more.
    const it = library.get(String(body.id ?? ""));
    if (!it || !isConnected(it.provider)) return json(res, 404, { error: "unknown item" });
    const st = fileStatus(it, accountOf(it.provider));
    if (st.status === "refused") return json(res, 409, { error: "refused", message: st.message });
    if (st.status === "not-ready") return json(res, 409, { error: "not-ready", message: st.message });
    if (st.status === "gone") return json(res, 409, { error: "gone", message: st.message });
    if (it.provider === "local") {
      const ok = existsSync(it.ref);
      library.markAvailability(it.id, ok ? "playable" : "unavailable", ok ? undefined : "The file is gone from disk");
      return json(res, 200, { ok, message: ok ? "The file is on disk." : "The file is gone from disk." });
    }
    const client = library.client(it.provider)!;
    try {
      library.grants.invalidate(client, it.ref);
      await library.grants.get(client, it.ref);
      library.markAvailability(it.id, "playable");
      return json(res, 200, { ok: true, message: `${PROVIDER_NAMES[it.provider]} gave a playback link just now.` });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        library.markAvailability(it.id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
        scheduleRebuild();
        return json(res, 200, { ok: false, message: `${PROVIDER_NAMES[it.provider]} refused this file. DebridTV won't retry it or fetch it elsewhere.` });
      }
      if (!(e instanceof ProviderError && e.kind === "rate-limited")) library.markAvailability(it.id, "unavailable", plainError(e));
      return json(res, 200, { ok: false, message: `${plainError(e)}.` });
    }
  }
  if (p === "/api/export") {
    // Settings round trip without credentials (gate F4).
    const c = config.get();
    return download(res, "debridtv-settings.json", {
      exportedAt: new Date().toISOString(), app: "DebridTV", version: VERSION,
      note: "Settings only. API keys are never exported.",
      sources: { torbox: !!c.torboxKey, realdebrid: !!c.rdToken, localDirs: c.localDirs ?? [] },
      scanPerMinute: c.scanPerMinute ?? 30,
      lineup: liveLineup.exportSettings(),
      ratings: library.manualRatings(),
    });
  }
  if (p === "/api/import" && m === "POST") {
    const l = (body as { lineup?: unknown }).lineup;
    if (!l || typeof l !== "object") return json(res, 400, { error: "That isn't a DebridTV settings file." });
    const n = liveLineup.importSettings(l as never);
    const ratings = library.importRatings((body as { ratings?: unknown }).ratings);
    rebuild();
    return json(res, 200, { ok: true, ...n, ratings });
  }
  if (p === "/api/forget" && m === "POST") {
    // Everything DebridTV knows, gone: keys, library facts, history, channels.
    if (body.confirm !== "forget everything") return json(res, 400, { error: "confirmation missing" });
    library.stopScan("Everything was forgotten");
    config.set({}, { secret: true });
    library.clear();
    historyFile.set({ spans: {}, recent: [], manual: {} });
    ledger = new WatchLedger();
    liveLineup.reset();
    demoLineup.reset();
    rebuild();
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
  if (p === "/api/ratings" && m === "GET") {
    // Age ratings per show and film: the viewer's pick, the .nfo's, or none. Local facts only.
    const manual = library.manualRatings();
    const shows = new Map<string, { key: string; name: string; episodes: number; rating: string | null; from: string | null; nfo: string | null }>();
    const movies: Array<{ id: string; title: string; rating: string | null; from: string | null; nfo: string | null }> = [];
    for (const it of allItems()) {
      if (!it.present || it.parsed.kind === "other") continue;
      const r = effectiveRating(it, manual);
      if (it.parsed.kind === "episode") {
        const k = it.parsed.showKey;
        const s = shows.get(k) ?? { key: k, name: it.parsed.show, episodes: 0, rating: null, from: null, nfo: null };
        s.episodes++;
        const showR = manual.shows[k];
        if (showR) (s.rating = showR), (s.from = "you");
        else if (r && !s.rating) (s.rating = r.rating), (s.from = r.from);
        if (!s.nfo && it.meta?.ratingText) s.nfo = it.meta.ratingText;
        shows.set(k, s);
      } else movies.push({ id: it.id, title: displayTitle(it), rating: r?.rating ?? null, from: r?.from ?? null, nfo: it.meta?.ratingText ?? null });
    }
    return json(res, 200, { scale: RATINGS, shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)), movies: movies.sort((a, b) => a.title.localeCompare(b.title)) });
  }
  if (p === "/api/ratings" && m === "POST") {
    const b = body as { showKey?: unknown; itemId?: unknown; rating?: unknown };
    const rating = b.rating === null || b.rating === "" ? null : normalizeRating(String(b.rating ?? ""));
    if (b.rating != null && b.rating !== "" && !rating) return json(res, 400, { error: "Ratings are G, PG, PG-13, R or NC-17 (TV ratings like TV-14 are accepted too)." });
    const ok = library.setRating({ showKey: typeof b.showKey === "string" ? b.showKey : undefined, itemId: typeof b.itemId === "string" ? b.itemId : undefined }, rating);
    if (!ok) return json(res, 400, { error: "Say which show (showKey) or file (itemId)." });
    scheduleRebuild();
    return json(res, 200, { ok: true, rating });
  }
  if (p === "/api/channels" && m === "GET") {
    const l = lineup();
    return json(res, 200, { channels: l.allChannels().map((c) => ({ ...channelView(c), hidden: l.hidden().includes(c.meta.ruleKey),
      items: c.revisions[c.revisions.length - 1]!.itemIds.length, ordering: c.revisions[c.revisions.length - 1]!.ordering })), custom: l.custom() });
  }
  let settingsNote = "";
  const chSettings = /^\/api\/channels\/([\w-]+)\/settings$/.exec(p);
  if (chSettings) {
    const l = lineup();
    const ch = l.allChannels().find((c) => c.id === chSettings[1]);
    if (!ch) return json(res, 404, { error: "no such channel" });
    if (m === "PUT" || m === "POST") {
      const b = body as Record<string, unknown>;
      const logo = b.logo === null ? null : b.logo === undefined ? undefined : cleanLogo(b.logo);
      if (b.logo != null && !logo) return json(res, 400, { error: "A logo is up to 6 letters (badge or text), or an inline image (data: URL). No outside images." });
      const restrictedHours = b.restrictedHours === undefined ? undefined : cleanRestricted(b.restrictedHours);
      if (restrictedHours === null) return json(res, 400, { error: "Restricted hours need from/to as HH:MM and a rating G, PG, PG-13, R or NC-17." });
      const slots = b.slots === undefined ? undefined : cleanSlots(b.slots);
      if (slots === null) return json(res, 400, { error: "Each time slot needs days 1-7, from/to as HH:MM and a source." });
      const r = l.updateSettings(ch.meta.ruleKey, {
        name: typeof b.name === "string" || b.name === null ? (b.name as string | null) : undefined,
        number: typeof b.number === "number" ? b.number : undefined,
        favorite: typeof b.favorite === "boolean" ? b.favorite : undefined,
        logo: logo as never,
        kid: typeof b.kid === "boolean" ? b.kid : undefined,
        restrictedHours,
        slots,
        specials: typeof b.specials === "boolean" ? b.specials : undefined,
      });
      if (!r.ok) return json(res, 409, { error: r.error });
      scheduleRebuild();
      if (r.swappedWith) settingsNote = `Swapped numbers with ${r.swappedWith}.`;
    }
    const c = l.allChannels().find((x) => x.id === chSettings[1])!;
    const st = l.settingsFor(c.meta.ruleKey);
    return json(res, 200, { name: c.name, number: c.number, favorite: !!st.favorite, logo: st.logo ?? null,
      kid: !!st.kid, restrictedHours: st.restrictedHours ?? [], slots: st.slots ?? [],
      specials: !!st.specials, specialsAvailable: specialsOf(c),
      // The clock enforces all three; changes start once the program on now ends (C7).
      enforced: true, timeZone: stationTimeZone(), ratings: ratingCoverage(c),
      ...(settingsNote ? { note: settingsNote } : {}) });
  }
  if (p === "/api/channels/hide" && m === "POST") {
    lineup().setHidden(String(body.ruleKey), !!body.hidden);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/custom" && m === "POST") {
    const c = body as unknown as CustomChannel;
    if (!c.name || !Array.isArray(c.showKeys) || !Array.isArray(c.movieIds)) return json(res, 400, { error: "bad channel" });
    lineup().saveCustom({ id: c.id || Math.random().toString(36).slice(2, 9), name: String(c.name).slice(0, 40), showKeys: c.showKeys.map(String), movieIds: c.movieIds.map(String),
      ordering: ORDERINGS.includes(c.ordering) ? c.ordering : "block-shuffle", slotMinutes: typeof c.slotMinutes === "number" ? c.slotMinutes : 30 });
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

function historyRow(r: HistoryState["recent"][number], h: HistoryState) {
  const it = itemById(r.itemId);
  return { ...r, title: it ? displayTitle(it) : "Removed item", seenMs: ledger.seenMs(r.itemId), durationMs: it?.durationMs ?? null,
    watched: isWatched(r.itemId, it?.durationMs), manual: h.manual?.[r.itemId] ?? null };
}

// Keep channels in step as time passes (rules may add items as scans finish).
const tick = opts.timers === false ? null : setInterval(scheduleRebuild, 5 * MIN);
tick?.unref();

return {
  server,
  library,
  meters,
  get port() {
    return port;
  },
  listen(): Promise<number> {
    return new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        port = (server.address() as AddressInfo).port;
        resolveListen(port);
      });
    });
  },
  close(): Promise<void> {
    if (tick) clearInterval(tick);
    if (rebuildTimer) clearTimeout(rebuildTimer);
    library.stopScan("Shutting down");
    return new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  },
  isDemo,
  ffmpeg: !!ffmpeg,
};
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

function download(res: http.ServerResponse, name: string, body: unknown) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
  res.end(JSON.stringify(body, null, 1));
}

function detectFfmpeg(): string | null {
  return detect([process.env.FFMPEG, "ffmpeg"]);
}
function detectFfprobe(ffmpeg: string): string | null {
  // ffprobe ships next to ffmpeg in every common Windows/macOS/Linux build.
  const sibling = /ffmpeg(\.exe)?$/i.test(ffmpeg) ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe")) : null;
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = await app.listen();
  console.log(`\n  📺  DebridTV is on the air:  http://${HOST}:${port}\n`);
  console.log(`  Mode: ${app.isDemo() ? "demo (connect a source in Settings)" : "your library"}`);
  console.log(`  Compatibility mode (ffmpeg): ${app.ffmpeg ? "available" : "not found — some files may not play in the browser"}`);
  console.log(`  Data folder: ${dataDir()}\n`);
}
