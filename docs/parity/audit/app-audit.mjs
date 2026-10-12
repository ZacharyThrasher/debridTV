// Parity audit for the DebridTV app (workstream D).
//
// Starts the real app in a throwaway data dir, feeds it generated local media
// (no provider traffic, safe to run anywhere), drives it in Chromium and checks
// the behaviours the parity register claims. Each check has an id (A01...) that
// rows in ../nostalgiatv.md cite. Writes ../evidence/app-audit.json and
// screenshots next to it.
//
//   node docs/parity/audit/app-audit.mjs            # needs ffmpeg + Playwright
//   PLAYWRIGHT=/path/to/playwright node docs/parity/audit/app-audit.mjs
//
// This script reads the app; it never edits app code. A failing check is a
// finding for the owning workstream, not something to fix here.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const outDir = resolve(here, "../evidence");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "/opt/node22/lib/node_modules/playwright");

const PORT = Number(process.env.AUDIT_PORT ?? 7391);
const BASE = `http://127.0.0.1:${PORT}`;
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(id, rows, name, pass, detail) {
  results.push({ id, rows, name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

// ------------------------------------------------------------------ media

function makeMedia(dir) {
  mkdirSync(dir, { recursive: true });
  const ff = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args]);
  // VP9/Opus WebM: Playwright's Chromium has no H.264, so direct play needs VP9.
  // Episode 8 runs 8 min with a chapter at 4:00, so the lineup has a legal place for a
  // mid-program break (breaks stay out of the first and last 3 min of a program).
  const chapters = join(dir, "chapters.txt");
  writeFileSync(chapters, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=240000\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=240000\nEND=480000\n");
  for (let i = 1; i <= 8; i++) {
    const secs = i === 8 ? 480 : 90;
    ff(["-f", "lavfi", "-i", `testsrc2=size=320x180:rate=24:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=${300 + i * 40}:duration=${secs}`,
      ...(i === 8 ? ["-i", chapters, "-map", "0", "-map", "1", "-map_chapters", "2"] : []),
      "-c:v", "libvpx-vp9", "-b:v", "150k", "-deadline", "realtime", "-cpu-used", "8", "-g", "48", "-c:a", "libopus", "-b:a", "32k",
      join(dir, `Audit Show S01E0${i}.webm`)]);
  }
  // AC-3 audio: the browser can't decode it, so this must take compatibility mode.
  ff(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=120", "-f", "lavfi", "-i", "sine=frequency=500:duration=120",
    "-c:v", "libvpx-vp9", "-b:v", "150k", "-deadline", "realtime", "-cpu-used", "8", "-g", "48", "-c:a", "ac3", "-b:a", "96k",
    join(dir, "Compat Feature (1987).mkv")]);
  // Same episode again in a second folder: must not air twice as often (dedupe, gate D3).
  mkdirSync(join(dir, "copy"), { recursive: true });
  execFileSync("cp", [join(dir, "Audit Show S01E01.webm"), join(dir, "copy", "Audit.Show.S01E01.webm")]);
}

// ------------------------------------------------------------------ server

function startServer(home, extraEnv = {}) {
  const proc = spawn(process.execPath, ["app/server.ts"], {
    cwd: repo,
    env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.log = () => log;
  return proc;
}
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/bootstrap`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not start");
}
async function stop(proc) {
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
}
// One retry: a keep-alive socket can go stale while ffmpeg runs or after a restart.
const call = async (p, init) => {
  try {
    return await fetch(BASE + p, init);
  } catch {
    await sleep(200);
    return fetch(BASE + p, init);
  }
};
const get = async (p) => (await call(p)).json();
const post = async (p, body = {}) => {
  const r = await call(p, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ------------------------------------------------------------------ run

const work = mkdtempSync(join(tmpdir(), "debridtv-audit-"));
const home = join(work, "home");
const media = join(work, "media");
mkdirSync(home);
mkdirSync(outDir, { recursive: true });
const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).toString().trim();
  } catch {
    return "unknown";
  }
})();

let server;
let browser;
try {
  // ---------- demo mode (no sources) ----------
  server = startServer(home);
  await waitUp();
  const b0 = await get("/api/bootstrap");
  check("A01", ["N-02a"], "demo lineup on air with no source", b0.demo && b0.channels.length >= 5,
    { demo: b0.demo, channels: b0.channels.map((c) => `${c.number} ${c.name}`) });
  // ADR-0006: station breaks are opt-in. Out of the box, programs run back to back.
  const g0 = await get(`/api/guide?from=${Date.now()}&to=${Date.now() + 6 * 60 * MIN}`);
  const breaks0 = g0.rows.flatMap((r) => r.airings.flatMap((a) => a.segments.filter((s) => s.kind === "break")));
  check("A29", ["N-21", "N-22a", "N-22b"], "station breaks are off by default: no padding or mid-program breaks in 6 h of guide",
    b0.breaks === false && breaks0.length === 0, { breaks: b0.breaks, breakSegments: breaks0.length });

  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--no-proxy-server"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url().replace(BASE, "")));
  await page.goto(BASE);
  await page.waitForTimeout(800);
  if (await page.locator("#welcome").isVisible()) await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);

  // Number entry: type the digits of a channel that exists.
  const target = b0.channels[Math.min(2, b0.channels.length - 1)];
  for (const d of String(target.number)) await page.keyboard.press(d);
  await page.waitForTimeout(1600);
  const bugText = await page.locator("#bug").innerText();
  check("A02", ["N-13", "N-03"], "number keys tune to that channel; bug shows number + name", bugText.includes(String(target.number)) && bugText.toLowerCase().includes(target.name.toLowerCase()), bugText.replace(/\s+/g, " "));

  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(1500);
  const afterUp = await page.locator("#bug").innerText();
  await page.keyboard.press("l");
  await page.waitForTimeout(1500);
  const afterLast = await page.locator("#bug").innerText();
  check("A03", ["N-13"], "channel up then L returns to the previous channel", afterUp !== bugText && afterLast === bugText, { afterUp, afterLast });

  // Info banner.
  await page.keyboard.press("i");
  await page.waitForTimeout(400);
  const banner = await page.locator("#banner").innerText().catch(() => "");
  check("A04", ["N-15", "N-37"], "info banner shows title, times and what's next", /–/.test(banner) && /Next at|Off the air/.test(banner), banner.replace(/\s+/g, " ").slice(0, 160));
  await page.screenshot({ path: join(outDir, "a04-banner.png") });
  await page.keyboard.press("i");

  // Guide: browse 12 hours ahead and every row; count provider-facing requests.
  const before = requests.length;
  const m0 = await get("/api/meters");
  await page.keyboard.press("g");
  await page.waitForTimeout(800);
  const nowLine = await page.locator(".now-line").count();
  for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "a05-guide.png") });
  const during = requests.slice(before);
  const m1 = await get("/api/meters");
  const costly = during.filter((u) => u.startsWith("/media/") || u.startsWith("/api/prefetch"));
  check("A05", ["N-15", "N-27b"], "guide browsing (12 h ahead, all rows) makes no media or link requests",
    costly.length === 0 && m1.apiTotal === m0.apiTotal && m1.bytes.playback === m0.bytes.playback,
    { requests: during.length, costly, apiDelta: m1.apiTotal - m0.apiTotal });
  const rowsShown = await page.locator(".row").count();
  check("A06", ["N-15"], "guide grid has a row per channel and a now line", rowsShown === b0.channels.length && nowLine > 0, { rowsShown, nowLine });
  await page.keyboard.press("Escape");

  // Look & feel prefs: themes, CRT, 24h clock.
  const themes = [];
  for (const t of ["midnight", "cable92", "daylight"]) {
    await page.evaluate((t) => {
      localStorage.setItem("debridtv.prefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("debridtv.prefs") || "{}"), theme: t }));
    }, t);
    await page.reload();
    await page.waitForTimeout(700);
    themes.push(await page.evaluate(() => document.documentElement.dataset.theme));
  }
  check("A07", ["N-11a"], "three built-in themes apply", themes.join() === "midnight,cable92,daylight", themes);
  await page.keyboard.press("s");
  await page.waitForTimeout(400);
  await page.click('[data-tab="look"]');
  await page.waitForTimeout(400);
  const lookText = await page.locator("#panel-body").innerText();
  check("A08", ["N-12", "N-15"], "look tab offers CRT, static, tuner sounds, 24-hour clock",
    ["CRT screen", "Static between channels", "Tuner sounds", "24-hour clock"].every((s) => lookText.includes(s)), null);
  await page.click('[data-tab="channels"]');
  await page.waitForTimeout(400);
  await page.click("[data-new-channel]");
  await page.waitForTimeout(400);
  const orders = await page.locator("#cord option").count();
  check("A09", ["N-08", "N-02b"], "custom channel builder offers all 8 ordering modes", orders === 8, { orders });
  await page.screenshot({ path: join(outDir, "a09-builder.png") });
  await page.keyboard.press("Escape");
  await page.click("[data-close]").catch(() => {});

  // Last channel persists across a reload.
  const lastBefore = await page.locator("#bug").innerText();
  await page.reload();
  await page.waitForTimeout(1500);
  const lastAfter = await page.locator("#bug").innerText();
  check("A10", ["N-14"], "reload starts on the last channel watched", lastBefore === lastAfter, { lastBefore, lastAfter });
  await page.close();

  // Numbers stable across a restart.
  await stop(server);
  server = startServer(home);
  await waitUp();
  const b1 = await get("/api/bootstrap");
  const sig = (b) => b.channels.map((c) => `${c.number}:${c.name}`).join("|");
  check("A11", ["N-03"], "channel numbers survive a restart", sig(b0) === sig(b1), null);

  // Schedule is a pure function: same airing before and after a restart.
  const ch0 = b1.channels[0];
  const t = Date.now() + 3 * 60 * MIN;
  const n1 = await get(`/api/now?channel=${ch0.id}&at=${t}`);
  await stop(server);
  server = startServer(home);
  await waitUp();
  const n2 = await get(`/api/now?channel=${ch0.id}&at=${t}`);
  check("A12", ["N-27b", "N-35"], "the airing 3 h from now is identical across a restart", n1.airing?.itemId === n2.airing?.itemId && n1.airing?.start === n2.airing?.start && n1.fileOffsetMs === n2.fileOffsetMs,
    { item: n1.airing?.title, offset: n1.fileOffsetMs });

  // ---------- local library ----------
  makeMedia(media);
  // A16/A17 check the opt-in station breaks (ADR-0006); turned on before the channels exist.
  await post("/api/station", { breaks: true });
  const src = await post("/api/sources", { provider: "local", dirs: [media, join(media, "copy")] });
  await post("/api/scan/start", { perMinute: 120 });
  for (let i = 0; i < 60; i++) {
    const s = await get("/api/sources");
    if (!s.scan.running && s.scan.needed === 0) break;
    await sleep(500);
  }
  await sleep(1500);
  const b2 = await get("/api/bootstrap");
  const names = b2.channels.map((c) => `${c.number} ${c.name}`);
  check("A13", ["N-01b"], "local folders become channels after a header scan", !b2.demo && b2.channels.some((c) => c.name === "Audit Show"),
    { files: src.body.files, channels: names });
  const showCh = b2.channels.find((c) => c.name === "Audit Show");
  check("A14", ["N-03"], "show channel takes the #10+ block; Quarter Hour takes #6",
    showCh?.number >= 10 && b2.channels.some((c) => c.number === 6 && c.name === "Quarter Hour"), names);
  const chList = await get("/api/channels");
  const showItems = chList.channels.find((c) => c.name === "Audit Show")?.items;
  check("A15", ["N-01d", "N-05"], "the same episode in two folders airs once (dedupe)", showItems === 8, { showItems, filesSeen: src.body.files });

  // Slot padding: a 90 s episode in a 15-min slot leaves a station break.
  const g = await get(`/api/guide?from=${Date.now()}&to=${Date.now() + 60 * MIN}`);
  const showRow = g.rows.find((r) => r.channel.name === "Audit Show");
  const segs = showRow?.airings?.[0]?.segments ?? [];
  check("A16", ["N-22a"], "slot padding (breaks on): programs start on the quarter hour, the rest is a break",
    segs.some((s) => s.kind === "break" && s.reason === "padding") && showRow.airings.every((a) => new Date(a.start).getMinutes() % 15 === 0),
    segs.map((s) => `${s.kind}${s.reason ? ":" + s.reason : ""}`).join(","));
  const day = await get(`/api/guide?from=${Date.now()}&to=${Date.now() + 24 * 60 * MIN}`);
  const midAiring = day.rows.flatMap((r) => r.airings.map((a) => ({ ch: r.channel.name, a }))).find(({ a }) => a.segments.some((s) => s.reason === "mid"));
  const anyMid = !!midAiring;
  check("A17", ["N-22b"], "files with chapters get mid-program breaks on a slotted channel (breaks on)", anyMid,
    anyMid ? `${midAiring.ch}: ${midAiring.a.episode} ` + midAiring.a.segments.map((s) => `${s.kind}${s.reason ? ":" + s.reason : ""}`).join(",") : "no mid break in 24 h (episode 8 has a chapter at 4:00)");
  await post("/api/station", { breaks: false }); // back to the default for the rest of the run

  // Custom channels: back to back, numbered 50+, then a compat-only channel.
  const lib = await get("/api/library");
  const showKey = lib.shows.find((s) => s.name === "Audit Show")?.key;
  await post("/api/channels/custom", { name: "Audit Direct", showKeys: [showKey], movieIds: [], ordering: "cyclic", slotMinutes: 0 });
  const feat = lib.movies.find((m) => m.title.startsWith("Compat Feature"));
  await post("/api/channels/custom", { name: "Audit Compat", showKeys: [], movieIds: [feat?.id].filter(Boolean), ordering: "cyclic", slotMinutes: 0 });
  await sleep(1500);
  const b3 = await get("/api/bootstrap");
  const direct = b3.channels.find((c) => c.name === "Audit Direct");
  const compat = b3.channels.find((c) => c.name === "Audit Compat");
  check("A18", ["N-02b", "N-03"], "custom channels go on air at #50+", direct?.number >= 50 && compat?.number >= 50, { direct: direct?.number, compat: compat?.number });

  // Hide a channel: it leaves the lineup and the others keep their numbers.
  await post("/api/channels/hide", { ruleKey: "mix:shorts", hidden: true });
  await sleep(300);
  const b4 = await get("/api/bootstrap");
  const keep = b3.channels.filter((c) => c.name !== "Quarter Hour").map((c) => `${c.number}:${c.name}`).join("|");
  check("A19", ["N-03"], "hiding a channel removes it and keeps other numbers", !b4.channels.some((c) => c.name === "Quarter Hour") && sig(b4) === keep, null);
  await post("/api/channels/hide", { ruleKey: "mix:shorts", hidden: false });

  // Browser: join in progress (direct), pause -> live, compat route.
  const page2 = await ctx.newPage();
  const req2 = [];
  page2.on("request", (r) => req2.push(r.url().replace(BASE, "")));
  await page2.goto(BASE);
  await page2.waitForTimeout(800);
  if (await page2.locator("#welcome").isVisible()) await page2.keyboard.press("Enter");
  const tuneTo = async (n) => {
    for (const d of String(n)) await page2.keyboard.press(d);
  };
  await tuneTo(direct.number);
  await page2.waitForFunction(() => {
    const v = document.getElementById("video");
    return v && !v.paused && v.currentTime > 0.5;
  }, null, { timeout: 15_000 }).catch(() => {});
  await page2.waitForTimeout(1500);
  const drift = async (chId) => {
    const [vt, n] = await Promise.all([page2.evaluate(() => document.getElementById("video").currentTime * 1000), get(`/api/now?channel=${chId}`)]);
    return { videoMs: Math.round(vt), stationMs: n.fileOffsetMs, item: n.airing?.title + " " + n.airing?.episode, driftMs: Math.round(vt - n.fileOffsetMs) };
  };
  const d1 = await drift(direct.id);
  check("A20", ["N-35"], "tuning in joins the program at station time (direct play)", Math.abs(d1.driftMs) < 1500, d1);
  await page2.screenshot({ path: join(outDir, "a20-direct.png") });

  // Pause well inside a program so the check isn't satisfied by a program change.
  for (let i = 0; i < 120; i++) {
    const n = await get(`/api/now?channel=${direct.id}`);
    if (n.segment?.kind === "program" && n.fileOffsetMs > 5000 && n.airing.end - n.now > 30_000) break;
    await sleep(500);
  }
  const pausedAt = await drift(direct.id);
  await page2.keyboard.press(" ");
  await page2.waitForTimeout(5000);
  const pausedShown = await page2.locator("#paused").isVisible();
  await page2.keyboard.press(" ");
  await page2.waitForTimeout(2500);
  const d2 = await drift(direct.id);
  const pill = await page2.locator("#live-pill").isVisible();
  await page2.keyboard.press("l");
  await page2.waitForTimeout(2500);
  const d3 = await drift(direct.id);
  check("A21", ["N-35"], "pause for 5 s, resume plays on from where you paused (ADR-0006), and L goes back to live",
    pausedShown && d2.driftMs < -3500 && d2.driftMs > -8000 && d2.item === pausedAt.item && pill && Math.abs(d3.driftMs) < 1500,
    { pausedShown, pausedAtMs: pausedAt.videoMs, resumed: d2, pill, live: d3 });

  // Watch history: what the page reported for real playback.
  await page2.waitForTimeout(16_000); // flush interval is 15 s
  const h = await get("/api/history");
  check("A22", ["N-20"], "playback is reported as seen time in history", h.recent.length > 0 && h.recent[0].seenMs > 0,
    h.recent.slice(0, 2).map((r) => ({ title: r.title, seenMs: r.seenMs, watched: r.watched })));

  // 90% rule at the API: 85% seen is not watched; 92% is.
  const ep = lib.shows.find((s) => s.name === "Audit Show");
  const items = (await get("/api/library")).items ?? null;
  const someItem = (await get(`/api/guide?from=${Date.now()}&to=${Date.now() + 20 * MIN}`)).rows.find((r) => r.channel.name === "Audit Direct")?.airings?.[3];
  let rule = null;
  if (someItem) {
    const dur = someItem.durationMs;
    await post("/api/watch", { itemId: someItem.itemId, fromMs: 0, toMs: Math.round(dur * 0.85), channel: direct.id });
    const w85 = (await get(`/api/item?id=${encodeURIComponent(someItem.itemId)}`)).seenMs;
    const g85 = (await get(`/api/guide?from=${someItem.start}&to=${someItem.end}`)).rows.find((r) => r.channel.name === "Audit Direct").airings.find((a) => a.itemId === someItem.itemId)?.watched;
    await post("/api/watch", { itemId: someItem.itemId, fromMs: Math.round(dur * 0.85), toMs: Math.round(dur * 0.92), channel: direct.id });
    const g92 = (await get(`/api/guide?from=${someItem.start}&to=${someItem.end}`)).rows.find((r) => r.channel.name === "Audit Direct").airings.find((a) => a.itemId === someItem.itemId)?.watched;
    rule = { seenAt85: w85, watchedAt85: g85, watchedAt92: g92 };
  }
  check("A23", ["N-20"], "watched flag flips between 85% and 92% seen and shows in the guide", rule && rule.watchedAt85 === false && rule.watchedAt92 === true, rule);
  void ep;
  void items;

  // Compatibility mode for audio the browser can't decode.
  req2.length = 0;
  await tuneTo(compat.number);
  await page2.waitForFunction(() => {
    const v = document.getElementById("video");
    return v && !v.paused && v.currentTime > 0.5;
  }, null, { timeout: 20_000 }).catch(() => {});
  await page2.waitForTimeout(1500);
  const live = req2.some((u) => /\/media\/[^/]+\/live/.test(u));
  const playing = await page2.evaluate(() => !document.getElementById("video").paused && document.getElementById("video").currentTime > 0.5);
  await page2.keyboard.press("i");
  await page2.waitForTimeout(300);
  const b5 = await page2.locator("#banner").innerText().catch(() => "");
  check("A24", ["N-19", "N-37"], "AC-3 file plays through compatibility mode and the banner says so",
    live && playing && b5.includes("Compatibility mode"), { liveRequest: live, playing, ffmpeg: b3.ffmpeg });
  await page2.screenshot({ path: join(outDir, "a24-compat.png") });

  // Surfing: six fast presses should open media for the last channel only. Local
  // files are served without the provider meters, so count the page's requests.
  await page2.keyboard.press("i");
  req2.length = 0;
  for (let i = 0; i < 6; i++) {
    await page2.keyboard.press("ArrowUp");
    await page2.waitForTimeout(120);
  }
  await page2.waitForTimeout(3000);
  const surfMedia = req2.filter((u) => u.startsWith("/media/"));
  const landed = await page2.locator("#bug").innerText();
  check("A25", ["N-13"], "fast surfing (6 presses, 120 ms apart) requests media only for the channel it lands on",
    new Set(surfMedia.map((u) => u.split("?")[0].replace(/\/live$/, ""))).size <= 1, { mediaRequests: surfMedia.length, distinctFiles: new Set(surfMedia.map((u) => u.split("?")[0])).size, landed: landed.replace(/\s+/g, " ") });

  // Phone width: guide and settings usable at 390 px.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await phone.newPage();
  await p3.goto(BASE);
  await p3.waitForTimeout(800);
  if (await p3.locator("#welcome").isVisible()) await p3.keyboard.press("Enter");
  await p3.evaluate(() => document.querySelector('[data-act="guide"]').click());
  await p3.waitForTimeout(800);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await p3.screenshot({ path: join(outDir, "a26-phone-guide.png") });
  check("A26", ["N-34"], "phone-width guide opens without horizontal overflow", overflow <= 1, { overflow });

  // Picture shape: Z cycles it (auto, fill, 4:3, zoom) where the build has it.
  const shapes = [];
  for (let i = 0; i < 4; i++) {
    await page2.keyboard.press("z");
    await page2.waitForTimeout(250);
    shapes.push(await page2.evaluate(() => JSON.parse(localStorage.getItem("debridtv.prefs") || "{}").aspect ?? null));
  }
  check("A28", ["N-17a"], "Z cycles the picture shape, including 4:3", new Set(shapes).size >= 3 && shapes.some((s) => /4.?3/.test(String(s))), { shapes });

  // Every settings tab renders (catches a tab button without a renderer).
  const broken = [];
  await page2.keyboard.press("s");
  await page2.waitForTimeout(400);
  for (const t of await page2.locator("[data-tab]").evaluateAll((els) => els.map((e) => e.dataset.tab))) {
    await page2.click(`[data-tab="${t}"]`);
    await page2.waitForTimeout(500);
    if (/Couldn't load this tab/.test(await page2.locator("#panel-body").innerText())) broken.push(t);
  }
  check("A27", [], "every settings tab renders", broken.length === 0, { broken });
} catch (e) {
  check("A99", [], "audit ran to completion", false, String(e?.stack ?? e));
  console.log(server?.log?.().slice(-3000));
} finally {
  await browser?.close().catch(() => {});
  if (server) await stop(server).catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

const pass = results.filter((r) => r.pass).length;
writeFileSync(join(outDir, "app-audit.json"), JSON.stringify({ ranAt: new Date().toISOString(), commit, node: process.version, pass, total: results.length, results }, null, 2) + "\n");
console.log(`\n${pass}/${results.length} checks passed (commit ${commit}).`);
if (existsSync(join(outDir, "app-audit.json"))) console.log(`Evidence: ${join(outDir, "app-audit.json")}`);
