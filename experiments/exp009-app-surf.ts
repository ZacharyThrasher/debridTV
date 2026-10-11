// EXP-009 — Does the edge cache (ADR-0003) cut tune time in the real app?
// Runs the actual app server against the mock providers, shaped like LIVE-001's
// TorBox (link 370 ms, media TTFB 200 ms, 100 Mb/s), serving real 8 Mb/s VP9/Opus
// WebM. Chromium tunes deliberately (one channel, then rest) to each channel twice:
// the first visit has a cold edge cache, the second a warm one. Links are fetched
// up front, so both visits pay the same for the link and the difference is the cache.
//
//   MEDIA_DIR=/tmp/peek/m9 node experiments/exp009-app-surf.ts   (cloud/dev only: mocks)

import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/tmp/peek/m9";
const REST_MS = Number(process.env.REST_MS ?? 3500);
const PASSES = Number(process.env.PASSES ?? 3);
process.env.DEBRIDTV_HOME ??= mkdtempSync(join(tmpdir(), "debridtv-exp009-"));
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const blobs = readdirSync(MEDIA_DIR).filter((f) => f.endsWith(".webm")).sort().map((f) => new Uint8Array(readFileSync(join(MEDIA_DIR, f))));
const names = ["Amber", "Beacon", "Cobalt", "Delta", "Ember", "Falcon", "Granite", "Harbor"];
const files = names.map((n, i) => ({ ref: `tb:${100 + i}:1`, name: `${n} Bench (${1980 + i}).webm`, bytes: blobs[i % blobs.length]!.byteLength, content: blobs[i % blobs.length]! }));
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
  movies = ((await get("/api/library")).movies ?? []).filter((m: any) => m.title.includes("Bench"));
}
for (const m of movies) await post("/api/channels/custom", { name: `X ${m.title}`, showKeys: [], movieIds: [m.id], ordering: "cyclic", slotMinutes: 0 });
await sleep(1500);
const channels = (await get("/api/bootstrap")).channels.filter((c: any) => c.name.startsWith("X "));
if (channels.length !== files.length) throw new Error(`expected ${files.length} channels, got ${channels.length}`);
for (const m of movies) await post("/api/prefetch", { itemId: m.id });
await sleep(1000);
const before = await get("/api/meters");

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node22/lib/node_modules/playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: "guide", static: false }))})`);
const page = await ctx.newPage();
await page.goto(BASE);
await sleep(1500);
await page.keyboard.press("Escape");

/** Press the channel number; time until a decoded frame of the live point is on screen. */
async function tuneMs(n: number) {
  await page.evaluate(() => {
    const v = document.getElementById("video") as HTMLVideoElement;
    (window as any).fresh = false;
    v.addEventListener("loadstart", () => ((window as any).fresh = true), { once: true });
  });
  const t0 = Date.now();
  for (const d of String(n)) await page.keyboard.press(d);
  await page.waitForFunction(() => {
    const v = document.getElementById("video") as HTMLVideoElement;
    return (window as any).fresh && v.readyState >= 2 && !v.seeking && v.currentTime > 1;
  }, null, { timeout: 15_000, polling: 10 });
  return Date.now() - t0;
}

const rows: Array<{ pass: number; channel: number; ms: number }> = [];
for (let pass = 0; pass < PASSES; pass++)
  for (const c of channels) {
    rows.push({ pass, channel: c.number, ms: await tuneMs(c.number) });
    await sleep(REST_MS);
  }
const after = await get("/api/meters");
await browser.close();
await app.close?.();
await mock.close();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const cold = rows.filter((r) => r.pass === 0).map((r) => r.ms);
const warm = rows.filter((r) => r.pass > 0).map((r) => r.ms);
const result = {
  experiment: "EXP-009", ranAt: new Date().toISOString(), apiLatencyMs: 370, mediaTtfbMs: 200, linkMbps: 100, fileMbps: 8,
  coldMedianMs: median(cold), warmMedianMs: median(warm), cold, warm,
  bytes: { upstreamMB: +((after.bytes.playback - before.bytes.playback) / 1e6).toFixed(1), cachedMB: +(((after.bytes.cached ?? 0) - (before.bytes.cached ?? 0)) / 1e6).toFixed(1) },
  apiCalls: after.apiTotal - before.apiTotal,
};
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync("docs/experiments/results/exp009.json", JSON.stringify(result, null, 2) + "\n");
console.log(result);
process.exit(0);
