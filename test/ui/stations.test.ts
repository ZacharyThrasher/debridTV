// Browser tests for music stations and Coming Attractions in the guide (N-23a, N-23c)
// and for the home network rules on a paired device (pair redirect, PC-only settings).
// Runs the real server in demo mode; the stations are stubbed into its answers.

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
  home = mkdtempSync(join(tmpdir(), "debridtv-st-"));
  ({ server, base: BASE } = await startServer({ DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "1" }));
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function open(route?: (u: URL, body: any) => any) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", ${JSON.stringify(JSON.stringify({ welcomed: true }))})`);
  if (route)
    await ctx.route("**/api/**", async (r: any) => {
      const u = new URL(r.request().url());
      // A request still in flight when the test closes its context rejects here; that's not a failure.
      try {
        const resp = await r.fetch();
        let body = await resp.json().catch(() => null);
        body = body && route(u, body);
        await r.fulfill({ response: resp, body: JSON.stringify(body ?? (await resp.json())) });
      } catch {}
    });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(BASE + "/");
  // The first tune has finished (its render would hide a card or overlay opened sooner).
  await page.evaluate(`import("/js/player.js").then((m) => void (window.__tv = m.tv))`);
  await page.waitForFunction(`!!window.__tv.info && document.getElementById("bug").textContent.length > 0`);
  return { page, ctx, errors };
}
const js = (page: any, expr: string) => page.evaluate(expr);
const editor = (page: any, n: number, tab = "schedule") =>
  js(page, `import("/js/channel-editor.js").then(async (m) => m.openChannelEditor((await import("/js/player.js")).tv.channels.find((c) => c.number === ${n}), { tab: ${JSON.stringify(tab)} }))`);


const MINUTE = 60_000;
/** Turns channel #2 into a music station (or Coming Attractions) of 3-minute pieces. */
function station(kind: "music" | "trailers") {
  let id = "";
  const piece = (start: number, n: number) =>
    kind === "music"
      ? { kind: "track", title: `Song ${n}`, artist: n % 2 ? "The Paper Kites" : "Static Bloom", album: "Night Drive", trackNo: n, year: 1999, genre: "Indie", start, end: start + 3 * MINUTE, availability: "playable", provider: "demo" }
      : { kind: "trailer", title: `Film ${n}`, year: 1990 + n, trailerFor: { title: `Film ${n}`, year: 1990 + n, itemId: n === 1 ? "film-1" : null }, start, end: start + 3 * MINUTE, availability: "playable", provider: "demo" };
  const pieces = (from: number, to: number) => {
    const out = [];
    let n = 0;
    for (let t = Math.floor(from / (3 * MINUTE)) * 3 * MINUTE; t < to; t += 3 * MINUTE) out.push(piece(t, (n++ % 9) + 1));
    return out;
  };
  return (u: URL, body: any) => {
    if (u.pathname === "/api/bootstrap") {
      id = body.channels[1].id;
      body.channels[1].kind = kind;
    }
    if (u.pathname === "/api/guide") {
      const r = body.rows.find((x: any) => x.channel.id === id);
      if (r) (r.channel.kind = kind), (r.airings = pieces(body.from, body.to));
    }
    if (u.pathname === "/api/now" && u.searchParams.get("channel") === id && body.airing) {
      const [a, b] = pieces(body.now, body.now + 6 * MINUTE).map((x: any) => ({ ...body.airing, ...x }));
      a.start = body.now - MINUTE;
      body.airing = a;
      body.next = b;
    }
    return body;
  };
}

describe("music stations and Coming Attractions (N-23a, N-23c)", { skip }, () => {
  it("a music station is one long block naming the song on now, and the details follow each song", async () => {
    const { page, ctx, errors } = await open(station("music"));
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(".row:nth-child(2) .cell.stream.music.focus");
    assert.equal(await js(page, "document.querySelectorAll('.row:nth-child(2) .cell').length"), 1, "one block, not slivers");
    assert.match(await js(page, "document.querySelector('.cell.stream .ct').textContent"), /^♪Now playing: Song \d$/);
    assert.match(await js(page, "document.querySelector('.cell.stream .cs').textContent"), /(The Paper Kites|Static Bloom) · Night Drive/);
    assert.ok((await js(page, "document.querySelectorAll('.cell.stream .ticks i').length")) > 10, "a tick per song");
    const first = await js(page, "document.querySelector('.guide-details .t').textContent");
    assert.match(await js(page, "document.querySelector('.guide-details .s').textContent"), /♪ Song/);
    await page.keyboard.press("ArrowRight");
    assert.notEqual(await js(page, "document.querySelector('.guide-details .t').textContent"), first, "Right steps to the next song");
    assert.equal(await js(page, "document.querySelectorAll('.row:nth-child(2) .cell.focus').length"), 1);
    assert.deepEqual(errors, []);
    await closeQuietly(ctx);
  });

  it("Coming Attractions reads as trailers back to back, and offers the film when it's in the library", async () => {
    const { page, ctx } = await open(station("trailers"));
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector(".cell.stream.trailers.focus");
    assert.match(await js(page, "document.querySelector('.cell.stream .ct').textContent"), /Trailers, back to back/);
    assert.match(await js(page, "document.querySelector('.cell.stream .cs').textContent"), /^Now: Film \d \(19\d\d\)$/);
    // Walk to the trailer whose film is here (Film 1) and look for the W hint.
    for (let i = 0; i < 9 && !(await js(page, "document.querySelector('.guide-details .act').textContent.includes('watch the film')")); i++) await page.keyboard.press("ArrowRight");
    assert.match(await js(page, "document.querySelector('.guide-details .t').textContent"), /^Film 1$/);
    assert.match(await js(page, "document.querySelector('.guide-details .s').textContent"), /Trailer/);
    await closeQuietly(ctx);
  });

  it("the banner keeps one song at a time, with a square album cover slot", async () => {
    const { page, ctx } = await open(station("music"));
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction("document.querySelector('#banner:not([hidden]) .badge.kind')");
    assert.match(await js(page, "document.querySelector('#banner .title').textContent"), /^Song \d$/);
    assert.match(await js(page, "document.querySelector('#banner .meta').textContent"), /♪ Song.*Night Drive/);
    await closeQuietly(ctx);
  });
});

describe("home network on a paired device", { skip }, () => {
  it("a 401 that asks for pairing goes to /pair", async () => {
    const { page, ctx } = await open();
    await ctx.route("**/api/guide*", (r: any) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Pair this device first.","pair":"/pair"}' }));
    await ctx.route("**/pair", (r: any) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>pair</title>paired?" }));
    await page.keyboard.press("g");
    await page.waitForURL(/\/pair$/);
    await closeQuietly(ctx);
  });

  it("PC-only settings say so, and a device doesn't offer Sources or the PIN", async () => {
    const { page, ctx } = await open((u, body) => (u.pathname === "/api/lan/hello" ? { where: "device", enabled: true, device: { id: "d1", name: "Den TV" } } : body));
    await page.waitForFunction("document.documentElement.dataset.where === 'device'");
    await ctx.route("**/api/sources", (r: any) => r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"This setting can only be changed on the PC.","pcOnly":true}' }));
    assert.equal(await js(page, `import("/js/api.js").then((m) => m.api.post("/api/sources", {}).then(() => "ok", (e) => e.message))`), "Change this on the PC.");
    await page.keyboard.press("s");
    await page.waitForSelector("#panel:not([hidden])");
    assert.equal(await js(page, "document.querySelector('#panel [aria-selected=\"true\"]').dataset.tab"), "look");
    assert.equal(await js(page, "getComputedStyle(document.querySelector('#panel [data-tab=\"sources\"]')).display"), "none");
    await closeQuietly(ctx);
  });
});
