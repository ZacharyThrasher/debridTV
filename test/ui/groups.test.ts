// Browser tests for content groups (N-07) and seasonal lineups (N-32), workstream B's
// side: the group editor, slot sources and dates in the channel editor, and how the
// guide and the off-air card show them. Runs the real server in demo mode.

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
const PORT = 8000 + (process.pid % 200);
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
  home = mkdtempSync(join(tmpdir(), "debridtv-grp-"));
  server = spawn(process.execPath, ["app/server.ts"], { env: { ...process.env, PORT: String(PORT), DEBRIDTV_HOME: home, DEBRIDTV_DEMO: "1" }, stdio: "ignore" });
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
  await page.waitForFunction("document.getElementById('bug').textContent.length > 0");
  return { page, ctx, errors };
}
const js = (page: any, expr: string) => page.evaluate(expr);
const editor = (page: any, n: number, tab = "schedule") =>
  js(page, `import("/js/channel-editor.js").then(async (m) => m.openChannelEditor((await import("/js/player.js")).tv.channels.find((c) => c.number === ${n}), { tab: ${JSON.stringify(tab)} }))`);

describe("content groups (N-07)", { skip }, () => {
  it("builds a group in order, gives it a channel, and offers it as a slot source", async () => {
    const { page, ctx, errors } = await open();
    await editor(page, 2);
    await page.waitForSelector('[aria-label="Edit channel"] [data-groups]');
    await page.click("[data-groups]");
    await page.waitForSelector('[aria-label="Content groups"] [data-new]');
    await page.click("[data-new]");
    await page.fill("#grp-name", "Saturday Morning");
    await page.fill("#grp-desc", "Cartoons until noon.");
    await page.click('[data-add-show="saturday robots"]');
    await page.fill("#grp-find", "paper");
    await page.click("[data-add-movie]");
    await page.click('[data-down="0"]'); // the film first
    assert.deepEqual(await js(page, "[...document.querySelectorAll('.grp-what b')].map((b) => b.textContent)"), ["Paper Rockets", "Saturday Robots"]);
    // The remote moves an entry too: focus stays on the arrow that was pressed.
    await page.focus('[data-up="1"]');
    await page.keyboard.press("Enter");
    assert.deepEqual(await js(page, "[...document.querySelectorAll('.grp-what b')].map((b) => b.textContent)"), ["Saturday Robots", "Paper Rockets"]);
    await page.click('[data-g="channel"]');
    await page.click("[data-save]");
    await page.waitForSelector(".grp-row");
    const g = await (await fetch(`${BASE}/api/groups`)).json();
    assert.equal(g.groups.length, 1);
    assert.deepEqual(g.groups[0].entries.map((e: any) => e.kind), ["show", "movie"]);
    assert.equal(g.groups[0].description, "Cartoons until noon.");
    await page.waitForFunction("[...document.querySelectorAll('.grp-chip em')].some((e) => e.textContent.includes('own channel'))");
    // Escape closes the groups dialog only; the slot source list now has the group.
    await page.keyboard.press("Escape");
    await page.waitForFunction("document.querySelector('[aria-label=\"Content groups\"]').hidden");
    assert.equal(await js(page, "document.querySelector('[aria-label=\"Edit channel\"]').hidden"), false);
    await page.click("[data-slot-add]");
    assert.ok(await js(page, `[...document.querySelector('[data-slot="0:source"]').options].some((o) => o.value === "group:${g.groups[0].id}")`));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("the guide names the group a program comes from", async () => {
    const { page, ctx } = await open();
    const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
    const ch = boot.channels.find((c: any) => c.kind === "group");
    assert.ok(ch, "the group channel from the previous test");
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.focus");
    for (const d of String(ch.number)) await page.keyboard.press(d);
    await page.waitForFunction("document.querySelector('.guide-details .gd-group')");
    assert.match(await js(page, "document.querySelector('.guide-details .gd-group').textContent"), /Saturday Morning · Cartoons until noon\./);
    await ctx.close();
  });

  it("Settings → Channels opens the groups, and a new channel can be built from a group", async () => {
    const { page, ctx, errors } = await open();
    await js(page, `import("/js/panel.js").then((m) => m.openPanel("channels"))`);
    await page.click("[data-content-groups]");
    await page.waitForSelector('[aria-label="Content groups"]:not([hidden]) .grp-row');
    await page.keyboard.press("Escape");
    await page.waitForFunction("document.querySelector('[aria-label=\"Content groups\"]').hidden");
    await page.click("[data-new-channel]");
    await page.waitForSelector("[data-group]");
    await page.fill("#cname", "Cartoon Block");
    await page.check("[data-group]");
    await page.click("[data-save-channel]");
    await page.waitForFunction("![...document.querySelectorAll('#panel [data-group]')].length");
    const g = await (await fetch(`${BASE}/api/groups`)).json();
    assert.ok(g.groups[0].usedBy.some((u: any) => u.how === "custom" && u.name === "Cartoon Block"));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  it("Look & feel turns the guide preview off", async () => {
    const { page, ctx } = await open();
    await js(page, `import("/js/panel.js").then((m) => m.openPanel("look"))`);
    await page.waitForSelector('[data-pref="guidePreview"]');
    assert.equal(await js(page, "document.querySelector('[data-pref=\"guidePreview\"]').checked"), true);
    await page.locator('[data-pref="guidePreview"]').setChecked(false, { force: true });
    assert.equal(await js(page, `import("/js/util.js").then((m) => m.pref("guidePreview"))`), false);
    await ctx.close();
  });
});

describe("seasonal lineups (N-32)", { skip }, () => {
  it("saves a channel season and a dated slot from the remote-friendly pickers", async () => {
    const { page, ctx } = await open();
    await editor(page, 3);
    await page.waitForSelector("#dt-season");
    await page.selectOption("#dt-season", "custom");
    await page.waitForSelector("#dt-season-from-m");
    await page.selectOption("#dt-season-from-m", "11");
    await page.selectOption("#dt-season-from-d", "25");
    await page.selectOption("#dt-season-to-m", "1");
    await page.selectOption("#dt-season-to-d", "6");
    await page.click("[data-slot-add]");
    await page.selectOption("#dt-slot-0", "10-01:10-31");
    // A remote steps a select with Left/Right (spatial.js).
    await page.focus("#dt-season-to-d");
    await page.keyboard.press("ArrowRight");
    await page.click("[data-save]");
    await page.waitForFunction("document.querySelector('[aria-label=\"Edit channel\"]').hidden");
    const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
    const ch = boot.channels.find((c: any) => c.number === 3);
    const st = await (await fetch(`${BASE}/api/channels/${ch.id}/settings`)).json();
    assert.equal(st.season.from, "11-25");
    assert.equal(st.season.to, "01-07");
    assert.deepEqual(st.slots[0].dates, { from: "10-01", to: "10-31" });
    await ctx.close();
  });

  it("an out-of-season channel says when it's back, in the guide and on the card", async () => {
    const back = Date.UTC(2026, 10, 25, 5);
    const season = { from: "11-25", to: "01-07", inSeason: false, nextChangeMs: back };
    let target = "";
    const { page, ctx } = await open((u, body) => {
      if (u.pathname === "/api/bootstrap") {
        target = body.channels[1].id;
        body.channels[1].season = season;
      }
      if (u.pathname === "/api/guide") {
        const r = body.rows.find((x: any) => x.channel.id === target);
        if (r) (r.channel.season = season), (r.airings = []);
      }
      if (u.pathname === "/api/now" && u.searchParams.get("channel") === target) return { now: body.now, channel: { ...body.channel, season }, offAir: true };
      return body;
    });
    await page.keyboard.press("g");
    await page.waitForSelector(".cell.offseason");
    assert.match(await js(page, "document.querySelector('.cell.offseason').textContent"), /Off season\s*Back November 2[45]/);
    assert.match(await js(page, "document.querySelector('.row-label .season-tag').textContent"), /Nov 25 – Jan 7/);
    await page.keyboard.press("Escape");
    await js(page, `import("/js/player.js").then((m) => m.tune(m.tv.channels.find((c) => c.id === ${JSON.stringify(target)})))`);
    await page.waitForFunction("document.querySelector('#card:not([hidden]) .card-kicker')?.textContent === 'Off season'");
    assert.match(await js(page, "document.querySelector('#card .why').textContent"), /Back on the air .*November 2[45].*from Nov 25 to Jan 7/);
    await ctx.close();
  });
});
