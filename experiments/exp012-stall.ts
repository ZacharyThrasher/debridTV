// EXP-012 — How far ahead does the player already hold the show it's playing, and
// what does a mid-show provider stall do to it? Runs the app server against the mock
// TorBox (LIVE-001 shape: link 370 ms, media TTFB 200 ms, 100 Mb/s) serving one 5-minute
// 6 Mb/s VP9/Opus WebM on its own channel. Chromium plays it for WARM_S seconds while we
// sample the forward buffer (buffered end minus play position), then the mock host sends
// nothing for STALL_MS, and we record how long the picture froze.
//
//   MEDIA_DIR=/tmp/exp012/m STALL_MS=20000 LABEL=before node experiments/exp012-stall.ts   (cloud/dev only: mocks)

import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/tmp/exp012/m";
const WARM_S = Number(process.env.WARM_S ?? 60);
const STALL_MS = Number(process.env.STALL_MS ?? 20_000);
const AFTER_S = Number(process.env.AFTER_S ?? 30);
const LABEL = process.env.LABEL ?? "run";
process.env.DEBRIDTV_HOME ??= mkdtempSync(join(tmpdir(), "debridtv-exp012-"));
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const file = readdirSync(MEDIA_DIR).find((f) => f.endsWith(".webm"))!;
const content = new Uint8Array(readFileSync(join(MEDIA_DIR, file)));
const TB = "mock-torbox-key-0000000000";
const mock = await startMockProviders({ // Extra copies under other names only make the app leave demo mode (it needs a first real lineup).
  files: ["Stall Test", "Spare One", "Spare Two", "Spare Three", "Spare Four", "Spare Five"].map((n, i) => ({ ref: `tb:${500 + i}:1`, name: `${n} (${1990 + i}).webm`, bytes: content.byteLength, content })),
  apiLatencyMs: 370, mediaTtfbMs: 200, linkBytesPerSec: 12_500_000, account: { token: [TB], premiumUntilMs: Date.now() + 30 * 86400_000, plan: "2" } });
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb` }, ffmpeg: false, timers: false });
const port = await app.listen();
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => (await fetch(BASE + p)).json();
const post = async (p: string, b: unknown) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(b) })).json();

await post("/api/sources", { provider: "torbox", key: TB });
await post("/api/scan/start", { perMinute: 120 });
let movie: any = null;
for (let i = 0; i < 200 && !movie?.durationMs; i++) {
  await sleep(250);
  movie = ((await get("/api/library/files")).files ?? []).find((f: any) => f.name.includes("Stall"));
}
for (let i = 0; i < 120 && (await get("/api/bootstrap")).demo; i++) await sleep(500);
await post("/api/channels/custom", { name: "Stall", showKeys: [], movieIds: [movie.id], ordering: "cyclic", slotMinutes: 0 });
let ch: any = null;
for (let i = 0; i < 60 && !ch; i++) {
  await sleep(500);
  ch = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Stall");
}
if (!ch) throw new Error("no Stall channel");

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node22/lib/node_modules/playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${ch.id}`, static: false, signOffHours: 0 }))})`);
// Start early in the file so the stall lands mid-show (the station clock decides where it is).
for (let i = 0; i < 700; i++) {
  const n = await get(`/api/now?channel=${ch.id}`);
  if (n.fileOffsetMs != null && n.fileOffsetMs < 120_000) break;
  await sleep(1000);
}
const page = await ctx.newPage();
const openedAt = Date.now();
await page.goto(BASE);
await page.waitForFunction(() => (document.getElementById("video") as HTMLVideoElement).currentTime > 1, null, { timeout: 20_000 });

const sample = () => page.evaluate(() => {
  const v = document.getElementById("video") as HTMLVideoElement;
  const b = v.buffered;
  let ahead = 0;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.1 && b.end(i) > v.currentTime) ahead = b.end(i) - v.currentTime;
  return { t: v.currentTime, ahead, ready: v.readyState, paused: v.paused };
});
const warm: number[] = [];
for (let s = 0; s < WARM_S; s++) {
  await sleep(1000);
  warm.push(+(await sample()).ahead.toFixed(1));
}
const m0 = await get("/api/meters");
// Seconds of the file fetched past the play position: everything pulled so far, minus where playback is.
const durS = movie.durationMs / 1000;
const fetchedS = (m: any) => ((m.bytes.playback + (m.bytes.cached ?? 0)) / content.byteLength) * durS;
const s0 = await sample();
const tuneAt = s0.t - (Date.now() - openedAt) / 1000;
const netAheadS = +(tuneAt + fetchedS(m0) - s0.t).toFixed(1);
const stallAt = Date.now();
mock.stallMedia(STALL_MS);
let frozenMs = 0;
let firstFreezeAt: number | null = null;
let last = await sample();
const during: number[] = [];
const end = stallAt + STALL_MS + AFTER_S * 1000;
while (Date.now() < end) {
  await sleep(250);
  const s = await sample();
  if (s.t - last.t < 0.05 && !s.paused) {
    frozenMs += 250;
    firstFreezeAt ??= Date.now() - stallAt;
  }
  if (during.length < (Date.now() - stallAt) / 1000) during.push(+s.ahead.toFixed(1));
  if (process.env.DEBUG) console.log(Date.now() - stallAt, s, mock.counters.mediaBytes);
  last = s;
}
const m1 = await get("/api/meters");
await browser.close();
await app.close?.();
await mock.close();

const result = {
  experiment: "EXP-012", label: LABEL, ranAt: new Date().toISOString(), fileMbps: 6, stallMs: STALL_MS,
  aheadWhilePlayingS: { min: Math.min(...warm.slice(10)), median: [...warm.slice(10)].sort((a, b) => a - b)[Math.floor((warm.length - 10) / 2)], last: warm.at(-1) },
  warm, during,
  netAheadAtStallS: netAheadS, frozenMs, firstFreezeAfterStallMs: firstFreezeAt,
  readAhead: m1.readAhead ?? null, mediaRequests: mock.counters.mediaRequests,
  playbackMBDuringStallWindow: +((m1.bytes.playback - m0.bytes.playback) / 1e6).toFixed(1),
};
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync(`docs/experiments/results/exp012-${LABEL}-stall${STALL_MS / 1000}s.json`, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ label: LABEL, ahead: result.aheadWhilePlayingS, netAheadS, readAhead: m1.readAhead, reqs: mock.counters.mediaRequests, frozenMs, firstFreezeAt, during }, null, 0));
process.exit(0);
