// Browser tests for the player (workstream A): joining at station time, pause →
// live, surfing cost, and auto sign-off. Plays real (tiny, ffmpeg-made) VP9/Opus
// files from a local folder, so no provider is ever contacted.
// Skips cleanly when Playwright, its browser or ffmpeg isn't installed.

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
let langs: { id: string; number: number } | null = null;
let jukebox: { id: string; number: number } | null = null;

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
  // Two audio languages (English default, Spanish) and English captions with a
  // numbered line every 2 s, so a cue's text says which file second it belongs to.
  const srt = join(home, "lines.srt");
  const t = (x: number) => `00:00:${String(Math.floor(x)).padStart(2, "0")},${String(Math.round((x % 1) * 1000)).padStart(3, "0")}`;
  writeFileSync(srt, Array.from({ length: 22 }, (_, i) => `${i + 1}\n${t(i * 2)} --> ${t(i * 2 + 1.8)}\nLine ${i + 1}\n`).join("\n"));
  for (let i = 1; i <= 4; i++)
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=45",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=45", "-f", "lavfi", "-i", "sine=frequency=880:duration=45", "-i", srt,
      "-map", "0", "-map", "1", "-map", "2", "-map", "3", "-c:v", "libvpx-vp9", "-b:v", "150k", "-deadline", "realtime", "-cpu-used", "8", "-g", "48",
      "-c:a", "libopus", "-b:a", "32k", "-c:s", "srt", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=spa",
      "-metadata:s:s:0", "language=eng", "-disposition:a:0", "default", join(media, `Lang Test S01E0${i}.mkv`)]);
  // Five tagged songs in one album folder with a cover: enough for the Jukebox (N-23a).
  const album = join(media, "Test Band", "Signal Tones");
  mkdirSync(album, { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=300x300", "-frames:v", "1", join(album, "cover.jpg")]);
  for (let i = 1; i <= 5; i++)
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${200 + i * 60}:duration=40`, "-f", "lavfi", "-i", "anoisesrc=d=40:c=pink:a=0.15",
      "-filter_complex", "[0][1]amix=inputs=2", "-c:a", "libopus", "-b:a", "48k", "-metadata", `title=Tone Number ${i}`, "-metadata", "artist=Test Band",
      "-metadata", "album=Signal Tones", "-metadata", `track=${i}`, "-metadata", "date=1994", "-metadata", "genre=Electronic", join(album, `0${i} Tone Number ${i}.opus`)]);
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
  let langKey: string | undefined;
  for (let i = 0; i < 150 && !(showKey && langKey); i++) {
    await sleep(200);
    lib = await get("/api/library");
    showKey = lib.shows.find((s: any) => s.name === "Player Test" && s.timed === 8)?.key;
    langKey = lib.shows.find((s: any) => s.name === "Lang Test" && s.timed === 4)?.key;
  }
  await post("/api/channels/custom", { name: "Player Direct", showKeys: [showKey], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  if (langKey) await post("/api/channels/custom", { name: "Player Langs", showKeys: [langKey], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  for (let i = 0; i < 30 && !(direct && langs); i++) {
    await sleep(200);
    const chs = (await get("/api/bootstrap")).channels;
    direct = chs.find((c: any) => c.name === "Player Direct") ?? null;
    langs = chs.find((c: any) => c.name === "Player Langs") ?? null;
  }
  for (let i = 0; i < 50 && !jukebox; i++) {
    jukebox = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Jukebox") ?? null;
    if (!jukebox) await sleep(200);
  }
  if (!direct) skip = "the test channel didn't go on air";
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function open(prefs: object = {}, ch = direct!) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(`localStorage.getItem("debridtv.prefs") || localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${ch.id}`, ...prefs }))})`);
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
async function drift(page: any, ch = direct!) {
  const [vt, n] = await Promise.all([
    page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).currentTime * 1000),
    get(`/api/now?channel=${ch.id}`),
  ]);
  return { driftMs: Math.round(vt - n.fileOffsetMs), item: n.airing?.itemId };
}

/** Wait until the program on screen is at least `inMs` in, with at least `leftMs` to go. */
async function wellInside(page: any, inMs: number, leftMs: number, ch = direct!) {
  for (let i = 0; i < 120; i++) {
    const n = await get(`/api/now?channel=${ch.id}`);
    if (n.segment?.kind === "program" && n.fileOffsetMs >= inMs && n.airing.end - n.now > leftMs + 1000) break;
    await sleep(500);
  }
  await playing(page);
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
    await closeQuietly(ctx);
  });

  it("resuming from pause plays on from where it paused, and Back goes to live (ADR-0006)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx } = await open();
    await playing(page);
    await wellInside(page, 0, 12_000);
    await page.keyboard.press(" ");
    await sleep(500);
    assert.ok(await page.locator("#paused").isVisible(), "paused overlay shows");
    await sleep(4000);
    await page.keyboard.press(" ");
    await playing(page);
    await sleep(800);
    const after = await drift(page);
    assert.ok(after.driftMs < -3500 && after.driftMs > -7000, `picks up where it paused, behind the station (drift ${after.driftMs} ms)`);
    // While paused the control bar is up and its own LIVE button stands in for the pill.
    assert.equal(await page.evaluate(() => document.getElementById("live-pill")!.hidden), false, "Back to live shows");
    assert.match(await page.locator(".pb-live").innerText(), /Back to live/i);
    await page.keyboard.press("l");
    await page.waitForFunction(() => document.getElementById("live-pill")!.hidden);
    await playing(page);
    await sleep(800);
    const live = await drift(page);
    assert.ok(Math.abs(live.driftMs) < 1500, `back on station time (drift ${live.driftMs} ms)`);
    await closeQuietly(ctx);
  });

  it("skips back in place, jumps to the next program, and the pill goes back to live (ADR-0006)", async (t) => {
    if (skip) return t.skip(skip);
    const { page, ctx, media, errors } = await open();
    await playing(page);
    // 12 s into a program with time left, so a 10 s skip stays inside it.
    await wellInside(page, 12_000, 8_000);
    media.length = 0;
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => !(document.getElementById("video") as HTMLVideoElement).seeking);
    await sleep(600);
    const back = await drift(page);
    assert.ok(Math.abs(back.driftMs + 10_000) < 1500, `10 s behind (drift ${back.driftMs} ms)`);
    assert.equal(media.length, 0, "a direct file seeks in place, no new request");
    assert.match(await page.locator("#live-pill").innerText(), /Back to live[\s\S]*behind/);
    // The scrub-bar contract: timeline() and seekTo().
    const tl = () => page.evaluate(async () => (await import(location.origin + "/js/player.js")).timeline());
    let line = await tl();
    assert.equal(line.mode, "shifted");
    assert.ok(Math.abs(line.liveMs - line.posMs - 10_000) < 1500, JSON.stringify(line));
    assert.ok(line.durMs > 40_000 && line.maxMs === line.durMs && line.minMs === 0);
    await page.evaluate(async (to: number) => (await import(location.origin + "/js/player.js")).seekTo(to), line.posMs + 5000);
    await page.waitForFunction(() => !(document.getElementById("video") as HTMLVideoElement).seeking);
    line = await tl();
    assert.ok(Math.abs(line.liveMs - line.posMs - 5000) < 1500, `seekTo moved 5 s closer to live: ${JSON.stringify(line)}`);

    const shown = () => page.evaluate(async () => {
      const p = await import(location.origin + "/js/player.js");
      return { start: p.tv.info?.airing?.start, end: p.tv.info?.airing?.end, shift: p.timeShift() };
    });
    const before = await shown();
    await page.keyboard.press("]");
    await page.waitForFunction(async (end: number) => (await import(location.origin + "/js/player.js")).tv.info?.airing?.start === end, before.end);
    await playing(page);
    const next = await shown();
    assert.equal(next.start, before.end, "the next program in the schedule");
    assert.ok(next.shift > 0, `ahead of the station (${next.shift} ms)`);
    assert.match(await page.locator("#live-pill").innerText(), /ahead/);

    await page.evaluate(() => document.getElementById("live-pill")!.click()); // the control bar may be covering it
    await page.waitForFunction(() => document.getElementById("live-pill")!.hidden);
    await playing(page);
    await sleep(800);
    assert.ok(Math.abs((await drift(page)).driftMs) < 1500, "live again");
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
  });

  it("A picks another audio language and C turns captions on, in step with the picture, and both carry over (N-18a)", async (t) => {
    if (skip) return t.skip(skip);
    if (!langs) return t.skip("the language test channel didn't go on air");
    // Start early in a program, so the whole check stays inside one file.
    for (let i = 0; i < 40; i++) {
      const n = await get(`/api/now?channel=${langs.id}`);
      if (n.segment?.kind === "program" && n.airing.end - n.now > 32_000) break;
      await sleep(500);
    }
    const { page, ctx, errors } = await open({}, langs);
    const src = () => page.evaluate(() => document.getElementById("video")!.getAttribute("src") ?? "");
    const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs") || "{}"));
    const tracks = (await get(`/api/item?id=${(await get(`/api/now?channel=${langs!.id}`)).airing.itemId}`)).tracks;
    assert.deepEqual(tracks.filter((x: any) => x.kind !== "video").map((x: any) => `${x.kind}:${x.index}:${x.lang}`), ["audio:0:eng", "audio:1:spa", "subtitle:0:eng"]);
    await playing(page);
    assert.doesNotMatch(await src(), /\/live/, "the default track plays the file directly");
    // Playwright's Chromium has no AAC. A server that can't send Opus sound in
    // compatibility mode (&ac=opus) can't be checked end to end here.
    const itemId = (await get(`/api/now?channel=${langs!.id}`)).airing.itemId;
    const head = Buffer.from(await (await fetch(`${BASE}/media/${itemId}/live?start=1&v=vp9&ac=opus`)).arrayBuffer()).subarray(0, 4096);
    if (!head.includes("Opus")) return void (await closeQuietly(ctx), t.skip("this server sends only AAC sound in compatibility mode"));

    await page.keyboard.press("a");
    await page.waitForFunction(() => /\/live\?.*&a=1/.test(document.getElementById("video")!.getAttribute("src") ?? ""));
    await playing(page);
    assert.equal((await prefs()).audioLang, "spa", "remembers the language");
    assert.match(await page.evaluate(() => document.getElementById("osd-num")!.textContent ?? ""), /Spanish/i);

    await page.keyboard.press("c");
    await page.waitForFunction(() => /&a=1&s=0/.test(document.getElementById("video")!.getAttribute("src") ?? ""));
    await playing(page);
    assert.equal((await prefs()).subLang, "eng");
    // The cue on screen is the one for this second of the file.
    await page.waitForFunction(() => {
      const tt = (document.getElementById("video") as HTMLVideoElement).textTracks;
      return [...tt].some((x) => x.mode === "showing" && (x.activeCues?.length ?? 0) > 0);
    }, null, { timeout: 15_000 });
    const [cue, n] = await Promise.all([
      page.evaluate(() => {
        const x = [...(document.getElementById("video") as HTMLVideoElement).textTracks].find((x) => x.mode === "showing")!;
        return { text: (x.activeCues![0] as VTTCue).text };
      }),
      get(`/api/now?channel=${langs!.id}`),
    ]);
    const line = Number(/Line (\d+)/.exec(cue.text)?.[1]);
    const expected = Math.floor(n.fileOffsetMs / 2000) + 1;
    assert.ok(Math.abs(line - expected) <= 1, `cue "${cue.text}" at file ${(n.fileOffsetMs / 1000).toFixed(1)} s (expected Line ${expected})`);
    // The next lines follow as the program plays.
    const shown = await page.evaluate(async () => {
      const x = [...(document.getElementById("video") as HTMLVideoElement).textTracks].find((x) => x.mode === "showing")!;
      const seen = new Set<string>();
      for (let i = 0; i < 25; i++) {
        for (const c of [...(x.activeCues ?? [])]) seen.add((c as VTTCue).text);
        await new Promise((r) => setTimeout(r, 200));
      }
      return [...seen];
    });
    assert.ok(shown.length >= 2, `captions keep coming: ${JSON.stringify(shown)}`);

    // Another program (a fresh start here) uses the remembered choices straight away.
    await closeQuietly(ctx);
    const next = await open({ audioLang: "spa", subLang: "eng" }, langs);
    await playing(next.page);
    assert.match(await next.page.evaluate(() => document.getElementById("video")!.getAttribute("src") ?? ""), /&a=1&s=0/);
    // C past the last track turns captions off but keeps the Spanish sound.
    await next.page.keyboard.press("c");
    await next.page.waitForFunction(() => !/&s=/.test(document.getElementById("video")!.getAttribute("src") ?? "x&s="));
    assert.match(await next.page.evaluate(() => document.getElementById("video")!.getAttribute("src") ?? ""), /&a=1/);
    assert.equal(await next.page.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs")!).subLang), "off");
    assert.deepEqual([...errors, ...next.errors], []);
    await closeQuietly(next.ctx);
  });

  it("a music channel plays the song on station time with its sleeve, details and a live analyser (N-23a)", async (t) => {
    if (skip) return t.skip(skip);
    if (!jukebox) return t.skip("this server has no music channels");
    const { page, ctx, errors } = await open({}, jukebox);
    await playing(page);
    const n = await get(`/api/now?channel=${jukebox.id}`);
    assert.equal(n.airing.kind, "track");
    const src = await page.evaluate(() => document.getElementById("video")!.getAttribute("src"));
    assert.equal(src, `/media/${n.airing.itemId}`, "the song plays directly");
    await page.waitForSelector("#music:not([hidden])");
    assert.equal(await page.locator("#music .mu-title").innerText(), n.airing.title);
    assert.equal(await page.locator("#music .mu-artist").innerText(), "Test Band");
    assert.match(await page.locator("#music .mu-album").innerText(), /Signal Tones · 1994/);
    assert.equal(await page.locator("#music .mu-sleeve img").count(), 1, "the album cover is on the sleeve");
    const d = await drift(page, jukebox);
    assert.ok(Math.abs(d.driftMs) < 1500, `on station time (drift ${d.driftMs} ms)`);
    // The first key lets Web Audio start; the bars then follow the real sound.
    await page.keyboard.press("Shift");
    const meter = await page.evaluate(async () => {
      const { musicMeter } = await import(location.origin + "/js/music.js");
      for (let i = 0; i < 50; i++) {
        const m = musicMeter();
        if (m?.routed && m.level > 0.05) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      return musicMeter();
    });
    assert.ok(meter?.routed && meter.level > 0.05, `the analyser hears the song: ${JSON.stringify(meter)}`);
    assert.equal(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).paused), false, "still playing after routing");
    // Leaving the channel takes the music screen down.
    await page.keyboard.press("ArrowUp");
    await page.waitForSelector("#music", { state: "hidden" });
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("a device whose pairing was revoked mid-program goes to pairing, not an error card (home network)", async (t) => {
    if (skip) return t.skip(skip);
    for (const where of ["stranger", "pc"]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${direct!.id}` }))})`);
      const page = await ctx.newPage();
      // The server answers a revoked device's media with 401, and hello says "stranger".
      await page.route("**/media/**", (r: any) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Pair this device first.", pair: "/pair" }) }));
      await page.route("**/api/lan/hello", (r: any) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ where }) }));
      await page.route("**/pair", (r: any) => r.fulfill({ contentType: "text/html", body: "<title>Pair</title>pairing" }));
      await page.goto(BASE + "/");
      if (where === "stranger") {
        await page.waitForURL(/\/pair$/, { timeout: 15_000 });
      } else {
        // Still this PC: the usual card, and no trip to pairing.
        await page.waitForSelector("#card:not([hidden])", { timeout: 15_000 });
        assert.ok(!page.url().endsWith("/pair"));
      }
      await closeQuietly(ctx);
    }
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
      await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
  });

  it("readies the next show only after settling on a channel, and drops it on a channel change (ADR-0006)", async (t) => {
    if (skip) return t.skip(skip);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${direct!.id}` }))})`);
    // The test files are local, which is never pre-loaded; make the next program a provider file starting in 30 s.
    await ctx.route("**/api/now?*", async (r: any) => {
      const res = await r.fetch();
      const body = await res.json();
      if (body.airing && body.next) body.next = { ...body.next, itemId: "remote-next", provider: "torbox", availability: "ok", start: body.now + 30_000 };
      await r.fulfill({ response: res, json: body });
    });
    const asked: Array<{ at: number; itemId: string }> = [];
    const dropped: number[] = [];
    // Hold the pre-load open, as a slow provider would.
    await ctx.route("**/api/preload", (r: any) => asked.push({ at: Date.now(), itemId: JSON.parse(r.request().postData()).itemId }));
    const page = await ctx.newPage();
    page.on("requestfailed", (r: any) => new URL(r.url()).pathname === "/api/preload" && dropped.push(Date.now()));
    const t0 = Date.now();
    await page.goto(BASE + "/");
    await playing(page);
    await sleep(6000);
    assert.equal(asked.length, 0, "nothing fetched ahead in the first seconds on a channel");
    for (let i = 0; i < 60 && !asked.length; i++) await sleep(250);
    assert.equal(asked.length, 1, "one pre-load once settled");
    assert.equal(asked[0]!.itemId, "remote-next");
    assert.ok(asked[0]!.at - t0 >= 9000, `waited for the viewer to settle (${asked[0]!.at - t0} ms)`);
    await page.keyboard.press("ArrowUp");
    for (let i = 0; i < 20 && !dropped.length; i++) await sleep(100);
    assert.equal(dropped.length, 1, "changing channel drops the pre-load request");
    await closeQuietly(ctx);
  });
});
