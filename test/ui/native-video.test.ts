// Browser tests for the desktop app's native player (desktop/, native-video.js).
// The real app runs in Chromium with a stand-in for the app window: a real mpv
// (no picture, no sound card) on a local IPC socket, relayed to the page exactly
// as debridtv-window.exe relays it. The files have DTS and Dolby Digital sound,
// which no browser decodes, so a pass means mpv played them as they are.
// Skips cleanly when Playwright, its browser, ffmpeg or mpv isn't installed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
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
const has = (cmd: string, flag = "--version") => {
  try {
    execFileSync(cmd, [flag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

let server: ChildProcess | null = null;
let browser: any = null;
let home = "";
let skip: string | false =
  process.platform === "win32" ? "uses a Unix socket for mpv" : !chromium ? "Playwright isn't installed" : !has("ffmpeg", "-version") ? "ffmpeg isn't installed" : !has("mpv") ? "mpv isn't installed" : false;
let dts: { id: string; number: number } | null = null;
let ac3: { id: string; number: number } | null = null;

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
  home = mkdtempSync(join(tmpdir(), "debridtv-native-"));
  const media = join(home, "media");
  mkdirSync(media);
  // MPEG-4 picture (any ffmpeg has the encoder) with surround formats browsers can't play.
  // Six episodes each, so the library has enough to put channels on the air.
  const make = (name: string, codec: string, i: number) =>
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=40",
      "-f", "lavfi", "-i", `sine=frequency=${300 + i * 40}:duration=40`, "-c:v", "mpeg4", "-q:v", "8", "-g", "24",
      "-c:a", codec, "-strict", "-2", "-ac", "2", "-ar", "48000", "-b:a", codec === "dca" ? "768k" : "192k", join(media, name)]);
  for (let i = 1; i <= 6; i++) make(`Native Harbor Test S01E0${i}.mkv`, "dca", i);
  for (let i = 1; i <= 6; i++) make(`Native Dolby Test S01E0${i}.mkv`, "ac3", i);
  ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home }));
  await post("/api/sources", { provider: "local", dirs: [media] });
  await post("/api/scan/start", { perMinute: 600 });
  let dtsKey: string | undefined;
  let ac3Key: string | undefined;
  for (let i = 0; i < 150 && !(dtsKey && ac3Key); i++) {
    await sleep(200);
    const lib = await get("/api/library");
    dtsKey = lib.shows.find((s: any) => s.name === "Native Harbor Test" && s.timed === 6)?.key;
    ac3Key = lib.shows.find((s: any) => s.name === "Native Dolby Test" && s.timed === 6)?.key;
  }
  await post("/api/channels/custom", { name: "Native DTS", showKeys: [dtsKey], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  await post("/api/channels/custom", { name: "Native AC3", showKeys: [ac3Key], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  for (let i = 0; i < 30 && !(dts && ac3); i++) {
    await sleep(200);
    const chs = (await get("/api/bootstrap")).channels;
    dts = chs.find((c: any) => c.name === "Native DTS") ?? null;
    ac3 = chs.find((c: any) => c.name === "Native AC3") ?? null;
  }
  if (!dts || !ac3) skip = `the test channels didn't go on air (${JSON.stringify((await get("/api/library")).shows?.map((s: any) => [s.name, s.timed]))})`;
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A real mpv plus the page, wired the way the app window wires them. */
async function open(ch: { id: string }) {
  const sock = join(home, `mpv-${Math.random().toString(36).slice(2)}.sock`);
  const mpv = spawn("mpv", ["--idle=yes", "--vo=null", "--ao=null", "--no-config", "--keep-open=no", "--msg-level=all=error", `--input-ipc-server=${sock}`], { stdio: "ignore" });
  let conn: Socket | null = null;
  for (let i = 0; i < 100 && !conn; i++) {
    conn = await new Promise<Socket | null>((r) => {
      const c = connect(sock);
      c.once("connect", () => r(c));
      c.once("error", () => r(null));
    });
    if (!conn) await sleep(50);
  }
  assert.ok(conn, "mpv's IPC socket opened");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(`localStorage.getItem("debridtv.prefs") || localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, startup: `ch:${ch.id}` }))})`);
  const page = await ctx.newPage();
  const sent: any[] = [];
  await page.exposeFunction("__dtvTestSend", (s: string) => {
    sent.push(JSON.parse(s));
    conn!.write(s + "\n");
  });
  await page.addInitScript("window.__DTV_NATIVE = Object.freeze({ send: (s) => window.__dtvTestSend(String(s)) })");
  let buf = "";
  conn!.on("data", (b) => {
    buf += b.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) page.evaluate(`window.__dtvMpv && window.__dtvMpv(${line})`).catch(() => {});
    }
  });
  const pageMedia: string[] = [];
  const errors: string[] = [];
  page.on("request", (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/media/")) pageMedia.push(u.pathname);
  });
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  const prop = (name: string) => page.evaluate((n: string) => (window as any).__dtvMpvGet(n), name);
  const close = async () => {
    await closeQuietly(ctx);
    conn!.destroy();
    mpv.kill();
  };
  return { page, prop, sent, pageMedia, errors, close };
}

const playing = (page: any, timeout = 20_000) =>
  page.waitForFunction(() => {
    const v = document.getElementById("video") as HTMLVideoElement;
    return !!v.getAttribute("src") && !v.paused && v.readyState >= 3 && v.currentTime > 0.3;
  }, null, { timeout });

async function drift(page: any, ch: { id: string }) {
  let out = NaN;
  for (let i = 0; i < 8; i++) {
    const [pos, n] = await Promise.all([page.evaluate(() => (window as any).__dtvMpvGet("time-pos")), get(`/api/now?channel=${ch.id}`)]);
    out = Math.round(pos * 1000 - n.fileOffsetMs);
    if (!(n.segment?.kind === "program" && (n.fileOffsetMs < 2000 || n.airing.end - n.now < 2000))) break;
    await sleep(700);
  }
  return out;
}

describe("native player (desktop app)", () => {
  it("plays DTS sound as-is in mpv, at station time, with no conversion", async (t) => {
    if (skip) return t.skip(skip);
    const s = await open(dts!);
    try {
      await playing(s.page);
      assert.equal(await s.prop("audio-codec-name"), "dts");
      assert.ok((await s.prop("audio-params"))?.samplerate > 0, "mpv decodes the sound");
      const path = await s.prop("path");
      assert.match(path, /\/media\/[^/]+$/, `mpv opens the file itself, not a compatibility stream: ${path}`);
      assert.deepEqual(s.pageMedia, [], "the page itself never downloads video");
      await sleep(1500);
      const d = await drift(s.page, dts!);
      assert.ok(Math.abs(d) < 1500, `drift ${d} ms`);
      assert.deepEqual(s.errors, []);
    } finally {
      await s.close();
    }
  });

  it("plays Dolby Digital, pauses and resumes in mpv, and surfs to the next channel", async (t) => {
    if (skip) return t.skip(skip);
    const s = await open(ac3!);
    try {
      await playing(s.page);
      assert.equal(await s.prop("audio-codec-name"), "ac3");
      await s.page.keyboard.press(" ");
      await s.page.waitForFunction(() => (window as any).__dtvMpvGet("pause").then((p: boolean) => p === true) as any, null, { timeout: 5000 }).catch(() => {});
      assert.equal(await s.prop("pause"), true, "Space pauses mpv");
      const at = await s.prop("time-pos");
      await sleep(1200);
      assert.ok(Math.abs((await s.prop("time-pos")) - at) < 0.1, "the picture holds while paused");
      await s.page.keyboard.press(" ");
      await playing(s.page);
      assert.equal(await s.prop("pause"), false, "Space plays on");
      const before = await s.prop("path");
      // Channel up/down lands on the other test channel (two channels, plus any built-ins).
      for (let i = 0; i < 6; i++) {
        await s.page.keyboard.press("PageUp");
        await sleep(1500);
        const p = await s.prop("path").catch(() => null);
        if (p && p !== before && (await s.prop("audio-codec-name").catch(() => "")) === "dts") break;
      }
      await playing(s.page);
      assert.equal(await s.prop("audio-codec-name"), "dts", "surfed onto the DTS channel");
      assert.deepEqual(s.errors, []);
    } finally {
      await s.close();
    }
  });

  it("seeks within a program in mpv, without reopening the file", async (t) => {
    if (skip) return t.skip(skip);
    const s = await open(dts!);
    try {
      // Far enough into a program that a step back stays inside it.
      for (let i = 0; i < 120; i++) {
        const n = await get(`/api/now?channel=${dts!.id}`);
        if (n.segment?.kind === "program" && n.fileOffsetMs >= 15_000 && n.airing.end - n.now > 8000) break;
        await sleep(500);
      }
      await playing(s.page);
      const loads = () => s.sent.filter((m) => m.command?.[0] === "loadfile").length;
      const n0 = loads();
      const t0 = await s.prop("time-pos");
      await s.page.keyboard.press("ArrowLeft");
      await sleep(1500);
      await playing(s.page);
      const t1 = await s.prop("time-pos");
      assert.ok(t1 < t0, `went back (${t0.toFixed(1)} → ${t1.toFixed(1)})`);
      assert.equal(loads(), n0, "a seek, not a reload");
      assert.deepEqual(s.errors, []);
    } finally {
      await s.close();
    }
  });
});
