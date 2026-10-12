// The Windows app runs with DEBRIDTV_DEMO=0: no made-up channels. With nothing
// connected the page shows the setup steps instead of a dark screen. Skips without
// Playwright.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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

let server: ChildProcess | null = null;
let browser: any = null;
let base = "";
const home = mkdtempSync(join(tmpdir(), "debridtv-setup-"));

describe("first run without demo channels", { skip: !chromium ? "Playwright isn't installed" : false }, () => {
  before(async () => {
    ({ server, base } = await startServer({ DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "0" }));
    browser = await chromium.launch({ executablePath: EXE });
  });
  after(async () => {
    await browser?.close();
    server?.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it("serves no demo content", async () => {
    const b = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(b.demo, false);
    assert.deepEqual(b.channels, []);
    const od = await (await fetch(`${base}/api/ondemand`)).json();
    assert.equal(od.shows.length + od.movies.length, 0);
  });

  it("shows the setup steps, and the button opens Sources", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.waitForSelector(".setup-card", { state: "visible" });
    assert.match(await page.textContent(".setup-card h1"), /Put your library on the air/);
    assert.equal(await page.locator(".setup-steps li.now").textContent(), "Connect a source");
    await page.click(".setup-card [data-sources]");
    await page.waitForSelector('[data-tab="sources"][aria-selected="true"], .panel:not([hidden])');
    assert.ok(await page.locator("#key-torbox").isVisible());
    await page.close();
  });
});
