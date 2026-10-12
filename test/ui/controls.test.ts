// Browser tests for the control bar (docs/parity/player.md): scrubbing, chapters,
// the settings menu (speed, sound, sync, picture), keyboard and remote, subtitle
// files, screenshots and frame steps. Plays small ffmpeg-made VP9/Opus files from a
// local folder, so no provider is ever contacted. Skips without Playwright or ffmpeg.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeQuietly } from "./close.ts";

const require = createRequire(import.meta.url);
let chromium: any = null;
for (const p of [process.env.PLAYWRIGHT, "playwright", "/opt/node22/lib/node_modules/playwright"]) {
  if (!p) continue;
  try {
    chromium = require(p).chromium;
    break;
  } catch {}
}
const EXE = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
const PORT = 7800 + (process.pid % 150);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ffmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = false;
}

let server: ChildProcess | null = null;
let browser: any = null;
let home = "";
let skip: string | false = !chromium ? "Playwright isn't installed" : !ffmpeg ? "ffmpeg isn't installed" : false;
let channel: { id: string } | null = null;
const CHAPTERS = [0, 20, 45, 70];

const get = async (p: string) => (await fetch(BASE + p)).json();
const post = async (p: string, body: unknown) =>
  (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) })).json();

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] }).catch(() =>
      chromium.launch({ args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] }));
  } catch (e: any) {
    skip = `no browser: ${e.message.split("\n")[0]}`;
    return;
  }
  home = mkdtempSync(join(tmpdir(), "debridtv-controls-"));
  const media = join(home, "media");
  mkdirSync(media);
  // 90 s episodes with four chapters, made once and copied: a show needs enough episodes for its own channel.
  const meta = join(home, "chapters.txt");
  writeFileSync(meta, ";FFMETADATA1\n" + CHAPTERS.map((s, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s * 1000}\nEND=${(CHAPTERS[i + 1] ?? 90) * 1000}\ntitle=Part ${i + 1}\n`).join(""));
  const first = join(media, "Bar Test S01E01.mkv");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=90", "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
    "-i", meta, "-map_metadata", "2", "-map", "0", "-map", "1", "-c:v", "libvpx-vp9", "-b:v", "120k", "-deadline", "realtime", "-cpu-used", "8", "-g", "24",
    "-c:a", "libopus", "-b:a", "32k", first]);
  for (let i = 2; i <= 8; i++) execFileSync("cp", [first, join(media, `Bar Test S01E0${i}.mkv`)]);
  server = spawn(process.execPath, ["app/server.ts"], { env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/bootstrap`)).ok) break;
    } catch {}
    await sleep(100);
  }
  await post("/api/sources", { provider: "local", dirs: [media] });
  await post("/api/scan/start", { perMinute: 600 });
  for (let i = 0; i < 150 && !channel; i++) {
    await sleep(200);
    channel = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Bar Test") ?? null;
  }
  if (!channel) skip = "the test channel didn't go on air";
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function open(prefs: object = {}, viewport = { width: 1280, height: 720 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${channel!.id}`, ...prefs }))})`);
  const page = await ctx.newPage();
  const media: string[] = [];
  const errors: string[] = [];
  page.on("request", (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/media/")) media.push(u.pathname + u.search);
  });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.waitForFunction(() => {
    const v = document.getElementById("video") as HTMLVideoElement;
    return !!v.getAttribute("src") && !v.paused && v.readyState >= 3 && v.currentTime > 0.2;
  }, null, { timeout: 20_000 });
  return { page, ctx, media, errors };
}

const timeline = (page: any) => page.evaluate(async () => (await import("/js/player.js")).timeline());
const showBar = async (page: any) => {
  await page.mouse.move(100, 200);
  await page.mouse.move(120, 210);
  await page.waitForFunction(() => document.body.classList.contains("pbar-on"));
};

describe("control bar", () => {
  it("shows on pointer movement with time and chapter marks, and fades when the pointer rests", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, errors } = await open();
    await showBar(page);
    await page.waitForFunction(() => document.querySelectorAll(".pb-chaps b").length === 3, null, { timeout: 5000 });
    assert.match(await page.textContent(".pb-time"), /\d+:\d\d \/ 1:30/);
    assert.equal(await page.isVisible('[data-act="live"]'), true);
    await page.waitForFunction(() => !document.body.classList.contains("pbar-on"), null, { timeout: 6000 });
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("scrubbing seeks in the program (a time shift), shows the chapter on hover, and fetches nothing for the hover", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, media } = await open();
    await showBar(page);
    const box = await page.locator(".pb-scrub").boundingBox();
    const before = media.length;
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForSelector(".pb-tip:not([hidden])");
    assert.match(await page.textContent(".pb-tip"), /0:54Chapter 3/);
    assert.equal(media.length, before, "hovering the scrubber opens no media");
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForFunction(async () => {
      const t = (await import("/js/player.js")).timeline();
      return t && Math.abs(t.posMs - 54_000) < 2500;
    }, null, { timeout: 8000 });
    const tl = await timeline(page);
    assert.ok(tl.mode === "shifted" || tl.mode === "live", tl.mode);
    await closeQuietly(ctx);
  });

  it("Shift+Right goes to the next chapter", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await showBar(page);
    await page.waitForFunction(() => document.querySelectorAll(".pb-chaps b").length === 3);
    const from = (await timeline(page)).posMs;
    const next = [20_000, 45_000, 70_000].find((c) => c > from + 1000);
    if (next == null) return void (await closeQuietly(ctx)); // already in the last chapter
    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForFunction(async (n: number) => {
      const t = (await import("/js/player.js")).timeline();
      return t && Math.abs(t.posMs - n) < 2500;
    }, next, { timeout: 8000 });
    await closeQuietly(ctx);
  });

  it("menu: speed waits for a time shift, then plays faster; volume boosts above 100%; night mode stays on", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await showBar(page);
    await page.click('[data-act="menu"]');
    await page.click('[data-m="page:speed"]');
    assert.equal(await page.locator('[data-m^="rate:"]').count(), 0, "live plays at normal speed");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowLeft"); // skip back 10 s: now behind live
    await page.waitForFunction(async () => (await import("/js/player.js")).timeShift() < 0);
    await page.waitForFunction(() => !(document.getElementById("video") as HTMLVideoElement).paused && (document.getElementById("video") as HTMLVideoElement).readyState >= 3);
    await showBar(page);
    await page.click('[data-act="menu"]');
    await page.click('[data-m="page:speed"]');
    await page.click('[data-m="rate:1.5"]');
    assert.equal(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).playbackRate), 1.5);
    await page.click('[data-m="page:sound"]');
    for (let i = 0; i < 4; i++) await page.click('[data-m="vol:+"]');
    await page.click('[data-m="night"]');
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs")!));
    assert.equal(prefs.volume, 1);
    assert.ok(prefs.boost > 1 && prefs.boost <= 1.15, String(prefs.boost));
    assert.equal(prefs.nightMode, true);
    assert.equal(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).volume), 1);
    // Back to live is normal speed again.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("l");
    await page.waitForFunction(async () => (await import("/js/player.js")).timeShift() === 0);
    await page.waitForFunction(() => (document.getElementById("video") as HTMLVideoElement).playbackRate !== 1.5, null, { timeout: 8000 });
    await closeQuietly(ctx);
  });

  it("sound earlier than the picture moves the program to the PC's stream with &ad=; later stays in the browser", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, media } = await open({ audioDelayMs: 300 });
    assert.ok(!media.some((m) => m.includes("/live")), "a later sound is a browser delay: direct play");
    await showBar(page);
    await page.click('[data-act="menu"]');
    await page.click('[data-m="page:async"]');
    for (let i = 0; i < 10; i++) await page.click('[data-m="ad:-"]'); // 300 → −200
    assert.match(await page.textContent(".pm-step output"), /−?-200 ms/);
    await page.waitForFunction(() => /\/live\?.*&ad=-200/.test(document.getElementById("video")!.getAttribute("src") ?? ""), null, { timeout: 8000 });
    await closeQuietly(ctx);
  });

  it("a subtitle file from this device shows on the picture, and subtitle sync moves it", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    const at = Math.floor((await timeline(page)).posMs / 1000);
    const ts = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},000`;
    const srt = `1\n${ts(at)} --> ${ts(at + 30)}\nHello from a file\n`;
    await page.setInputFiles(".pb-file", { name: "mine.srt", mimeType: "application/x-subrip", buffer: Buffer.from(srt) });
    await page.waitForFunction(() => [...(document.getElementById("video") as HTMLVideoElement).textTracks].some((t) => t.label === "Your file" && t.cues?.length === 1));
    const cueStart = () => page.evaluate(() => [...(document.getElementById("video") as HTMLVideoElement).textTracks].find((t) => t.label === "Your file")!.cues![0]!.startTime);
    const before = await cueStart();
    await showBar(page);
    await page.click('[data-act="menu"]');
    await page.click('[data-m="page:ssync"]');
    for (let i = 0; i < 5; i++) await page.click('[data-m="sd:+"]');
    assert.ok(Math.abs((await cueStart()) - before - 0.5) < 0.01, "half a second later");
    await closeQuietly(ctx);
  });

  it("keys: ? opens the shortcut sheet, , and . step frames while paused, X saves a screenshot", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await page.keyboard.press("?");
    assert.equal(await page.isVisible(".pkeys"), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible(".pkeys"), false);
    await page.keyboard.press(" ");
    await page.waitForFunction(() => (document.getElementById("video") as HTMLVideoElement).paused);
    await sleep(300);
    const t0 = await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime);
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await page.waitForFunction((a: number) => (document.getElementById("video") as HTMLVideoElement).currentTime > a + 0.05, t0);
    const t1 = await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime);
    assert.ok(t1 - t0 < 0.2, `two frames, not a jump: ${t1 - t0}`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("x")]);
    assert.match(dl.suggestedFilename(), /^Bar Test.*\.png$/);
    await closeQuietly(ctx);
  });

  it("remote: Down after Left/Right reaches the bar, Left/Right move along it, Back leaves without changing channel", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ tv: "on" });
    const ch = await page.evaluate(async () => (await import("/js/player.js")).tv.current.id);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.act), "play");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.act), "prev");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.body.classList.contains("pbar-on")), false);
    assert.equal(await page.evaluate(async () => (await import("/js/player.js")).tv.current.id), ch, "still the same channel");
    await closeQuietly(ctx);
  });

  it("fits a phone: one row, nothing past the edge", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({}, { width: 390, height: 844 });
    await showBar(page);
    const over = await page.evaluate(() => [...document.querySelectorAll(".pbar button")].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
    }).map((b) => (b as HTMLElement).dataset.act));
    assert.deepEqual(over, []);
    await closeQuietly(ctx);
  });
});
