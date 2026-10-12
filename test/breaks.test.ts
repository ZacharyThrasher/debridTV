// Station breaks are opt-in (ADR-0006): by default programs run back to back with no
// slot padding and no mid-program breaks. One station-wide switch brings both back,
// and each channel changes at the end of what's on (gate C7).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-breaks-"));
process.env.DEBRIDTV_HOME = home;

const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");
const { withoutBreaks } = await import("../app/lineup.ts");

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
const TB_KEY = "tb-test-key-0123456789abcdef";
const mock = await startMockProviders({
  files: Array.from({ length: 8 }, (_, i) => ({ ref: `tb:${100 + i}:1`, name: `Break.Test.S01E0${i + 1}.720p.mkv`, bytes: fixture.byteLength, content: fixture })),
  account: { token: TB_KEY, premiumUntilMs: Date.now() + 30 * 86_400_000, plan: "2" },
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

const get = async (p: string) => (await (await fetch(base + p)).json()) as any;
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The test show's airings over the next two hours. */
async function airings() {
  const t = Date.now();
  const g = await get(`/api/guide?from=${t}&to=${t + 2 * 3_600_000}`);
  return g.rows.find((r: any) => r.channel.name === "Break Test").airings as any[];
}
const breaksIn = (list: any[]) => list.flatMap((a) => a.segments.filter((s: any) => s.kind === "break"));

test("setup: a show on the air", async () => {
  assert.equal((await post("/api/sources", { provider: "torbox", key: TB_KEY })).status, 200);
  await post("/api/scan/start", { perMinute: 600 });
  for (let i = 0; i < 150 && (await get("/api/sources")).scan.running; i++) await sleep(100);
  for (let i = 0; i < 150 && !(await get("/api/bootstrap")).channels.some((c: any) => c.name === "Break Test"); i++) await sleep(100);
  await sleep(400); // let the debounced rebuild after the scan finish
  assert.ok((await get("/api/bootstrap")).channels.some((c: any) => c.name === "Break Test"));
});

test("ADR-0006: breaks are off by default, so programs run back to back", async () => {
  assert.equal((await get("/api/bootstrap")).breaks, false);
  assert.equal((await get("/api/station")).breaks, false);
  const list = await airings();
  assert.ok(list.length > 3, `${list.length} airings`);
  assert.deepEqual(breaksIn(list), [], "no padding and no mid-program breaks");
  for (let i = 1; i < list.length; i++) assert.equal(list[i].start, list[i - 1].end, "each starts as the last one ends");
});

test("ADR-0006: one switch turns breaks on; channels change after what's on now", async () => {
  assert.equal((await post("/api/station", { breaks: "yes" })).status, 400);
  const before = await airings();
  const r = await post("/api/station", { breaks: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.breaks, true);
  assert.equal((await get("/api/bootstrap")).breaks, true);
  const list = await airings();
  assert.equal(list[0].start, before[0].start, "what's on now isn't disturbed");
  assert.equal(list[0].end, before[0].end);
  assert.ok(breaksIn(list).some((s) => s.reason === "padding"), "later programs are padded out to the half hour");
  const exp = await (await fetch(`${base}/api/export`)).json() as any;
  assert.equal(exp.breaks, true, "the settings export carries the choice");
  assert.equal((await post("/api/station", { breaks: false })).body.breaks, false);
  const off = await airings();
  assert.deepEqual(breaksIn(off.slice(1)), [], "and off again from the next program");
});

test("withoutBreaks drops slot padding and mid-program breaks from every rule", () => {
  const rules = withoutBreaks([{ key: "a", name: "A", kind: "custom", tagline: "", itemIds: ["x"], ordering: "cyclic", slotMs: 1_800_000, midBreakMs: 90_000 }]);
  assert.equal(rules[0]!.slotMs, undefined);
  assert.equal(rules[0]!.midBreakMs, undefined);
  assert.deepEqual(rules[0]!.itemIds, ["x"]);
});
