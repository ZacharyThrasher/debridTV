// Browser tests for the guide, station breaks and remote (workstream B).
// Runs the real app in demo mode (no media, no provider traffic) in Chromium.
// Skips cleanly when Playwright or its browser isn't installed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "1" }));
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
  // With a fake clock the page runs ahead of this process by every advance() so far.
  // The server's times are moved by the same amount, or each clock sync (every
  // /api/now) would pull the app's clock back by that much and stall what runs on it.
  let ahead = 0;
  const requests: string[] = [];
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, ...opts.prefs }))})`);
  await ctx.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    requests.push(u.pathname);
    if ((!offset && !opts.fakeClock) || !u.pathname.startsWith("/api/")) return route.continue();
    if (u.pathname === "/api/now" && !u.searchParams.has("at")) u.searchParams.set("at", String(Date.now() + offset + ahead));
    // A request still in flight when the test closes its context rejects here; that's not a failure.
    try {
      const resp = await route.fetch({ url: u.toString() });
      let body = await resp.text();
      try {
        const o = JSON.parse(body);
        if (typeof o.now === "number") o.now += offset + ahead;
        body = JSON.stringify(o);
      } catch {}
      await route.fulfill({ response: resp, body });
    } catch {}
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  if (opts.fakeClock) await page.clock.install();
  await page.goto(BASE + "/");
  // The first tune has finished (its render would hide a card or overlay opened sooner).
  await page.evaluate(`import("/js/player.js").then((m) => void (window.__tv = m.tv))`);
  await page.waitForFunction(`!!window.__tv.info && document.getElementById("bug").textContent.length > 0`);
  /** Move the page's fake clock (fakeClock only), keeping the server's times in step. */
  const advance = async (ms: number) => {
    ahead += ms;
    await page.clock.runFor(ms);
  };
  return { page, ctx, requests, errors, advance };
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
    await closeQuietly(ctx);
  });

  it("N-15: page size and scroll speed are settings; Channel Up/Down turn a page", async () => {
    const remote = (page: any, key: string) => js(page, `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "${key}", bubbles: true, cancelable: true }))`);
    const focusRow = (page: any) => js(page, `[...document.querySelectorAll(".row")].findIndex((r) => r.querySelector(".cell.focus"))`);
    const { page, ctx, errors } = await open({ prefs: { guidePage: "3", guideScroll: "instant" } });
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    assert.equal(await js(page, `getComputedStyle(document.querySelector(".grid-scroll")).transitionDuration`), "0s");
    const r0 = await focusRow(page);
    await page.keyboard.press("PageDown");
    assert.equal((await focusRow(page)) - r0, 3);
    await remote(page, "ChannelUp");
    assert.equal(await focusRow(page), r0);
    await closeQuietly(ctx);

    const b = await open({ prefs: { guidePage: "screen", guideScroll: "slow" } });
    await b.page.keyboard.press("g");
    await b.page.waitForSelector(".cell.focus");
    assert.equal(await js(b.page, `getComputedStyle(document.querySelector(".grid-scroll")).transitionDuration`), "0.6s");
    const onScreen = await js(b.page, `Math.round(document.querySelector(".grid-rows").clientHeight / document.querySelector(".row").getBoundingClientRect().height)`);
    const total = await js(b.page, `document.querySelectorAll(".row").length`);
    const s0 = await focusRow(b.page);
    await remote(b.page, "ChannelDown");
    assert.equal(await focusRow(b.page), Math.min(total - 1, s0 + onScreen - 1), "a full screen, keeping one row for context");
    assert.deepEqual([...errors, ...b.errors], []);
    await closeQuietly(b.ctx);
  });

  it("previews the highlighted channel from the station clock only (N-14), never media", async () => {
    const { page, ctx, requests } = await open();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    const before = requests.length;
    const bug = await js(page, `document.getElementById("bug").textContent`);
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(".gp-slate:not([hidden])");
    const want = await js(page, `document.querySelector(".guide-details .t").textContent`);
    assert.equal(await js(page, `document.querySelector(".gp-slate .gp-t").textContent`), want);
    assert.match(await js(page, `document.querySelector(".guide-preview .preview-label").textContent`), /Preview/);
    // Run past several rows: still no link, media or tune, and the picture stays put.
    for (const k of ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowRight", "ArrowUp"]) await page.keyboard.press(k);
    await sleep(400);
    const after = requests.slice(before);
    assert.equal(after.filter((p) => p.startsWith("/media") || p === "/api/prefetch" || p === "/api/now").length, 0, after.join(" "));
    assert.equal(await js(page, `document.getElementById("bug").textContent`), bug);
    // Back on the channel being watched, the real picture shows again.
    await page.keyboard.press("Home");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(`document.querySelector(".row.current .cell.focus") ? document.querySelector(".gp-slate").hidden : true`);
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
  });

  it("starts on the guide and closes itself when idle, if set to", async () => {
    const { page, ctx } = await open({ prefs: { startup: "guide", guideIdle: "close", guideIdleMin: 0.03 } });
    await page.waitForFunction(`!document.getElementById("guide").hidden`);
    await page.waitForFunction(`document.getElementById("guide").hidden`, null, { timeout: 5000 });
    await closeQuietly(ctx);
  });
});

const station = (breaks: boolean) =>
  fetch(`${BASE}/api/station`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ breaks }) });

describe("station breaks", { skip }, () => {
  // Breaks are opt-in (ADR-0006); these tests turn them on and back off.
  before(async () => void (await station(true)));
  after(async () => void (await station(false)));
  it("a long break rotates through what's on, from the local clock only", async () => {
    const brk = await findLongBreak();
    assert.ok(brk, "demo lineup should have a long break in the next 12 hours");
    const { page, ctx, requests, errors, advance } = await open({ at: brk.at, prefs: { startup: "last" }, fakeClock: true });
    await js(page, `localStorage.setItem("debridtv.lastChannel", ${JSON.stringify(brk.ch.id)})`);
    await page.reload();
    await page.waitForSelector(".card.brk .brk-hero");
    assert.match(await js(page, `document.querySelector(".brk-label").textContent`), /Up next/);
    // Every slide that goes up is recorded, so a busy machine that lets the clock run
    // on between samples can't skip one unseen.
    await js(page, `(() => {
      window.__slides = [];
      const card = document.getElementById("card");
      new MutationObserver(() => window.__slides.push(card.querySelector(".brk-stage .brk-label")?.textContent ?? "")).observe(card, { childList: true, subtree: true });
    })()`);
    for (let i = 0; i < 5; i++) await advance(10_500);
    const seen = new Set<string>(await js(page, `window.__slides`));
    assert.ok([...seen].some((s) => /On now elsewhere/.test(s)), `slides seen: ${[...seen].join(" | ")}`);
    assert.ok([...seen].some((s) => /^Later on/.test(s)));
    assert.equal(requests.filter((p) => p.startsWith("/media") || p === "/api/prefetch").length, 0);
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
  });
});

describe("artwork (N-01c)", { skip }, () => {
  it("uses local art only, never for locked airings, and drops a picture that won't load", async () => {
    const { page, ctx, errors } = await open();
    const out = await js(page, `import("/js/ui.js").then((m) => [
      m.artOf({ art: { poster: "/api/art/x/poster" } }, "thumb", "poster"),
      m.artOf({ itemId: null, locked: true, title: "Locked", art: { poster: "/api/art/x/poster" } }, "poster"),
      m.artOf({ art: { poster: "https://example.com/p.jpg" } }, "poster"),
      m.artOf({}, "poster"),
    ])`);
    assert.deepEqual(out, ["/api/art/x/poster", null, null, null]);
    await js(page, `import("/js/ui.js").then((m) => {
      const box = Object.assign(document.createElement("div"), { className: "has-art", id: "artbox" });
      box.setAttribute("data-art-box", "");
      box.innerHTML = m.artImg("/api/art/no-such-item/poster", "x").html;
      document.body.append(box);
    })`);
    await page.waitForFunction(`!document.querySelector("#artbox img") && !document.getElementById("artbox").classList.contains("has-art")`);
    assert.deepEqual(errors.filter((e: string) => !/404|Failed to load/.test(e)), []);
    await closeQuietly(ctx);
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
    await page.waitForFunction(`document.querySelector('.ced[aria-label="Edit channel"]').hidden`);
    const s = await (await fetch(`${BASE}/api/channels/${id}/settings`)).json();
    assert.equal(s.weights[first], 0);
    assert.deepEqual(s.exclude.genres, [genre]);
    assert.equal(s.balance, "time");
    assert.equal(s.watched, "unwatched");
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
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
    await page.waitForFunction(`document.querySelector('[aria-label="Keep off every channel"]').hidden`);
    const ex = await (await fetch(`${BASE}/api/exclusions`)).json();
    assert.deepEqual(ex.genres, [genre]);
    assert.equal(ex.shows.length, 1);
    await fetch(`${BASE}/api/exclusions`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"shows":[],"genres":[]}' });
    await closeQuietly(ctx);
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
    await closeQuietly(ctx);
  });
});

describe("locked channels (N-06b)", { skip }, () => {
  /** Channel 7 locked by stubbing the server's lock fields; PIN 1984. */
  async function lockedPage() {
    const o = await open();
    const unlocks: string[] = [];
    await o.ctx.route("**/api/**", async (route: any) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/api/lock") return route.fulfill({ json: { pinSet: true, unlockedUntil: null } });
      if (u.pathname === "/api/lock/unlock") {
        const pin = JSON.parse(route.request().postData() || "{}").pin;
        unlocks.push(pin);
        return pin === "1984" ? route.fulfill({ json: { ok: true, untilMs: Date.now() + 3600e3 } }) : route.fulfill({ status: 403, json: { error: "wrong pin" } });
      }
      // A request still in flight when the test closes its context rejects here; that's not a failure.
      try {
        const resp = await route.fetch();
        let body = await resp.text();
        try {
          const j = JSON.parse(body);
          const mark = (c: any) => c && c.number === 7 && (c.locked = true);
          j.channels?.forEach(mark);
          j.rows?.forEach((r: any) => mark(r.channel));
          mark(j.channel);
          if (u.pathname === "/api/now" && j.channel?.number === 7) j.locked = true;
          body = JSON.stringify(j);
        } catch {}
        await route.fulfill({ response: resp, body });
      } catch {}
    });
    await o.page.reload();
    // The first tune has finished (its render would hide a card or overlay opened sooner).
    await o.page.evaluate(`import("/js/player.js").then((m) => void (window.__tv = m.tv))`);
    await o.page.waitForFunction(`!!window.__tv.info && document.getElementById("bug").textContent.length > 0`);
    return { ...o, unlocks };
  }

  it("scrambles the channel, fetches no media, and unlocks with the PIN", async () => {
    const { page, ctx, requests, unlocks, errors } = await lockedPage();
    const before = requests.length;
    await page.keyboard.press("7");
    await page.waitForSelector(".card.locked .lock-pad");
    assert.ok(await js(page, `document.querySelector("canvas.scramble").width === 320`));
    for (const k of ["1", "2", "3", "4", "Enter"]) await page.keyboard.press(k);
    await page.waitForFunction(`document.querySelector("[data-pinmsg]").textContent === "Wrong PIN."`);
    assert.ok(await js(page, `document.getElementById("bug").textContent.startsWith("7")`), "digits go to the PIN pad, not channel entry");
    for (const k of ["1", "9", "8", "4"]) await page.click(`[data-pin="${k}"]`);
    await page.click('[data-pin="OK"]');
    await page.waitForFunction(`!document.querySelector(".card.locked:not([hidden])")`);
    assert.deepEqual(unlocks, ["1234", "1984"]);
    const media = requests.slice(before).filter((p) => p.startsWith("/media") || p === "/api/prefetch");
    assert.deepEqual(media, []);
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("hides a locked channel's listings in the guide and banner", async () => {
    const { page, ctx } = await lockedPage();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    assert.ok(await js(page, `(() => { const r = [...document.querySelectorAll(".row")].find((r) => r.querySelector(".n").textContent === "7"); return [...r.querySelectorAll(".cell .ct")].every((c) => c.textContent === "Locked") && !!r.querySelector(".lk"); })()`));
    await closeQuietly(ctx);
  });
});

describe("remote (10-foot)", { skip }, () => {
  const focused = (page: any) => js(page, `(() => { const e = document.activeElement; return e === document.body ? "" : (e.dataset.tab ?? e.dataset.gt ?? e.dataset.prefSelect ?? e.dataset.pref ?? e.textContent.trim()); })()`);

  it("reaches settings with arrows and OK only, keeps its place across redraws, and Back closes", async () => {
    const { page, ctx, errors } = await open({ prefs: { tv: "on" } });
    assert.ok(await js(page, `document.documentElement.classList.contains("tv")`));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".cell.focus");
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowUp");
    assert.equal(await focused(page), "settings", "Up from the top row lands on the guide's Settings button");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#panel:not([hidden])");
    assert.equal(await focused(page), "sources", "the open tab has focus");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.waitForSelector('[data-pref-select="tv"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(page), "tv");
    // Left/Right step a select's choices.
    await page.keyboard.press("ArrowRight");
    assert.equal(await js(page, `JSON.parse(localStorage.getItem("debridtv.prefs")).tv`), "off");
    await page.keyboard.press("ArrowLeft");
    // A redraw keeps the remote on the same control.
    await js(page, `import("/js/panel.js").then((m) => m.openPanel("look"))`);
    await page.waitForTimeout(300);
    assert.equal(await focused(page), "tv");
    await page.keyboard.press("Backspace");
    assert.ok(await js(page, `document.getElementById("panel").hidden`), "Backspace means Back inside a layer");
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("TV Back keys close the top layer only, and digits jump the guide", async () => {
    const { page, ctx } = await open({ prefs: { tv: "on" } });
    await page.keyboard.press("s");
    await page.waitForSelector("#panel:not([hidden])");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(`document.querySelector('[data-tab="channels"]').getAttribute("aria-selected") === "true"`);
    await page.waitForSelector("[data-edit-channel]");
    await page.focus("[data-edit-channel]");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ced:not([hidden]) .ced-sheet");
    const back = () => js(page, `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "GoBack", bubbles: true, cancelable: true }))`);
    assert.equal(await js(page, `document.activeElement.id`), "ced-name");
    await back();
    assert.ok(await js(page, `!document.querySelector('.ced[aria-label="Edit channel"]').hidden && document.activeElement === document.body`), "Back first leaves the text field");
    await back();
    assert.ok(await js(page, `document.querySelector('.ced[aria-label="Edit channel"]').hidden && !document.getElementById("panel").hidden`), "Back closes the editor, not settings");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".cell.focus");
    const want = await js(page, `[...document.querySelectorAll(".row-label .n")].map((n) => n.textContent).find((n) => n.length === 1 && n !== document.querySelector(".cell.focus").closest(".row").querySelector(".n").textContent)`);
    await page.keyboard.press(want);
    await page.waitForFunction(`document.querySelector(".cell.focus").closest(".row").querySelector(".n").textContent === ${JSON.stringify(want)}`);
    await closeQuietly(ctx);
  });

  it("a remote reaches the meanwhile chips on a dead-end card and tunes with OK", async () => {
    const { page, ctx } = await open({ prefs: { tv: "on" } });
    await js(page, `import("/js/cards.js").then((m) => m.unavailableCard({ id: "x", number: 99, name: "Test", hue: 200 }, { title: "Gone", start: Date.now() - 60000, end: Date.now() + 600000 }, { reason: "Removed." }))`);
    await page.waitForSelector(".chip[data-ch]");
    await page.keyboard.press("ArrowRight");
    const id = await js(page, `document.activeElement.dataset.ch`);
    assert.ok(id, "Right focuses the first chip");
    await page.keyboard.press("Enter");
    await page.waitForFunction(`localStorage.getItem("debridtv.lastChannel") === ${JSON.stringify(id)}`);
    await closeQuietly(ctx);
  });
});
