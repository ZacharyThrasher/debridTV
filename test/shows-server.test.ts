// Show identity end to end: the server files one show's many spellings under one
// name in On Demand, the channels and the guide, and the viewer's merge, split and
// rename go through /api/shows/identity. Mock providers only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-shows-"));
process.env.DEBRIDTV_HOME = home;

const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
const TB_KEY = "tb-test-key-0123456789abcdef";
const names = [
  ...[1, 2, 3].map((e) => `Dan.Da.Dan.S01E0${e}.1080p.WEB.H264-VARYG.mkv`),
  ...[4, 5, 6].map((e) => `[SubsPlease] Dandadan - 0${e} (1080p) [A1B2C3D4].mkv`),
  "[Erai-raws] Dandadan 2nd Season - 01 [1080p].mkv",
  "Kimi.ni.Todoke.S01E01.mkv",
  "From.Me.to.You.S01E02.mkv",
];
const mock = await startMockProviders({
  files: names.map((name, i) => ({ ref: `tb:${300 + i}:1`, name, bytes: fixture.byteLength, content: fixture })),
  account: { token: [TB_KEY], premiumUntilMs: Date.now() + 30 * 86400_000, plan: "2" },
});
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` }, ffmpeg: false, timers: false });
let base = "";

before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
async function post(path: string, body: unknown = {}) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("show identity: one show in On Demand, the channels and the guide; merge, split and rename stick", async () => {
  assert.equal((await post("/api/sources", { provider: "torbox", key: TB_KEY })).status, 200);
  await post("/api/scan/start", { perMinute: 120 });
  for (let t = Date.now(); Date.now() - t < 20_000 && (await get("/api/sources")).scan.running; ) await sleep(100);
  await sleep(500);

  const od = await get("/api/ondemand?kind=show");
  const dd = od.shows.find((s: any) => s.key === "dan da dan");
  assert.ok(dd, JSON.stringify(od.shows.map((s: any) => s.key)));
  assert.equal(dd.name, "Dan Da Dan");
  assert.equal(dd.episodes, 7);
  assert.deepEqual(dd.seasons, [1, 2], "the 2nd Season pack is season 2");
  assert.equal(od.shows.length, 3, "Dan Da Dan, Kimi ni Todoke, From Me to You");

  // One channel for the show, under its one name, with every episode.
  const boot = await get("/api/bootstrap");
  const ch = boot.channels.find((c: any) => c.ruleKey === "show:dan da dan");
  assert.ok(ch, JSON.stringify(boot.channels.map((c: any) => c.ruleKey)));
  assert.equal(ch.name, "Dan Da Dan");
  const now = Date.now();
  const guide = await get(`/api/guide?from=${now}&to=${now + 3 * 3600_000}`);
  const row = guide.rows.find((r: any) => r.channel.id === ch.id);
  assert.ok(row.airings.length && row.airings.every((a: any) => a.title === "Dan Da Dan"), `the guide says Dan Da Dan, not the file's spelling: ${JSON.stringify(row.airings.map((a: any) => a.title))}`);

  // What it was made from, and why.
  const g = await get("/api/shows/identity?key=dan%20da%20dan");
  assert.equal(g.members.length, 3);
  assert.deepEqual(g.members.map((m: any) => m.why ?? null).sort(), [null, null, "same name"].sort(), JSON.stringify(g.members));
  const arc = g.members.find((m: any) => m.season === 2);
  assert.ok(arc, "the 2nd Season pack is shown as season 2");

  // The viewer joins two shows nothing could tell were one.
  const m = await post("/api/shows/identity/merge", { key: "from me to you", into: "kimi ni todoke" });
  assert.equal(m.status, 200);
  assert.equal(m.body.members.length, 2);
  await sleep(500);
  assert.equal((await get("/api/ondemand?kind=show")).shows.length, 2);

  // And separates the 2nd Season pack.
  const s = await post("/api/shows/identity/split", { unit: arc.unit });
  assert.equal(s.status, 200);
  assert.equal(s.body.members.length, 1);
  assert.equal((await get("/api/ondemand?kind=show")).shows.length, 3);

  // A name of the viewer's choosing; the key stays, so channel settings stay.
  const r = await post("/api/shows/identity/rename", { key: "dan da dan", name: "DAN DA DAN" });
  assert.equal(r.body.name, "DAN DA DAN");
  const od2 = await get("/api/ondemand?kind=show");
  assert.ok(od2.shows.some((x: any) => x.key === "dan da dan" && x.name === "DAN DA DAN"));
  assert.equal((await post("/api/shows/identity/merge", { key: "nope", into: "dan da dan" })).status, 400);

  // Undo puts the automatic grouping back.
  await post("/api/shows/identity/reset", { key: "dan da dan" });
  const back = await get("/api/shows/identity?key=dan%20da%20dan");
  assert.equal(back.members.length, 3);
  assert.equal(back.name, "Dan Da Dan");
});
