// EXP-011 — Does readying the next show (ADR-0006) make the switch at a program
// boundary feel instant? Runs the actual app server against the mock TorBox shaped
// like LIVE-001 (link 370 ms, media TTFB 200 ms, 100 Mb/s) serving 6 Mb/s VP9/Opus
// WebM episodes of 40 s, back to back on one channel. Chromium sits on the channel
// and we time each program boundary: the next program's start on the station clock
// to the first decoded frame of its file. Run once with the pre-load off and once on;
// each run has a fresh data dir, so the edge cache and links start cold.
//
//   MEDIA_DIR=/tmp/exp011/m PRELOAD=0 node experiments/exp011-next-show.ts   (cloud/dev only: mocks)
//   MEDIA_DIR=/tmp/exp011/m PRELOAD=1 node experiments/exp011-next-show.ts

import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/tmp/exp011/m";
const PRELOAD = process.env.PRELOAD !== "0";
const BOUNDARIES = Number(process.env.BOUNDARIES ?? 6);
process.env.DEBRIDTV_HOME ??= mkdtempSync(join(tmpdir(), "debridtv-exp011-"));
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const blobs = readdirSync(MEDIA_DIR).filter((f) => f.endsWith(".webm")).sort().map((f) => new Uint8Array(readFileSync(join(MEDIA_DIR, f))));
const names = ["Amber", "Beacon", "Cobalt", "Delta", "Ember", "Falcon", "Granite", "Harbor"];
const files = names.map((n, i) => ({ ref: `tb:${100 + i}:1`, name: `${n} Relay (${1980 + i}).webm`, bytes: blobs[i % blobs.length]!.byteLength, content: blobs[i % blobs.length]! }));
const TB = "mock-torbox-key-0000000000";
const mock = await startMockProviders({ files, apiLatencyMs: 370, mediaTtfbMs: 200, linkBytesPerSec: 12_500_000,
  account: { token: [TB], premiumUntilMs: Date.now() + 30 * 86400_000, plan: "2" } });
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb` }, ffmpeg: false, timers: false });
const port = await app.listen();
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (p: string) => (await fetch(BASE + p)).json();
const post = async (p: string, b: unknown) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(b) })).json();

await post("/api/sources", { provider: "torbox", key: TB });
await post("/api/scan/start", { perMinute: 120 });
let movies: any[] = [];
for (let i = 0; i < 200 && movies.filter((m) => m.timed).length < files.length; i++) {
  await sleep(250);
  movies = ((await get("/api/library")).movies ?? []).filter((m: any) => m.title.includes("Relay"));
}
await post("/api/channels/custom", { name: "Relay", showKeys: [], movieIds: movies.map((m) => m.id), ordering: "cyclic", slotMinutes: 0 });
await sleep(1500);
const ch = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Relay");
if (!ch) throw new Error("no Relay channel");

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node22/lib/node_modules/playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${ch.id}`, static: false, preloadNext: PRELOAD, signOffHours: 0 }))})`);
// First presented frame of each file, by item id.
await ctx.addInitScript(`
  window.__frames = {};
  addEventListener("DOMContentLoaded", () => {
    const v = document.getElementById("video");
    v.addEventListener("loadstart", () => {
      const src = v.getAttribute("src") || "";
      const m = /\\/media\\/([\\w-]+)/.exec(src);
      if (!m) return;
      v.requestVideoFrameCallback(() => { if (v.getAttribute("src") === src && !window.__frames[m[1]]) window.__frames[m[1]] = Date.now(); });
    });
  });`);
const page = await ctx.newPage();
await page.goto(BASE);
await sleep(3000);
const before = await get("/api/meters");

const rows: Array<{ itemId: string; startAt: number; frameMs: number | null }> = [];
for (let i = 0; i < BOUNDARIES; i++) {
  const now = await get(`/api/now?channel=${ch.id}`);
  const next = now.next;
  const start = next.segments.find((s: any) => s.kind === "program")?.start ?? next.start;
  const deadline = start + 15_000;
  let frameAt: number | null = null;
  while (Date.now() < deadline && frameAt == null) {
    await sleep(100);
    frameAt = await page.evaluate((id: string) => (window as any).__frames[id] ?? null, next.itemId);
  }
  rows.push({ itemId: next.itemId, startAt: start, frameMs: frameAt == null ? null : frameAt - start });
  console.log(`boundary ${i + 1}: ${frameAt == null ? "no frame" : `${frameAt - start} ms`}`);
}
const after = await get("/api/meters");
await browser.close();
await app.close?.();
await mock.close();

const ms = rows.map((r) => r.frameMs).filter((x): x is number => x != null);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const result = {
  experiment: "EXP-011", ranAt: new Date().toISOString(), preload: PRELOAD, apiLatencyMs: 370, mediaTtfbMs: 200, linkMbps: 100, fileMbps: 6, programSec: 40,
  medianMs: median(ms), min: Math.min(...ms), max: Math.max(...ms), boundaries: rows,
  apiCalls: after.apiTotal - before.apiTotal,
  bytesMB: {
    playback: +((after.bytes.playback - before.bytes.playback) / 1e6).toFixed(2),
    preload: +(((after.bytes.preload ?? 0) - (before.bytes.preload ?? 0)) / 1e6).toFixed(2),
    cached: +(((after.bytes.cached ?? 0) - (before.bytes.cached ?? 0)) / 1e6).toFixed(2),
  },
  preloadStats: after.preload,
};
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync(`docs/experiments/results/exp011-preload-${PRELOAD ? "on" : "off"}.json`, JSON.stringify(result, null, 2) + "\n");
console.log(result);
process.exit(0);
