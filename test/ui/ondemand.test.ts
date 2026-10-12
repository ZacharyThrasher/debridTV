// Browser tests for On Demand (N-30, workstream B): Continue Watching, browse, search
// and the remote. The server's On Demand endpoints come from workstream C; until they
// ship, the page is served the mock in ondemand-mock.ts (same shapes). Demo mode, so
// no media and no provider traffic. Skips cleanly without Playwright.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeQuietly } from "./close.ts";
import { startServer } from "./serve.ts";
import { makeOnDemand, answerOnDemand } from "./ondemand-mock.ts";

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

let server: ChildProcess | null = null;
let browser: any = null;
let home = "";
let skip: string | false = chromium ? false : "Playwright isn't installed";

before(async () => {
  if (skip) return;
  try {
    browser = await chromium.launch({ executablePath: EXE, args: ["--no-proxy-server"] }).catch(() => chromium.launch({ args: ["--no-proxy-server"] }));
  } catch (e: any) {
    skip = `no browser: ${e.message.split("\n")[0]}`;
    return;
  }
  home = mkdtempSync(join(tmpdir(), "debridtv-od-"));
  ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "1" }));
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

/** A page whose On Demand endpoints answer from the mock (or 404, with `missing`). */
async function open(opts: { prefs?: object; missing?: boolean; empty?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const requests: string[] = [];
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true, ...opts.prefs }))})`);
  const mock = makeOnDemand({ empty: opts.empty });
  await ctx.route("**/*", async (route: any) => {
    const u = new URL(route.request().url());
    requests.push(u.pathname);
    const ours = u.pathname === "/api/continue" || u.pathname.startsWith("/api/ondemand");
    if (!ours) return route.continue();
    if (opts.missing) return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answerOnDemand(mock, u)) });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  // The first tune has finished (its render would hide a card or overlay opened sooner).
  await page.evaluate(`import("/js/player.js").then((m) => void (window.__tv = m.tv))`);
  await page.waitForFunction(`!!window.__tv.info && document.getElementById("bug").textContent.length > 0`);
  return { page, ctx, requests, errors, mock };
}

const js = (page: any, expr: string) => page.evaluate(expr);
const focusK = (page: any) => js(page, "document.activeElement?.dataset?.k ?? document.activeElement?.id ?? ''");
const heroTitle = (page: any) => js(page, "document.querySelector('.od-hero .od-t')?.textContent ?? ''");

describe("On Demand (N-30)", { skip }, () => {
  it("opens from the guide toolbar, lists Continue Watching first, and fetches no media", async () => {
    const { page, ctx, requests, errors, mock } = await open();
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.keyboard.press("ArrowUp"); // toolbar: Settings
    await page.keyboard.press("ArrowLeft"); // Subtitles
    await page.keyboard.press("ArrowLeft"); // On Demand
    await page.keyboard.press("Enter");
    await page.waitForSelector("#ondemand:not([hidden]) .od-card");
    assert.equal(await js(page, "document.getElementById('guide').hidden"), true);
    const want = mock.continueWatching().items.map((i) => i.id);
    const got = await js(page, "[...document.querySelectorAll('.od-rail .od-card')].map((c) => c.dataset.play)");
    assert.deepEqual(got, want);
    assert.equal(await focusK(page), `c:${want[0]}`);
    assert.equal(await heroTitle(page), mock.continueWatching().items[0]!.title);
    // Browse around: still nothing but the local library.
    for (const k of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown"]) await page.keyboard.press(k);
    assert.equal(requests.filter((p) => p.startsWith("/media") || p === "/api/prefetch" || p === "/api/watch").length, 0);
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("the remote opens a show, Back returns to its tile, and Back again closes", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("o");
    await page.waitForSelector(".od-tile");
    // Down from the rail reaches the Shows grid; walk to Harbor Lights.
    await page.keyboard.press("ArrowDown");
    assert.match(await focusK(page), /^s:/);
    const key = await js(page, "document.activeElement.dataset.show");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".od-show .od-ep");
    assert.match(await focusK(page), /^n:/, "lands on the next-up button");
    assert.match(await js(page, "document.querySelector('.od-play').textContent"), /(Resume|Play) S\d/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.match(await focusK(page), /^e:/);
    // A TV remote's Back key; spatial.js turns it into Escape for the layer.
    await js(page, `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "GoBack", bubbles: true, cancelable: true }))`);
    await page.waitForSelector(".od-tile");
    assert.equal(await js(page, "document.activeElement.dataset.show"), key);
    await page.keyboard.press("Escape");
    await page.waitForFunction("document.getElementById('ondemand').hidden");
    // The stage keys work again.
    const before = await js(page, "document.getElementById('bug').textContent");
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(`document.getElementById("bug").textContent !== ${JSON.stringify(before)}`);
    await closeQuietly(ctx);
  });

  it("season tabs switch the episode list", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("o");
    await page.click('[data-show="harbor lights"]');
    await page.waitForSelector(".od-seasons");
    const first = await js(page, "document.querySelector('.od-ep').dataset.play");
    await page.click('[data-season="2"]');
    await page.waitForFunction(`document.querySelector('.od-ep').dataset.play !== ${JSON.stringify(first)}`);
    assert.match(await js(page, "document.querySelector('.od-ep .od-ep-t span').textContent"), /^S2 · E1/);
    await closeQuietly(ctx);
  });

  it("search narrows shows, films and episodes, and Escape clears it", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("o");
    await page.waitForSelector(".od-tile");
    const all = await js(page, "document.querySelectorAll('.od-tile').length");
    await page.keyboard.press("/");
    assert.equal(await focusK(page), "od-q");
    await page.keyboard.type("pilot");
    await page.waitForFunction("[...document.querySelectorAll('.od-shelf h2')].some((h) => h.textContent.startsWith('Episodes'))");
    assert.equal(await js(page, "[...document.querySelectorAll('.od-shelf h2')].some((h) => h.textContent.startsWith('Continue'))"), false);
    assert.ok((await js(page, "document.querySelectorAll('.od-tile').length")) < all);
    await page.keyboard.press("Enter"); // to the first result
    await page.waitForFunction("/^[smx]:/.test(document.activeElement?.dataset?.k ?? '')");
    await page.keyboard.press("/");
    await page.keyboard.press("Escape");
    await page.waitForFunction(`document.querySelectorAll('.od-tile').length === ${all}`);
    await page.keyboard.type("zzzz-nothing");
    await page.waitForSelector(".od-empty");
    assert.match(await js(page, "document.querySelector('.od-empty').textContent"), /Nothing matches/);
    await closeQuietly(ctx);
  });

  it("a part-watched pick asks resume or start over", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("o");
    await page.waitForSelector(".od-card");
    await page.keyboard.press("Enter"); // first Continue Watching card has a resume point
    await page.waitForSelector(".od-sheet");
    assert.match(await js(page, "document.activeElement.textContent"), /Resume from \d+:\d\d/);
    await page.keyboard.press("ArrowRight");
    assert.match(await js(page, "document.activeElement.textContent"), /Start over/);
    await page.keyboard.press("Escape"); // closes the sheet only
    await page.waitForFunction("!document.querySelector('.od-sheet')");
    assert.equal(await js(page, "document.getElementById('ondemand').hidden"), false);
    assert.match(await focusK(page), /^c:/);
    await closeQuietly(ctx);
  });

  it("explains itself when the server has no On Demand yet, or the library is empty", async () => {
    const a = await open({ missing: true });
    await a.page.keyboard.press("o");
    await a.page.waitForSelector(".od-empty");
    assert.match(await js(a.page, "document.querySelector('.od-empty').textContent"), /isn't on this server yet/);
    await closeQuietly(a.ctx);
    const b = await open({ empty: true });
    await b.page.keyboard.press("o");
    await b.page.waitForSelector(".od-empty");
    assert.match(await js(b.page, "document.querySelector('.od-empty').textContent"), /library is empty/);
    await closeQuietly(b.ctx);
  });

  it("the banner shows file time and ON DEMAND while a pick plays", async () => {
    const { page, ctx } = await open();
    await js(page, `dispatchEvent(new CustomEvent("debridtv:ondemand", { detail: { itemId: "x", fromMs: 65000, durationMs: 1320000, get positionMs() { return 125000; } } }))`);
    await page.waitForSelector("#banner:not([hidden]) .badge.od");
    assert.match(await js(page, "document.querySelector('#banner .times').textContent"), /^2:05 \/ 22:00$/);
    assert.equal(await js(page, "!!document.querySelector('#banner .badge.live')"), false);
    await js(page, `dispatchEvent(new CustomEvent("debridtv:ondemand", { detail: null }))`);
    await page.waitForSelector("#banner:not([hidden]) .badge.live, #banner:not([hidden]) .badge.warn");
    await closeQuietly(ctx);
  });
});
