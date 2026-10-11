// Browser tests for the guide, station breaks and remote (workstream B).
// Runs the real app in demo mode (no media, no provider traffic) in Chromium.
// Skips cleanly when Playwright or its browser isn't installed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const PORT = 7400 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const MIN = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
let browser: any = null;
let home = "";
let skip: string | false = chromium ? false : "Playwright isn't installed";

async function launch() {
  try {
    return await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] });
  } catch {
    return await chromium.launch({ args: ["--no-proxy-server"] });
  }
}

before(async () => {
  if (skip) return;
  try {
    browser = await launch();
  } catch (e: any) {
    skip = `no browser: ${e.message.split("\n")[0]}`;
    return;
  }
  home = mkdtempSync(join(tmpdir(), "debridtv-ui-"));
  server = spawn(process.execPath, ["app/server.ts"], {
    env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/bootstrap`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not start");
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A page with prefs set; optionally shifted in time so `at` is "now" for the app. */
async function open(opts: { prefs?: object; at?: number; size?: [number, number]; touch?: boolean; fakeClock?: boolean } = {}) {
  const [width, height] = opts.size ?? [1600, 900];
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: !!opts.touch, isMobile: !!opts.touch });
  const offset = opts.at ? opts.at - Date.now() : 0;
  const requests: string[] = [];
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, ...opts.prefs }))})`);
  await ctx.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    requests.push(u.pathname);
    if (!offset || !u.pathname.startsWith("/api/")) return route.continue();
    if (u.pathname === "/api/now" && !u.searchParams.has("at")) u.searchParams.set("at", String(Date.now() + offset));
    const resp = await route.fetch({ url: u.toString() });
    let body = await resp.text();
    try {
      const o = JSON.parse(body);
      if (typeof o.now === "number") o.now += offset;
      body = JSON.stringify(o);
    } catch {}
    await route.fulfill({ response: resp, body });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  if (opts.fakeClock) await page.clock.install();
  await page.goto(BASE + "/");
  await page.waitForFunction("document.getElementById('bug').textContent.length > 0");
  return { page, ctx, requests, errors };
}

const js = (page: any, expr: string) => page.evaluate(expr);

/** The start of a long slot-padding break, found from the guide. */
async function findLongBreak() {
  const t = Date.now();
  const g = await (await fetch(`${BASE}/api/guide?from=${t}&to=${t + 12 * 60 * MIN}`)).json();
  for (const r of g.rows)
    for (const a of r.airings)
      for (const s of a.segments)
        if (s.kind === "break" && s.reason === "padding" && s.end - s.start > 10 * MIN && s.start > t) return { ch: r.channel, at: s.start + 2 * MIN };
  return null;
}

describe("guide", { skip }, () => {
  it("opens, fits whole rows, and costs no media or link requests", async () => {
    const { page, ctx, requests, errors } = await open();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    const fit = await js(page, `(() => {
      const rows = document.querySelector(".grid-rows").getBoundingClientRect();
      const r = document.querySelector(".row").getBoundingClientRect().height;
      return Math.abs(rows.height / r - Math.round(rows.height / r));
    })()`);
    assert.ok(fit < 0.02, `rows should fit exactly, off by ${fit}`);
    for (let i = 0; i < 6; i++) await page.keyboard.press(i % 2 ? "ArrowRight" : "ArrowDown");
    assert.equal(requests.filter((p) => p.startsWith("/media") || p === "/api/prefetch").length, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("Enter tunes the highlighted channel and closes the guide", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const want = await js(page, `document.querySelectorAll(".row")[document.querySelector(".cell.focus").dataset.row].querySelector(".n").textContent`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(`document.getElementById("guide").hidden`);
    await page.waitForFunction(`document.getElementById("bug").textContent.startsWith(${JSON.stringify(want)})`);
    await ctx.close();
  });

  it("a swipe on a touch screen moves through channels", async () => {
    const { page, ctx } = await open({ size: [390, 844], touch: true });
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    const before = Number(await js(page, `document.querySelector(".cell.focus").dataset.row`));
    const cdp = await ctx.newCDPSession(page);
    const pt = (y: number) => [{ x: 250, y }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(700) });
    for (let y = 680; y >= 460; y -= 20) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(y) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(200);
    const after = Number(await js(page, `document.querySelector(".cell.focus").dataset.row`));
    assert.ok(after >= before + 3, `swipe moved ${after - before} rows`);
    await ctx.close();
  });

  it("starts on the guide and closes itself when idle, if set to", async () => {
    const { page, ctx } = await open({ prefs: { startup: "guide", guideIdle: "close", guideIdleMin: 0.03 } });
    await page.waitForFunction(`!document.getElementById("guide").hidden`);
    await page.waitForFunction(`document.getElementById("guide").hidden`, null, { timeout: 5000 });
    await ctx.close();
  });
});

describe("station breaks", { skip }, () => {
  it("a long break rotates through what's on, from the local clock only", async () => {
    const brk = await findLongBreak();
    assert.ok(brk, "demo lineup should have a long break in the next 12 hours");
    const { page, ctx, requests, errors } = await open({ at: brk.at, prefs: { startup: "last" }, fakeClock: true });
    await js(page, `localStorage.setItem("debridtv.lastChannel", ${JSON.stringify(brk.ch.id)})`);
    await page.reload();
    await page.waitForSelector(".card.brk .brk-hero");
    assert.match(await js(page, `document.querySelector(".brk-label").textContent`), /Up next/);
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(10_500);
      seen.add(await js(page, `document.querySelector(".brk-stage .brk-label").textContent`));
    }
    assert.ok([...seen].some((s) => /On now elsewhere/.test(s)), `slides seen: ${[...seen].join(" | ")}`);
    assert.ok([...seen].some((s) => /^Later on/.test(s)));
    assert.equal(requests.filter((p) => p.startsWith("/media") || p === "/api/prefetch").length, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});

describe("channel editor", { skip }, () => {
  it("opens, keeps the remote from flipping channels, and closes on Escape", async () => {
    const { page, ctx } = await open();
    const bug = await js(page, `document.getElementById("bug").textContent`);
    await js(page, `import("/js/channel-editor.js").then(async (m) => m.openChannelEditor((await import("/js/player.js")).tv.channels[1]))`);
    await page.waitForSelector(".ced:not([hidden])");
    await page.click('[data-tab="schedule"]');
    await page.click("[data-slot-add]");
    assert.equal(await js(page, `document.querySelectorAll(".week .lane i").length`), 1);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".ced", { state: "hidden" });
    assert.equal(await js(page, `document.getElementById("bug").textContent`), bug);
    await ctx.close();
  });
});

describe("themes (N-11b)", { skip }, () => {
  it("builds a custom theme, applies it live and saves it", async () => {
    const { page, ctx, errors } = await open();
    await js(page, `import("/js/theme.js").then((m) => m.openThemeEditor())`);
    await page.waitForSelector(".thm-sheet");
    await page.click('[data-start="s:prevue"]');
    // The draft shows on the whole app while editing.
    assert.equal(await js(page, `getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()`), "#14052e");
    await page.fill("#thm-name", "Late Show");
    await page.fill('[data-hex="accent"]', "#ff0066");
    await page.click("[data-save]");
    const prefs = await js(page, `JSON.parse(localStorage.getItem("debridtv.prefs"))`);
    assert.match(prefs.theme, /^custom:/);
    assert.equal(prefs.customThemes[0].name, "Late Show");
    assert.equal(prefs.customThemes[0].colors.accent, "#ff0066");
    // Re-applying prefs (as on the next start) paints the saved theme, not the draft.
    await js(page, `import("/js/util.js").then((m) => m.applyPrefs())`);
    assert.equal(await js(page, `getComputedStyle(document.documentElement).getPropertyValue("--amber").trim()`), "#ff0066");
    assert.equal(await js(page, `document.documentElement.dataset.theme`), "custom");
    const opts = await js(page, `import("/js/theme.js").then((m) => m.themeOptions().map((o) => o.label))`);
    assert.ok(opts.includes("Late Show") && opts.includes("Midnight"));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("cancel restores the theme; Escape closes only the editor", async () => {
    const { page, ctx } = await open({ prefs: { theme: "daylight" } });
    await js(page, `import("/js/panel.js").then((m) => m.openPanel("look"))`);
    await js(page, `import("/js/theme.js").then((m) => m.openThemeEditor())`);
    await page.click('[data-start="s:teletext"]');
    assert.equal(await js(page, `document.documentElement.dataset.tone`), "dark");
    await page.keyboard.press("Escape");
    assert.equal(await js(page, `document.documentElement.dataset.theme`), "daylight");
    assert.equal(await js(page, `document.documentElement.dataset.tone`), "light");
    assert.equal(await js(page, `document.documentElement.style.getPropertyValue("--bg")`), "");
    assert.equal(await js(page, `document.getElementById("panel").hidden`), false);
    await ctx.close();
  });

  it("imports only clean colours and rejects other files", async () => {
    const { page, ctx } = await open();
    const r = await js(page, `import("/js/theme.js").then((m) => {
      const ok = m.cleanTheme({ format: "debridtv-theme", name: "<b>X</b>", colors: { bg: "#000", panel: "112233", ink: "#FFFFFF", accent: "red;}body{x:1" }, cellStrength: 500 });
      let bad = "";
      try { m.cleanTheme({ format: "something-else", colors: {} }); } catch (e) { bad = e.message; }
      return { ok, bad };
    })`);
    assert.equal(r.ok.colors.bg, "#000000");
    assert.equal(r.ok.colors.panel, "#112233");
    assert.equal(r.ok.colors.ink, "#ffffff");
    assert.equal(r.ok.colors.accent, "#ffb547", "an invalid colour falls back, never reaches CSS");
    assert.equal(r.ok.name, "bX/b");
    assert.equal(r.ok.cellStrength, 100);
    assert.match(r.bad, /something else/);
    await ctx.close();
  });
});

describe("format chips (N-37)", { skip }, () => {
  it("names resolution, HDR and sound from airing.codecs", async () => {
    const { page, ctx } = await open();
    const out = await js(page, `import("/js/ui.js").then((m) => [
      m.formatChips({ codecs: { video: "hevc", audio: ["truehd"], hdr: "dv", height: 2160, audioChannels: 8, atmos: true } }),
      m.formatChips({ codecs: { video: "h264", audio: ["aac"], height: 720, audioChannels: 2 } }),
      m.formatChips({ codecs: { video: "h264" } }),
    ])`);
    assert.match(out[0], /4K.*Dolby Vision.*Atmos.*TrueHD 7\.1/);
    assert.match(out[1], /720p.*Stereo/);
    assert.equal(out[2], "");
    await ctx.close();
  });
});

describe("channel mix and exclusions (N-09, N-10)", { skip }, () => {
  it("Mix tab saves weights, genres and order settings, and reshuffles", async () => {
    const { page, ctx, errors } = await open();
    const id = await js(page, `import("/js/player.js").then((p) => p.tv.channels.find((c) => c.kind !== "show").id)`);
    await js(page, `Promise.all([import("/js/channel-editor.js"), import("/js/player.js")]).then(([m, p]) => m.openChannelEditor(p.tv.channels.find((c) => c.id === ${JSON.stringify(id)}), { tab: "mix" }))`);
    await page.waitForSelector(".mix-row");
    const first = await js(page, `document.querySelector("[data-weight]").dataset.weight`);
    await js(page, `(() => { const r = document.querySelector("[data-weight]"); r.value = 0; r.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    assert.equal(await js(page, `document.querySelector(".mix-row .mix-word").textContent`), "Never");
    const genre = await js(page, `document.querySelector("[data-genre]").dataset.genre`);
    await page.click(`[data-genre="${genre}"]`);
    await page.click('[data-set="balance:time"]');
    await page.click('[data-set="watched:unwatched"]');
    await page.click("[data-refresh]");
    await page.waitForSelector("#toast:not([hidden])");
    assert.match(await js(page, `document.getElementById("toast").textContent`), /New order starts/);
    await page.click("[data-save]");
    await page.waitForFunction(`document.querySelector(".ced").hidden`);
    const s = await (await fetch(`${BASE}/api/channels/${id}/settings`)).json();
    assert.equal(s.weights[first], 0);
    assert.deepEqual(s.exclude.genres, [genre]);
    assert.equal(s.balance, "time");
    assert.equal(s.watched, "unwatched");
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("keeps a show and a genre off every channel", async () => {
    const { page, ctx } = await open();
    await js(page, `import("/js/channel-editor.js").then((m) => m.openExclusions())`);
    await page.waitForSelector(".ex-row");
    const genre = await js(page, `document.querySelector("[data-ex-genre]").dataset.exGenre`);
    await page.click(`[data-ex-genre="${genre}"]`);
    await page.click(".ex-row >> nth=0");
    assert.equal(await js(page, `document.querySelector(".ex-count").textContent`), "2 kept off");
    await page.click("[data-ex-save]");
    const ex = await (await fetch(`${BASE}/api/exclusions`)).json();
    assert.deepEqual(ex.genres, [genre]);
    assert.equal(ex.shows.length, 1);
    await fetch(`${BASE}/api/exclusions`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"shows":[],"genres":[]}' });
    await ctx.close();
  });
});

describe("TV set (N-12)", { skip }, () => {
  it("frames the picture, turns the dial to the channel, and the dial tunes up", async () => {
    const { page, ctx, errors } = await open({ prefs: { bezel: "wood" } });
    // The stage eases into the screen opening; wait for it to settle.
    await page.waitForFunction(`(() => { const r = document.getElementById("stage").getBoundingClientRect(); return r.left > 10 && r.right < 1500; })()`);
    await page.keyboard.press("3");
    await page.waitForFunction(`document.getElementById("bug").textContent.startsWith("3")`);
    assert.match(await js(page, `document.getElementById("tvset").style.getPropertyValue("--dial")`), /^55\.38/);
    await page.click(".tv-dial[data-dial]");
    await page.waitForFunction(`!document.getElementById("bug").textContent.startsWith("3")`);
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.waitForTimeout(450);
    assert.equal(await js(page, `getComputedStyle(document.getElementById("stage")).left`), "0px", "the set steps aside for the guide");
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
