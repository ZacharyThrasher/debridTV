// Browser test: On Demand in demo mode (N-30). Demo files have no media, so the
// picture is painted from the file position: no /media request may be made, and
// seeking, pausing, history and the return to live must still work.
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
const PORT = 7800 + (process.pid % 150);
const BASE = `http://127.0.0.1:${PORT}`;
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
  home = mkdtempSync(join(tmpdir(), "debridtv-oddemo-"));
  server = spawn(process.execPath, ["app/server.ts"], { env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/bootstrap`)).ok) break;
    } catch {}
    await sleep(100);
  }
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("On Demand in demo mode", () => {
  it("paints the picture from the file position, seeks, pauses and returns to live, with no media requests", async (t) => {
    if (skip) return t.skip(skip);
    const od = await (await fetch(`${BASE}/api/ondemand`)).json();
    const item = od.shows?.[0]?.nextUp;
    if (!item) return t.skip("this server has no On Demand listing");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(`localStorage.setItem("debridtv.prefs", JSON.stringify({ welcomed: true }))`);
    const page = await ctx.newPage();
    const media: string[] = [];
    const watches: any[] = [];
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("request", (r: any) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/media/")) media.push(u.pathname);
      if (u.pathname === "/api/watch") watches.push(JSON.parse(r.postData()));
    });
    await page.goto(BASE + "/");
    // The station is up (a live demo channel may be in a break, so don't wait for its picture).
    await page.waitForFunction(() => !!document.getElementById("bug") && !document.getElementById("bug")!.hidden, null, { timeout: 20_000 });
    await page.evaluate(() => {
      (window as any).odEvents = [];
      addEventListener("debridtv:ondemand", (e: any) => (window as any).odEvents.push(e.detail && e.detail.fromMs));
    });
    const P = (fn: string, ...args: unknown[]) =>
      page.evaluate(async ([fn, args]: [string, unknown[]]) => (await import(location.origin + "/js/player.js") as any)[fn](...args), [fn, args]);
    const pos = () => page.evaluate(async () => (await import(location.origin + "/js/player.js") as any).tv.onDemand?.positionMs ?? null);

    await P("playOnDemand", item.id, { fromMs: 60_000, item });
    await sleep(1500);
    let p = await pos();
    assert.ok(p >= 60_000 && p < 63_000, `starts at 60 s (at ${p})`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("synth")!).display), "block", "the painted picture shows");

    await P("seekBy", 30_000);
    p = await pos();
    await sleep(1200);
    assert.ok(p >= 91_500 && p < 94_000, `seeks 30 s ahead to about 91.5 s (at ${p})`);

    await page.keyboard.press(" ");
    const held = await pos();
    await sleep(1200);
    assert.equal(await pos(), held, "pause holds the position");
    await page.keyboard.press(" ");
    await sleep(1500);
    assert.ok((await pos()) > held, "resume continues from there");

    await P("playOnDemand", item.id, { fromMs: item.durationMs, item });
    await page.waitForFunction(() => (window as any).odEvents.at(-1) === null, null, { timeout: 15_000 });
    assert.equal(await pos(), null, "back to live at the end of the file");

    assert.deepEqual(media, [], "demo files never ask for media");
    const spans = watches.filter((w) => w.channel === "ondemand");
    assert.ok(spans.length >= 2 && spans.every((w) => w.itemId === item.id), `On Demand spans: ${JSON.stringify(watches)}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
