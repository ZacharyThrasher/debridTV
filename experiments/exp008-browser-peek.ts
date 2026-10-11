// EXP-008 — Closing the slow-surfer gap in a real browser.
// Question: viewers who press about once a second wait ~0.8 s longer than with
// cancel-only tuning (EXP-007), because media only opens after the adaptive wait.
// Can a "peek" (open paused with preload=metadata, show the frame at the live
// point, start motion only after the wait) give them a picture as fast as
// cancel-only while keeping the bytes of adaptive-prefetch?
//
// Runs Chromium (Playwright) against a local server that behaves like a provider
// measured in LIVE-001: link request 370 ms (once per file, then cached), media
// TTFB 200 ms, 100 Mb/s link. Every media byte the server sends is counted.
//
//   node experiments/exp008-browser-peek.ts            (needs ffmpeg-made webm files)
//   MEDIA_DIR=/tmp/peek/media PRESS_MS=1000 VARIANTS=adaptive,now,peek:300
//
// Cloud/dev only: no provider is contacted.

import http from "node:http";
import { openSync, readSync, closeSync, createReadStream, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/tmp/peek/media";
const PRESS_MS = Number(process.env.PRESS_MS ?? 1000);
const API_LATENCY_MS = Number(process.env.API_LATENCY_MS ?? 370);
const MEDIA_TTFB_MS = Number(process.env.MEDIA_TTFB_MS ?? 200);
const LINK_BPS = Number(process.env.LINK_MBPS ?? 100) * 125_000;
const REST_MS = Number(process.env.REST_MS ?? 3500);
const VARIANTS = (process.env.VARIANTS ?? "adaptive,now,peek:150,peek:400").split(",");
const MB = 1_000_000;
const JITTER = Number(process.env.JITTER ?? 0);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const INDEX_CACHE = process.env.INDEX_CACHE === "1";
const HEAD_BYTES = Number(process.env.HEAD_KB ?? 2048) * 1024, TAIL_BYTES = 256 * 1024;

const files = readdirSync(MEDIA_DIR).filter((f) => f.endsWith(".webm")).sort().map((f) => join(MEDIA_DIR, f));
if (!files.length) throw new Error(`no .webm files in ${MEDIA_DIR}`);
const page = readFileSync(new URL("./exp008/page.html", import.meta.url));

// ------------------------------------------------------------ metered server
let counters = fresh();
function fresh() {
  return { apiCalls: 0, resolved: new Set<number>(), mediaRequests: 0, bytes: 0, cachedBytes: 0, perChannel: new Map<number, number>(), active: 0, peak: 0 };
}
let bucket = { tokens: 0, at: performance.now() };
async function take(n: number) {
  // Shared token bucket: all streams together get one home link.
  for (;;) {
    const t = performance.now();
    bucket.tokens = Math.min(LINK_BPS * 0.05, bucket.tokens + ((t - bucket.at) / 1000) * LINK_BPS);
    bucket.at = t;
    if (bucket.tokens >= n) return void (bucket.tokens -= n);
    await sleep(Math.max(1, ((n - bucket.tokens) / LINK_BPS) * 1000));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (url.pathname === "/api/resolve") {
    const ch = Number(url.searchParams.get("ch"));
    if (!counters.resolved.has(ch)) {
      counters.apiCalls++;
      await sleep(API_LATENCY_MS);
      counters.resolved.add(ch);
    }
    return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end("{}");
  }
  const m = /^\/m\/(\d+)\.webm$/.exec(url.pathname);
  if (!m) return res.writeHead(404).end();
  const ch = Number(m[1]);
  const file = files[ch % files.length]!;
  const size = statSync(file).size;
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "bytes=0-");
  const start = r?.[1] ? Number(r[1]) : 0;
  const end = r?.[2] ? Math.min(size - 1, Number(r[2])) : size - 1;
  counters.mediaRequests++;
  if (process.env.REQLOG) console.log("REQ", Math.round(performance.now()), ch, start, end === size - 1 ? "end" : end);
  counters.active++;
  counters.peak = Math.max(counters.peak, counters.active);
  let closed = false;
  let sent = 0;
  res.on("close", () => {
    closed = true;
    counters.active--;
  });
  // INDEX_CACHE models a proxy that keeps each file's head (EBML header, tracks,
  // seek head) and tail (cues) after the first visit or the library probe: those
  // reads come from memory with no TTFB and no provider bytes.
  // INDEX_CACHE models a proxy that keeps each file's head (EBML header, tracks,
  // seek head) and tail (cues) after the first visit or the library probe. Tail
  // reads are answered from memory. A read from the head gets the cached bytes at
  // once, then the rest from the provider after the usual TTFB (the browser
  // normally hangs up before that, once it has parsed the header).
  let from = start;
  const head = INDEX_CACHE && start < HEAD_BYTES;
  if (INDEX_CACHE && (head || start >= size - TAIL_BYTES)) {
    const stop = head ? Math.min(end, HEAD_BYTES - 1) : end;
    const buf = Buffer.alloc(stop - start + 1);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    counters.cachedBytes += buf.length;
    res.writeHead(206, { "content-type": "video/webm", "accept-ranges": "bytes", "cache-control": "no-store",
      "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
    res.write(buf);
    if (stop === end) return res.end();
    from = stop + 1;
  }
  await sleep(MEDIA_TTFB_MS);
  if (closed) return;
  if (!res.headersSent) res.writeHead(206, { "content-type": "video/webm", "accept-ranges": "bytes", "cache-control": "no-store",
    "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
  const stream = createReadStream(file, { start: from, end, highWaterMark: 64 * 1024 });
  res.on("close", () => stream.destroy());
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      await take(chunk.length);
      if (closed) break;
      counters.bytes += chunk.length;
      sent += chunk.length;
      counters.perChannel.set(ch, (counters.perChannel.get(ch) ?? 0) + chunk.length);
      if (!res.write(chunk)) await drained(res);
      if (closed) break;
    }
  } catch {
    // client went away mid-read
  }
  if (process.env.REQLOG) console.log("DONE", Math.round(performance.now()), ch, start, "sent", sent);
  if (!closed) res.end();
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// ------------------------------------------------------------ browser
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node22/lib/node_modules/playwright");
const browser = await pw.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--no-proxy-server"] });
const tab = await browser.newPage();
await tab.goto(base);

if (process.env.HOLD) { console.log(base); await sleep(1e9); }

// BURSTS surfing runs of BURST presses each, then a rest on the last channel.
// Every channel is new (cold link), so each burst's final tune pays a resolve,
// the worst case EXP-007 also used. Media files repeat (ch % files), URLs don't.
const BURSTS = Number(process.env.BURSTS ?? 6);
const BURST = Number(process.env.BURST ?? 6);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(0.9 * xs.length) - 1]! : null);

const rows = [];
for (const v of VARIANTS) {
  // "adaptive@1.0" sets the wait multiplier; "peek:400" peeks 400 ms after the press.
  const [name, k] = v.split("@");
  const [strategy, peekAfter, peekMin] = name!.split(":");
  await tab.evaluate((c: unknown) => (window as any).configure(c), { strategy, peekAfterMs: Number(peekAfter ?? 0), peekMinWaitMs: Number(peekMin ?? 0), k: Number(k ?? 1.3) });
  await sleep(500);
  counters = fresh();
  seed = 42;
  const finals: number[] = [];
  let ch = 0;
  for (let b = 0; b < BURSTS; b++) {
    for (let i = 0; i < BURST; i++) {
      await tab.evaluate((c: number) => void (window as any).press(c), ch++);
      // Human presses aren't metronomic: JITTER=0.25 spreads each gap ±25 %, seeded.
      if (i < BURST - 1) await sleep(PRESS_MS * (1 + JITTER * (2 * rand() - 1)));
    }
    finals.push(ch - 1);
    await sleep(REST_MS);
  }
  const marks = await tab.evaluate(() => (window as any).results());
  if (process.env.DEBUG) console.log(marks.slice(-3), await tab.evaluate(() => (window as any).state()));
  await tab.evaluate(() => (window as any).stopAll());
  await sleep(300);
  const fin = marks.filter((m: any) => finals.includes(m.ch));
  const pics = fin.map((m: any) => m.picture).filter((x: unknown) => x != null).map(Math.round);
  const motion = fin.map((m: any) => m.motion).filter((x: unknown) => x != null).map(Math.round);
  const surfed = [...counters.perChannel].filter(([c]) => !finals.includes(c)).reduce((a, [, b]) => a + b, 0);
  const surfedPresses = BURSTS * (BURST - 1);
  rows.push({
    variant: v,
    pressMs: PRESS_MS,
    apiCalls: counters.apiCalls,
    mediaRequests: counters.mediaRequests,
    surfedMBPerPress: +(surfed / MB / surfedPresses).toFixed(2),
    cachedMB: +(counters.cachedBytes / MB).toFixed(1),
    peakStreams: counters.peak,
    pictureMedianMs: median(pics),
    pictureP90Ms: p90(pics),
    motionMedianMs: median(motion),
    finalsWithMotion: `${motion.length}/${fin.length}`,
    surfedPictures: marks.filter((m: any) => !finals.includes(m.ch) && m.picture != null).length,
  });
  console.log(rows.at(-1));
}

await browser.close();
server.close();
const result = { experiment: "EXP-008", ranAt: new Date().toISOString(), pressMs: PRESS_MS, apiLatencyMs: API_LATENCY_MS,
  mediaTtfbMs: MEDIA_TTFB_MS, linkMbps: (LINK_BPS * 8) / MB, fileMbps: 8, jitter: JITTER, indexCache: INDEX_CACHE ? { headBytes: HEAD_BYTES, tailBytes: TAIL_BYTES } : null, bursts: BURSTS, burst: BURST, rows };
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync(`docs/experiments/results/exp008-press${PRESS_MS}${process.env.TAG ?? ""}.json`, JSON.stringify(result, null, 2) + "\n");
console.table(rows);

function drained(res: http.ServerResponse) {
  return new Promise<void>((ok) => {
    const done = () => (res.off("drain", done), res.off("close", done), ok());
    res.on("drain", done).on("close", done);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
