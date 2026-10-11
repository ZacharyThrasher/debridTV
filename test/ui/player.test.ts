// Browser tests for the player (workstream A): joining at station time, pause →
// live, surfing cost, and auto sign-off. Plays real (tiny, ffmpeg-made) VP9/Opus
// files from a local folder, so no provider is ever contacted.
// Skips cleanly when Playwright, its browser or ffmpeg isn't installed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

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
const PORT = 7600 + (process.pid % 200);
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
let direct: { id: string; number: number } | null = null;

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
  home = mkdtempSync(join(tmpdir(), "debridtv-player-"));
  const media = join(home, "media");
  mkdirSync(media);
  // Playwright's Chromium has no H.264, so these are VP9/Opus WebM.
  for (let i = 1; i <= 8; i++)
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=45",
      "-f", "lavfi", "-i", `sine=frequency=${300 + i * 50}:duration=45`, "-c:v", "libvpx-vp9", "-b:v", "150k", "-deadline", "realtime",
      "-cpu-used", "8", "-g", "48", "-c:a", "libopus", "-b:a", "32k", join(media, `Player Test S01E0${i}.webm`)]);
  server = spawn(process.execPath, ["app/server.ts"], { env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/bootstrap`)).ok) break;
    } catch {}
    await sleep(100);
  }
  await post("/api/sources", { provider: "local", dirs: [media] });
  await post("/api/scan/start", { perMinute: 600 });
  let lib: any = null;
  let showKey: string | undefined;
  for (let i = 0; i < 150 && !showKey; i++) {
    await sleep(200);
    lib = await get("/api/library");
    showKey = lib.shows.find((s: any) => s.name === "Player Test" && s.timed === 8)?.key;
  }
  await post("/api/channels/custom", { name: "Player Direct", showKeys: [showKey], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  for (let i = 0; i < 30 && !direct; i++) {
    await sleep(200);
    direct = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Player Direct") ?? null;
  }
  if (!direct) skip = "the test channel didn't go on air";
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function open(prefs: object = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${direct!.id}`, ...prefs }))})`);
  const page = await ctx.newPage();
  const media: string[] = [];
  const errors: string[] = [];
  page.on("request", (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/media/")) media.push(u.pathname);
  });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  return { page, ctx, media, errors };
}

const playing = (page: any, timeout = 15_000) =>
  page.waitForFunction(() => {
    const v = document.getElementById("video") as HTMLVideoElement;
    return !!v.getAttribute("src") && !v.paused && v.readyState >= 3 && v.currentTime > 0.3;
  }, null, { timeout });

/** Picture position minus station position, for the channel on screen. */
async function drift(page: any) {
  const [vt, n] = await Promise.all([
    page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime * 1000),
    get(`/api/now?channel=${direct!.id}`),
  ]);
  return { driftMs: Math.round(vt - n.fileOffsetMs), item: n.airing?.itemId };
}

describe("player", () => {
  it("joins the program at station time (A20)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, errors } = await open();
    await playing(page);
    await sleep(1000);
    const d = await drift(page);
    assert.ok(Math.abs(d.driftMs) < 1500, `drift ${d.driftMs} ms`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("resuming from pause returns to live, not where it paused (A21)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await playing(page);
    // Pause well inside a program, so a program change can't fake a pass.
    for (let i = 0; i < 60; i++) {
      const n = await get(`/api/now?channel=${direct!.id}`);
      if (n.segment?.kind === "program" && n.airing.end - n.now > 12_000) break;
      await sleep(500);
    }
    await sleep(500);
    const before = await drift(page);
    await page.keyboard.press(" ");
    await sleep(500);
    assert.ok(await page.locator("#paused").isVisible(), "paused overlay shows");
    await sleep(4000);
    await page.keyboard.press(" ");
    await playing(page);
    await sleep(800);
    const after = await drift(page);
    assert.ok(Math.abs(after.driftMs) < 1500, `back on station time (drift ${after.driftMs} ms)`);
    await ctx.close();
    void before;
  });

  it("fast surfing opens media only for the channel it lands on (A25)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, media } = await open();
    await playing(page);
    media.length = 0;
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowUp");
      await sleep(120);
    }
    await sleep(3000);
    const files = new Set(media.map((u) => u.replace(/\/live$/, "")));
    assert.ok(files.size <= 1, `media for ${files.size} files: ${[...files].join(", ")}`);
    await ctx.close();
  });

  it("slow surfing peeks at the picture before the wait ends, then plays on station time (EXP-008)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await playing(page);
    // About one press a second: the adaptive wait grows to 1.2 s, so each channel
    // gets a paused peek first.
    // Up, down, up, down: lands back on the test channel.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press(i % 2 ? "ArrowDown" : "ArrowUp");
      if (i < 3) await sleep(1000);
    }
    const seen = await page.evaluate(async () => {
      const v = document.getElementById("video") as HTMLVideoElement;
      const t0 = performance.now();
      let peek = -1;
      while (performance.now() - t0 < 4000) {
        if (peek < 0 && v.getAttribute("src") && v.paused && v.readyState >= 2) peek = performance.now() - t0;
        if (!v.paused && v.currentTime > 0.3) return { peek, playing: performance.now() - t0 };
        await new Promise((r) => setTimeout(r, 20));
      }
      return { peek, playing: -1 };
    });
    assert.ok(seen.playing > 0, "plays after the wait");
    if (seen.peek >= 0) assert.ok(seen.peek < seen.playing, `peek (${seen.peek} ms) comes before motion (${seen.playing} ms)`);
    await sleep(800);
    const d = await drift(page);
    assert.ok(Math.abs(d.driftMs) < 1500, `on station time (drift ${d.driftMs} ms)`);
    await ctx.close();
  });

  it("On Demand plays a file from any point, seeks, records its own history and returns to live at the end (N-30)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, errors } = await open();
    await playing(page);
    const itemId = (await get(`/api/now?channel=${direct!.id}`)).airing.itemId;
    const watches: any[] = [];
    page.on("request", (r: any) => new URL(r.url()).pathname === "/api/watch" && watches.push(JSON.parse(r.postData())));
    await page.evaluate(() => {
      (window as any).odEvents = [];
      addEventListener("debridtv:ondemand", (e: any) => (window as any).odEvents.push(e.detail && { ...e.detail }));
    });
    const pos = () => page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime);
    const state = () => page.evaluate(async () => {
      const p = await import(location.origin + "/js/player.js");
      return p.tv.onDemand && { itemId: p.tv.onDemand.itemId, fromMs: p.tv.onDemand.fromMs, durationMs: p.tv.onDemand.durationMs, positionMs: p.tv.onDemand.positionMs };
    });

    await page.evaluate(async (id: string) => (await import(location.origin + "/js/player.js")).playOnDemand(id, { fromMs: 30_000 }), itemId);
    await playing(page);
    const s = await state();
    assert.equal(s?.itemId, itemId);
    assert.equal(s?.fromMs, 30_000);
    assert.ok(Math.abs(s!.durationMs - 45_000) < 1000, `duration ${s?.durationMs}`);
    let at = await pos();
    assert.ok(at >= 29.8 && at < 33, `starts at 30 s, not station time (at ${at.toFixed(1)} s)`);
    await sleep(1500);

    // Left: back 10 s, in place.
    await page.evaluate(async () => (await import(location.origin + "/js/player.js")).seekBy(-10_000));
    await page.waitForFunction(() => !(document.getElementById("video") as HTMLVideoElement).seeking);
    at = await pos();
    assert.ok(at >= 21 && at < 24.5, `seeked back to about 21.5 s (at ${at.toFixed(1)} s)`);
    assert.ok(Math.abs((await state())!.positionMs - at * 1000) < 500, "positionMs follows the picture");
    await sleep(1200);

    // Near the end: it plays out, then the station is back on the air.
    await page.evaluate(async (id: string) => (await import(location.origin + "/js/player.js")).playOnDemand(id, { fromMs: 60_000 }), itemId);
    await playing(page);
    const near = await state();
    assert.equal(near?.fromMs, near!.durationMs - 5000, "a start past the end is pulled back to 5 s before it");
    await page.waitForFunction(() => (window as any).odEvents.at(-1) === null, null, { timeout: 12_000 });
    assert.equal(await state(), null);
    await playing(page);
    const d = await drift(page);
    assert.ok(Math.abs(d.driftMs) < 1500, `back on station time (drift ${d.driftMs} ms)`);

    const ev = await page.evaluate(() => (window as any).odEvents);
    assert.deepEqual(ev.map((e: any) => e && e.fromMs), [30_000, near!.fromMs, null], "start, start, end");
    // Seen time is reported as On Demand viewing, and only time actually shown.
    const od = watches.filter((w) => w.channel === "ondemand");
    assert.ok(od.length >= 2 && od.every((w) => w.itemId === itemId && w.toMs > w.fromMs), `watch spans: ${JSON.stringify(watches)}`);
    assert.ok(od.some((w) => w.fromMs >= 29_500 && w.fromMs < 31_000), "a span starts where On Demand started");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("a locked channel asks for no link and opens no media until unlocked (N-06b)", async (t) => {
    if (skip) return t.skip(skip);
    // The real server's lock: set a PIN, lock the test channel.
    const pinSet = await fetch(BASE + "/api/lock/pin", { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ pin: "2468" }) });
    if (!pinSet.ok) return t.skip("this server has no parental lock");
    try {
      const locked = await post(`/api/channels/${direct!.id}/settings`, { locked: true });
      assert.ok(locked.ok !== false, `locked the channel: ${JSON.stringify(locked)}`);
      await post("/api/lock/lock", {}); // setting the PIN leaves it entered; lock it again
      const now = await get(`/api/now?channel=${direct!.id}`);
      assert.equal(now.airing?.itemId ?? null, null, "the server redacts the airing");
      const { page, ctx } = await open();
      const costly: string[] = [];
      page.on("request", (r: any) => {
        const u = new URL(r.url()).pathname;
        if (u.startsWith("/media/") || u === "/api/prefetch" || u === "/api/item") costly.push(u);
      });
      await sleep(3000);
      assert.deepEqual(costly, [], "no link, item or media request while locked");
      assert.equal(await page.evaluate(() => document.getElementById("video")!.getAttribute("src")), null);
      assert.ok(await page.locator("#card").isVisible(), "the locked card shows");
      // Unlocking is global: the server unlocks, the PIN entry fires the event with no channel.
      const un = await post("/api/lock/unlock", { pin: "2468" });
      assert.equal(un.ok, true);
      await page.evaluate(() => dispatchEvent(new CustomEvent("debridtv:unlocked", { detail: { channelId: null } })));
      await playing(page);
      assert.ok((costly as string[]).some((u) => u.startsWith("/media/")), "plays once unlocked");
      await ctx.close();
    } finally {
      await post("/api/lock/pin", { old: "2468", pin: null });
    }
  });

  it("signs off after the idle limit, stops streaming, and comes back live on a key (N-17b)", async (t) => {
    if (skip) return t.skip(skip);
    // 4 s of no input, then a 2 s prompt.
    const { page, ctx, media } = await open({ signOffHours: 4 / 3600, signOffPromptSec: 2 });
    await playing(page);
    const bug = await page.locator("#bug").innerText();
    await page.waitForSelector("#signoff .so-ask", { timeout: 8000 });
    await page.waitForSelector("#signoff .so-off", { timeout: 5000 });
    const v = await page.evaluate(() => {
      const el = document.getElementById("video") as HTMLVideoElement;
      return { src: el.getAttribute("src"), networkState: el.networkState };
    });
    assert.equal(v.src, null, "no media source while signed off");
    media.length = 0;
    await sleep(2500);
    assert.deepEqual(media, [], "nothing is fetched while signed off");
    await page.keyboard.press("ArrowUp"); // wakes the station; must not change the channel
    assert.equal(await page.locator("#signoff").isVisible(), false);
    await playing(page);
    assert.equal(await page.locator("#bug").innerText(), bug, "same channel after waking");
    const d = await drift(page);
    assert.ok(Math.abs(d.driftMs) < 1500, `back live (drift ${d.driftMs} ms)`);
    await ctx.close();
  });

  it("a key during the prompt keeps watching without changing channel", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ signOffHours: 3 / 3600, signOffPromptSec: 30 });
    await playing(page);
    const bug = await page.locator("#bug").innerText();
    await page.waitForSelector("#signoff .so-ask", { timeout: 8000 });
    await page.keyboard.press("ArrowDown");
    await sleep(300);
    assert.equal(await page.locator("#signoff").isVisible(), false);
    assert.equal(await page.locator("#bug").innerText(), bug);
    assert.equal(await page.evaluate(() => !(document.getElementById("video") as HTMLVideoElement).paused), true, "still playing");
    await ctx.close();
  });
});
