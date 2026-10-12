// Browser tests for the Lean-back pack: Skip intro / Skip credits from chapter titles,
// Next episode, the sleep timer and Remind me / Tune me. Plays small ffmpeg-made
// VP9/Opus files from a local folder, so no provider is ever contacted. Skips without
// Playwright or ffmpeg.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeQuietly } from "./close.ts";
import { startServer } from "./serve.ts";

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
let BASE = "";
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
let channel: { id: string; name: string } | null = null;
let other: { id: string; name: string } | null = null;
let eps: Array<{ id: string; label: string }> = [];
// 60 s episodes: Intro 0–10 s, Part 1 10–40 s, Credits 40–60 s.
const CHAPTERS: Array<[number, string]> = [[0, "Intro"], [10, "Part 1"], [40, "Credits"]];

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
  home = mkdtempSync(join(tmpdir(), "debridtv-leanback-"));
  const media = join(home, "media");
  mkdirSync(media);
  const meta = join(home, "chapters.txt");
  writeFileSync(meta, ";FFMETADATA1\n" + CHAPTERS.map(([s, title], i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s * 1000}\nEND=${(CHAPTERS[i + 1]?.[0] ?? 60) * 1000}\ntitle=${title}\n`).join(""));
  const first = join(media, "Lean Test S01E01.mkv");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=60", "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-i", meta, "-map_metadata", "2", "-map", "0", "-map", "1", "-c:v", "libvpx-vp9", "-b:v", "120k", "-deadline", "realtime", "-cpu-used", "8", "-g", "24",
    "-c:a", "libopus", "-b:a", "32k", first]);
  for (let i = 2; i <= 8; i++) execFileSync("cp", [first, join(media, `Lean Test S01E0${i}.mkv`)]);
  ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home }));
  await post("/api/sources", { provider: "local", dirs: [media] });
  await post("/api/scan/start", { perMinute: 600 });
  for (let i = 0; i < 150 && !(channel && other); i++) {
    await sleep(200);
    const chs = (await get("/api/bootstrap")).channels;
    channel = chs.find((c: any) => c.name === "Lean Test") ?? null;
    other = chs.find((c: any) => c.name !== "Lean Test") ?? null;
  }
  if (!channel || !other) return void (skip = "the test channels didn't go on air");
  const show = (await get("/api/ondemand?kind=show")).shows.find((s: any) => s.name === "Lean Test");
  eps = (await get(`/api/ondemand/show?key=${encodeURIComponent(show.key)}`)).seasons[0].episodes;
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function open(prefs: object = {}, start = channel!) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${start.id}`, ...prefs }))})`);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.waitForFunction(() => !!document.getElementById("video")!.getAttribute("src"), null, { timeout: 20_000 });
  return { page, ctx, errors };
}

const P = (page: any, fn: string, ...args: unknown[]) =>
  page.evaluate(async ([f, a]: [string, unknown[]]) => (await import(location.origin + "/js/player.js"))[f](...a), [fn, args]);
const pos = (page: any) => page.evaluate(async () => (await import(location.origin + "/js/player.js")).timeline()?.posMs ?? -1);
const odItem = (page: any) => page.evaluate(async () => (await import(location.origin + "/js/player.js")).tv.onDemand?.itemId ?? null);
const playing = (page: any) => page.waitForFunction(() => {
  const v = document.getElementById("video") as HTMLVideoElement;
  return !!v.getAttribute("src") && !v.paused && v.readyState >= 3;
}, null, { timeout: 15_000 });

describe("Lean-back pack", () => {
  it("chapter titles come with the item from the scan", async (t) => {
    if (skip) return t.skip(skip);
    const it = await get(`/api/item?id=${encodeURIComponent(eps[0]!.id)}`);
    assert.deepEqual(it.chaptersMs, [0, 10_000, 40_000]);
    assert.deepEqual(it.chapterNames, ["Intro", "Part 1", "Credits"]);
  });

  it("Skip intro shows in the intro and jumps to the end of it", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, errors } = await open();
    await P(page, "playOnDemand", eps[0]!.id, { fromMs: 1000 });
    await playing(page);
    await page.waitForSelector('#lean:not([hidden]) [data-lean="skip"]', { timeout: 8000 });
    assert.equal((await page.textContent("#lean")).trim(), "Skip intro");
    assert.equal(await page.locator('[data-lean="next"]').count(), 0, "no Next episode this early");
    await page.click('[data-lean="skip"]');
    await page.waitForFunction(async () => ((await import(location.origin + "/js/player.js")).timeline()?.posMs ?? 0) >= 9_500, null, { timeout: 8000 });
    await page.waitForSelector("#lean", { state: "hidden" });
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("in the credits: Skip credits and Next episode, and OK plays the next episode", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await P(page, "playOnDemand", eps[0]!.id, { fromMs: 42_000 });
    await playing(page);
    await page.waitForSelector('#lean:not([hidden]) [data-lean="next"]', { timeout: 8000 });
    assert.equal(await page.textContent('[data-lean="skip"] b'), "Skip credits");
    assert.match(await page.textContent('[data-lean="next"]'), /Next episode\s*S1 · E2/);
    assert.equal(await page.getAttribute('[data-lean="next"]', "class"), "lean-btn main");
    await page.keyboard.press("Enter");
    await page.waitForFunction((id: string) => import(location.origin + "/js/player.js").then((m) => m.tv.onDemand?.itemId === id), eps[1]!.id, { timeout: 8000 });
    assert.equal(await page.isVisible("#guide"), false, "OK pressed the button, not the guide");
    await closeQuietly(ctx);
  });

  it("with the button turned off nothing shows; with skip intros by themselves it jumps without a press", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ skipButtons: false });
    await P(page, "playOnDemand", eps[0]!.id, { fromMs: 1000 });
    await playing(page);
    await sleep(1500);
    assert.equal(await page.isVisible("#lean"), false);
    await closeQuietly(ctx);
    const b = await open({ autoSkipIntro: true });
    await P(b.page, "playOnDemand", eps[0]!.id, { fromMs: 1000 });
    await b.page.waitForFunction(async () => ((await import(location.origin + "/js/player.js")).timeline()?.posMs ?? 0) >= 9_500, null, { timeout: 10_000 });
    await closeQuietly(b.ctx);
  });

  it("the end of an episode goes back to the channel, or plays the next one when that's turned on", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ autoNext: true });
    await P(page, "playOnDemand", eps[2]!.id, { fromMs: 57_000 });
    await page.waitForFunction((id: string) => import(location.origin + "/js/player.js").then((m) => m.tv.onDemand?.itemId === id), eps[3]!.id, { timeout: 15_000 });
    await closeQuietly(ctx);
    const b = await open();
    await P(b.page, "playOnDemand", eps[2]!.id, { fromMs: 57_000 });
    await b.page.waitForFunction(() => import(location.origin + "/js/player.js").then((m) => m.tv.onDemand?.itemId), null, { timeout: 8000 });
    await b.page.waitForFunction(() => import(location.origin + "/js/player.js").then((m) => !m.tv.onDemand && m.tv.current), null, { timeout: 15_000 });
    await closeQuietly(b.ctx);
  });

  it("sleep timer at the end of the program: the bar counts down, the picture dims, then the station signs off and streams nothing", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ sleepFadeSec: 2 });
    await P(page, "playOnDemand", eps[0]!.id, { fromMs: 48_000 });
    await playing(page);
    await page.mouse.move(100, 200);
    await page.mouse.move(120, 210);
    await page.waitForFunction(() => document.body.classList.contains("pbar-on"));
    await page.click('[data-act="menu"]');
    await page.click('[data-m="page:sleep"]');
    assert.equal(await page.locator('[data-m^="sleep:"]').count(), 5);
    await page.click('[data-m="sleep:end"]');
    await page.mouse.move(130, 220);
    await page.waitForSelector(".pb-sleep:not([hidden])");
    assert.match(await page.textContent(".pb-sleep"), /^Sleep \d+ s$/);
    await page.waitForSelector("#sleepdim:not([hidden])", { timeout: 15_000 });
    await page.waitForSelector("#signoff .so-off", { timeout: 10_000 });
    assert.match(await page.textContent("#signoff"), /sleep timer ran out/);
    assert.equal(await page.evaluate(() => document.getElementById("video")!.getAttribute("src")), null, "nothing streams after the sign-off");
    assert.equal(await page.isVisible("#sleepdim"), false);
    await page.keyboard.press("k");
    await page.waitForSelector("#signoff .so-off", { state: "detached", timeout: 5000 });
    await closeQuietly(ctx);
  });

  it("a key during the sleep timer's fade keeps the station on", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open({ sleepFadeSec: 6 });
    await P(page, "playOnDemand", eps[0]!.id, { fromMs: 20_000 });
    await playing(page);
    await page.evaluate(async () => (await import(location.origin + "/js/sleep.js")).setSleep("end"));
    await P(page, "seekBy", 33_000); // 6 s from the end: the fade starts
    await page.waitForSelector("#sleepdim:not([hidden])", { timeout: 8000 });
    await page.keyboard.press("Shift");
    await page.waitForSelector("#sleepdim", { state: "hidden" });
    assert.equal(await page.evaluate(async () => (await import(location.origin + "/js/sleep.js")).sleepState()), null);
    await sleep(500);
    assert.equal(await page.locator("#signoff .so-off").count(), 0);
    await closeQuietly(ctx);
  });

  it("Remind me: a notice at start time, and Watch now tunes in", async (t) => {
    if (skip) return t.skip(skip);
    const at = Date.now() + 2500;
    const { page, ctx } = await open({ reminders: [{ ch: channel!.id, start: at, end: at + 600_000, title: "Lean Test", episode: "S1 · E3", mode: "remind" }] }, other!);
    await page.waitForSelector("#remind:not([hidden])", { timeout: 10_000 });
    assert.match(await page.textContent("#remind"), /Starting now on \d+ Lean Test\s*Lean Test\s*S1 · E3/);
    await page.click('[data-rm="watch"]');
    await page.waitForFunction((id: string) => import(location.origin + "/js/player.js").then((m) => m.tv.current?.id === id), channel!.id);
    assert.equal(await page.isVisible("#remind"), false);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs")!));
    assert.equal(prefs.reminders ?? null, null, "a reminder goes once it has fired");
    await closeQuietly(ctx);
  });

  it("Tune me: the set changes channel by itself at start time, even from On Demand", async (t) => {
    if (skip) return t.skip(skip);
    const at = Date.now() + 4000;
    const { page, ctx } = await open({ reminders: [{ ch: channel!.id, start: at, end: at + 600_000, title: "Lean Test", episode: null, mode: "tune" }] }, other!);
    await P(page, "playOnDemand", eps[4]!.id, { fromMs: 5000 });
    await page.waitForFunction((id: string) => import(location.origin + "/js/player.js").then((m) => !m.tv.onDemand && m.tv.current?.id === id), channel!.id, { timeout: 12_000 });
    await closeQuietly(ctx);
  });

  it("in the guide, R sets a reminder on a program still to come, then Tune me, then none", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(".guide-details .gd-remind");
    await page.keyboard.press("r");
    await page.waitForSelector(".cell.focus.reminded");
    assert.equal(await page.getAttribute('.gd-rbtn[data-remind="remind"]', "aria-pressed"), "true");
    await page.keyboard.press("r");
    assert.equal(await page.getAttribute('.gd-rbtn[data-remind="tune"]', "aria-pressed"), "true");
    let prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs")!));
    assert.equal(prefs.reminders.length, 1);
    assert.equal(prefs.reminders[0].mode, "tune");
    await page.click('.gd-rbtn[data-remind="tune"]'); // pressing the lit button clears it
    await page.waitForSelector(".cell.focus.reminded", { state: "detached" });
    prefs = await page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs")!));
    assert.equal(prefs.reminders ?? null, null);
    await closeQuietly(ctx);
  });
});

describe("chapter titles for files scanned before they were kept", () => {
  it("are read again from the file on this PC, never from a provider", async (t) => {
    if (skip) return t.skip(skip);
    server!.kill();
    await new Promise((r) => server!.once("exit", r));
    const file = join(home, "library.json");
    const lib = JSON.parse(readFileSync(file, "utf8"));
    for (const it of Object.values(lib.items) as any[]) delete it.chapterNames;
    writeFileSync(file, JSON.stringify(lib));
    ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home }));
    const it = await get(`/api/item?id=${encodeURIComponent(eps[0]!.id)}`);
    assert.deepEqual(it.chapterNames, ["Intro", "Part 1", "Credits"]);
  });
});
