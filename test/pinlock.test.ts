// Parental PIN and locked channels (N-06b): the PIN is only a salted hash, wrong
// guesses slow down (and stay slowed across a restart), and a locked channel's
// programs cost zero bytes and zero provider calls until the PIN is entered.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-lock-"));
process.env.DEBRIDTV_HOME = home;

const { PinLock, UNLOCK_MS, FREE_TRIES } = await import("../app/pinlock.ts");
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
const TB_KEY = "tb-test-key-0123456789abcdef";
const show = (name: string, at: number) => Array.from({ length: 8 }, (_, i) => ({
  ref: `tb:${at + i}:1`, name: `${name}.S01E0${i + 1}.720p.mkv`, bytes: fixture.byteLength, content: fixture,
}));
const mock = await startMockProviders({
  files: [...show("Late.Night.Show", 100), ...show("Morning.Show", 200)],
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

async function get(path: string) {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
async function post(path: string, body: unknown = {}) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, ms = 15_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error("timed out");
}

test("PinLock: hash only, wrong guesses slow down and the wait survives a restart", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const a = new PinLock(clock);
  assert.equal((await a.setPin(undefined, "12")).ok, false, "too short");
  assert.equal((await a.setPin(undefined, "12a4")).ok, false, "digits only");
  const set = await a.setPin(undefined, "4821");
  assert.ok(set.ok && set.untilMs === now + UNLOCK_MS, "whoever sets it is unlocked");
  const onDisk = readFileSync(join(home, "lock.json"), "utf8");
  assert.doesNotMatch(onDisk, /4821/);
  a.lock();
  assert.equal(a.isUnlocked(), false);
  // Changing needs the old PIN.
  assert.equal((await a.setPin("0000", "1111")).ok, false);
  for (let i = 1; i < FREE_TRIES; i++) assert.equal((await a.unlock("9999")).ok, false);
  const nth = await a.unlock("9999");
  assert.ok(!nth.ok && nth.status === 403 && nth.retryAfterMs === 30_000, JSON.stringify(nth));
  const early = await a.unlock("4821");
  assert.ok(!early.ok && early.status === 429, "even the right PIN waits");
  // A restart keeps the wait but not the unlock.
  const b = new PinLock(clock);
  assert.equal((await b.unlock("4821")).ok === false && b.status().retryAfterMs! > 0, true);
  now += 30_000;
  const again = await b.unlock("9999");
  assert.ok(!again.ok && again.retryAfterMs === 60_000, "the wait doubles");
  now += 60_000;
  const ok = await b.unlock("4821");
  assert.ok(ok.ok && ok.untilMs === now + UNLOCK_MS);
  assert.equal(b.status().retryAfterMs, undefined, "a right PIN clears the count");
  now += UNLOCK_MS;
  assert.equal(b.isUnlocked(), false, "four hours, then locked again");
  assert.equal(new PinLock(clock).isUnlocked(), false);
  // Removing it needs the PIN too.
  assert.equal((await b.setPin("0000", null)).ok, false);
  assert.equal((await b.setPin("4821", null)).ok, true);
  assert.equal(b.pinSet(), false);
});

let late: any;
let lateItem = "";

test("setup: two shows on the air", async () => {
  assert.equal((await post("/api/sources", { provider: "torbox", key: TB_KEY })).status, 200);
  await post("/api/scan/start", { perMinute: 120 });
  await until(async () => !(await get("/api/sources")).body.scan.running);
  await until(async () => (await get("/api/bootstrap")).body.demo === false);
  const chans = (await get("/api/bootstrap")).body.channels;
  late = chans.find((c: any) => c.name === "Late Night Show");
  assert.ok(late, JSON.stringify(chans.map((c: any) => c.name)));
  assert.equal(late.locked, false);
  assert.equal(late.unlocked, false);
  lateItem = (await get(`/api/now?channel=${late.id}`)).body.airing.itemId;
  assert.ok(lateItem);
});

test("N-06b: a channel can't be locked before a PIN exists", async () => {
  const r = await post(`/api/channels/${late.id}/settings`, { locked: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.pinRequired, true);
  assert.equal((await get("/api/lock")).body.pinSet, false);
});

test("N-06b: a locked channel costs zero bytes and zero calls until the PIN is entered", async () => {
  assert.equal((await post("/api/lock/pin", { pin: "4821" })).status, 200);
  const r = await post(`/api/channels/${late.id}/settings`, { locked: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, true);
  assert.equal(r.body.unlocked, true, "whoever just set the PIN can still watch");
  // The mix channel airs these episodes too; the settings say so, and the viewer locks it as well.
  assert.ok(r.body.alsoOn.length >= 1, JSON.stringify(r.body.alsoOn));
  assert.ok(r.body.alsoOn.every((o: any) => o.programs > 0 && o.name));
  for (const o of r.body.alsoOn) assert.equal((await post(`/api/channels/${o.id}/settings`, { locked: true })).status, 200);
  assert.deepEqual((await get(`/api/channels/${late.id}/settings`)).body.alsoOn, []);
  assert.equal((await post("/api/lock/lock")).body.unlocked, false);

  const now = (await get(`/api/now?channel=${late.id}`)).body;
  assert.equal(now.channel.locked, true);
  assert.equal(now.channel.unlocked, false);
  // Nothing says what is on: the grid keeps its times, the name and number stay.
  assert.equal(now.locked, true);
  assert.equal(now.channel.name, "Late Night Show");
  assert.equal(now.airing.title, "Locked");
  assert.equal(now.airing.itemId, null);
  assert.equal(now.fileOffsetMs, null);
  assert.equal(now.segment.fileFrom, undefined);
  assert.ok(now.airing.end > now.airing.start);
  assert.doesNotMatch(JSON.stringify(now), new RegExp(`${lateItem}|S01|Late\\.Night|"episode"|description|codecs`, "i"));
  const guide = (await get("/api/guide")).body.rows.find((r: any) => r.channel.id === late.id);
  assert.ok(guide.airings.length > 0 && guide.airings.every((a: any) => a.locked && a.title === "Locked" && a.itemId === null));
  assert.equal((await get(`/api/item?id=${lateItem}`)).status, 403);
  assert.equal((await get("/api/bootstrap")).body.channels.find((c: any) => c.id === late.id).locked, true);

  mock.reset();
  const bytes = mock.counters.mediaBytes;
  const media = await fetch(`${base}/media/${lateItem}`, { headers: { range: "bytes=0-999" } });
  assert.equal(media.status, 403);
  const mb = (await media.json()) as any;
  assert.equal(mb.locked, true);
  assert.equal(mb.final, true);
  assert.equal((await fetch(`${base}/media/${lateItem}?internal=1`)).status, 403, "the internal path is no way around it");
  assert.equal((await fetch(`${base}/media/${lateItem}/live?start=10`)).status, 403);
  assert.equal((await post("/api/prefetch", { itemId: lateItem })).status, 403);
  assert.equal(mock.counters.mediaBytes, bytes);
  assert.deepEqual(mock.counters.api, {});

  // Programs that only unlocked channels carry play as usual.
  const morning = (await get("/api/bootstrap")).body.channels.find((c: any) => c.name === "Morning Show");
  const mItem = (await get(`/api/now?channel=${morning.id}`)).body.airing.itemId;
  assert.equal((await fetch(`${base}/media/${mItem}`, { headers: { range: "bytes=0-99" } })).status, 206);
});

test("N-06b: while locked, changes that decide what airs need the PIN", async () => {
  const s = (path: string, b: unknown) => post(path, b).then((r) => r.status);
  assert.equal(await s(`/api/channels/${late.id}/settings`, { locked: false }), 403);
  assert.equal(await s(`/api/channels/${late.id}/settings`, { kid: false }), 403);
  const morning = (await get("/api/bootstrap")).body.channels.find((c: any) => c.name === "Morning Show");
  assert.equal(await s(`/api/channels/${morning.id}/settings`, { name: "Sneaky" }), 403);
  assert.equal(await s(`/api/channels/${late.id}/settings`, { favorite: true }), 200, "a favorite star is harmless");
  assert.equal(await s(`/api/channels/${morning.id}/settings`, { locked: true }), 200, "locking more is always allowed");
  assert.equal(await s("/api/channels/custom", { name: "Copy", showKeys: ["late night show"], movieIds: [] }), 403);
  assert.equal(await s("/api/ratings", { showKey: "late night show", rating: "G" }), 403);
  assert.equal(await s("/api/import", { lineup: { settings: {} } }), 403);
  assert.equal(await s("/api/backups/restore", { name: "x" }), 403);
});

test("N-06b: the right PIN unlocks every locked channel; the export never carries the hash", async () => {
  const wrong = await post("/api/lock/unlock", { pin: "0000" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.ok, false);
  const r = await post("/api/lock/unlock", { pin: "4821" });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.untilMs - (Date.now() + UNLOCK_MS)) < 5_000);
  const now = (await get(`/api/now?channel=${late.id}`)).body;
  assert.equal(now.channel.unlocked, true);
  assert.equal(now.airing.title, "Late Night Show");
  assert.equal(now.locked, undefined);
  assert.equal((await get(`/api/item?id=${lateItem}`)).status, 200);
  assert.equal((await fetch(`${base}/media/${lateItem}`, { headers: { range: "bytes=0-99" } })).status, 206);

  const lockFile = readFileSync(join(home, "lock.json"), "utf8");
  const salt = JSON.parse(lockFile).hash.salt as string;
  const exported = await (await fetch(`${base}/api/export`)).text();
  assert.doesNotMatch(exported, new RegExp(salt.replace(/[+/=]/g, ".")));
  assert.doesNotMatch(exported, /4821|scrypt|"hash"/);
});

test("N-06b: removing the PIN unlocks the channels for good", async () => {
  assert.equal((await post("/api/lock/pin", { old: "1111", pin: null })).status, 403);
  const r = await post("/api/lock/pin", { old: "4821", pin: null });
  assert.equal(r.status, 200);
  assert.ok(r.body.unlockedChannels >= 3, String(r.body.unlockedChannels));
  assert.equal(r.body.pinSet, false);
  const s = (await get(`/api/channels/${late.id}/settings`)).body;
  assert.equal(s.locked, false);
  // A new PIN starts with nothing locked.
  await post("/api/lock/pin", { pin: "2468" });
  assert.equal((await get(`/api/channels/${late.id}/settings`)).body.locked, false);
});

test("N-06b: forget everything removes the PIN file", async () => {
  assert.ok(existsSync(join(home, "lock.json")));
  assert.equal((await post("/api/forget", { confirm: "forget everything" })).status, 200);
  assert.equal(existsSync(join(home, "lock.json")), false);
  assert.equal((await get("/api/lock")).body.pinSet, false);
});
