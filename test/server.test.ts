// End-to-end smoke test of the local server against the mock providers: connect,
// account status, scan, guide, playback proxy, refusals, account expiry, history,
// export and disconnect. No real provider is contacted.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-server-"));
process.env.DEBRIDTV_HOME = home;

const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const fixture = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
const TB_KEY = "tb-test-key-0123456789abcdef";
const RD_KEY = "rd-test-key-0123456789abcdef";
const DAY = 24 * 3600_000;

const episodes = Array.from({ length: 8 }, (_, i) => ({
  ref: `tb:${100 + i}:1`,
  name: `Test.Show.S01E0${i + 1}.720p.mkv`,
  bytes: fixture.byteLength,
  content: fixture,
}));
const mock = await startMockProviders({
  files: [
    ...episodes,
    { ref: "tb:200:1", name: "Unfinished.Show.S01E01.mkv", bytes: 5e8, state: "downloading" },
    { ref: "rd:abc", name: "Refused.Movie.1999.1080p.mkv", bytes: fixture.byteLength, content: fixture, policy: true },
    { ref: "rd:def", name: "Fine.Movie.2001.1080p.mkv", bytes: fixture.byteLength, content: fixture },
  ],
  account: { token: [TB_KEY, RD_KEY], premiumUntilMs: Date.now() + 30 * DAY, plan: "2" },
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

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
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
const configOnDisk = () => readFileSync(join(home, "config.json"), "utf8");

test("refuses other hosts and cross-site origins", async () => {
  const port = Number(new URL(base).port);
  // fetch() won't forge a Host header; a DNS-rebinding page's request looks like this.
  const status = await new Promise<number>((resolve, reject) =>
    http.get({ host: "127.0.0.1", port, path: "/api/bootstrap", headers: { host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject));
  assert.equal(status, 403);
  const r2 = await fetch(`${base}/api/sources/disconnect`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(r2.status, 403);
});

test("A1: a fresh install shows the demo and costs nothing", async () => {
  const b = await get("/api/bootstrap");
  assert.equal(b.body.demo, true);
  assert.ok(b.body.channels.length > 0);
  const g = await get("/api/guide");
  assert.ok(g.body.rows.length > 0);
  assert.equal((await get("/api/meters")).body.apiTotal, 0);
});

test("a rejected key is not saved", async () => {
  const r = await post("/api/sources", { provider: "torbox", key: "wrong-key-0123456789abcdef" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /rejected/);
  assert.equal((await get("/api/sources")).body.torbox.connected, false);
  assert.doesNotMatch(configOnDisk(), /wrong-key/);
});

test("connecting reads the account and the library list, nothing else", async () => {
  mock.reset();
  const r = await post("/api/sources", { provider: "torbox", key: TB_KEY });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.plan, "Pro");
  assert.equal(r.body.account.premium, true);
  assert.equal(r.body.notReady, 1);
  assert.deepEqual(mock.counters.api, { "tb.user": 1, "tb.mylist": 1 });
  assert.equal(mock.counters.mediaBytes, 0);

  const s = (await get("/api/sources")).body.torbox;
  assert.equal(s.counts["needs-scan"], 8);
  assert.equal(s.counts["not-ready"], 1);
  assert.equal(s.account.plan, "Pro");
  // The key never comes back to the browser.
  assert.doesNotMatch(JSON.stringify(await get("/api/sources")), new RegExp(TB_KEY));
});

test("B5: a file the provider hasn't finished is listed, explained, and never requested", async () => {
  const f = await get("/api/library/files?status=not-ready");
  assert.equal(f.body.files.length, 1);
  assert.match(f.body.files[0].message, /hasn't finished/);
  const check = await post("/api/library/check", { id: f.body.files[0].id });
  assert.equal(check.status, 409);
  assert.equal(mock.counters.api["tb.requestdl"] ?? 0, 0);
});

test("scan learns running times from a few KB per file, then channels go on the air", async () => {
  mock.reset();
  await post("/api/scan/start", { perMinute: 120 });
  await until(async () => !(await get("/api/sources")).body.scan.running);
  const s = (await get("/api/sources")).body;
  assert.equal(s.torbox.counts.ready, 8, JSON.stringify(s.torbox.counts));
  assert.equal(s.scan.needed, 0);
  assert.equal(mock.counters.api["tb.requestdl"], 8, "one link per file");
  assert.ok(mock.counters.mediaBytes <= 8 * fixture.byteLength);
  await until(async () => (await get("/api/bootstrap")).body.demo === false);
  const b = (await get("/api/bootstrap")).body;
  assert.ok(b.channels.some((c: any) => c.name === "Test Show"), JSON.stringify(b.channels.map((c: any) => c.name)));
});

test("B1: browsing the guide and asking what's on cost no provider calls", async () => {
  const before = (await get("/api/meters")).body.apiTotal;
  const b = (await get("/api/bootstrap")).body;
  for (let h = -2; h < 24; h += 3) await get(`/api/guide?from=${Date.now() + h * 3600_000}`);
  for (const c of b.channels) await get(`/api/now?channel=${c.id}`);
  await get("/api/library/files");
  await get("/api/sources");
  assert.equal((await get("/api/meters")).body.apiTotal, before);
});

test("playback is proxied, metered, and reuses the scan's link", async () => {
  const files = (await get("/api/library/files?status=ready")).body.files;
  const id = files[0].id;
  const calls = mock.counters.api["tb.requestdl"];
  const res = await fetch(`${base}/media/${id}`, { headers: { range: "bytes=0-999" } });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 1000);
  assert.equal(mock.counters.api["tb.requestdl"], calls, "grant reused (E4)");
  await until(async () => (await get("/api/meters")).body.bytes.playback >= 1000);
  const after = (await get(`/api/library/files?q=S01E01`)).body.files[0];
  assert.ok(after.playableAt, "last confirmed playable is recorded");
});

test("ADR-0003: the ends of a tuned file are kept and answer later range reads without the host", async () => {
  const files = (await get("/api/library/files?status=ready")).body.files;
  const id = files.find((f: any) => /S01E03/.test(f.name)).id;
  // A full read (what a tune does) fills the cache: the fixture is smaller than the 1 MiB head.
  const full = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=0-" } })).arrayBuffer());
  assert.equal(full.byteLength, fixture.byteLength);
  await until(async () => (await get("/api/meters")).body.cache.files >= 1);
  const requests = mock.counters.mediaRequests;
  const hostBytes = mock.counters.mediaBytes;
  const cachedBefore = (await get("/api/meters")).body.bytes.cached;
  const tail = await fetch(`${base}/media/${id}`, { headers: { range: `bytes=${fixture.byteLength - 500}-` } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get("content-range"), `bytes ${fixture.byteLength - 500}-${fixture.byteLength - 1}/${fixture.byteLength}`);
  assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), fixture.subarray(fixture.byteLength - 500));
  const mid = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=1000-1999" } })).arrayBuffer());
  assert.deepEqual(mid, fixture.subarray(1000, 2000));
  assert.equal(mock.counters.mediaRequests, requests, "no host request");
  assert.equal(mock.counters.mediaBytes, hostBytes, "no host bytes");
  const m = (await get("/api/meters")).body;
  assert.equal(m.bytes.cached - cachedBefore, 1500, "served-from-cache bytes counted on their own");
  assert.ok(m.cache.bytes > 0);

});

test("E6: a refused file is marked once and never asked for again", async () => {
  const r = await post("/api/sources", { provider: "realdebrid", key: RD_KEY });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const movie = (await get("/api/library/files?q=refused")).body.files[0];
  const first = await post("/api/library/check", { id: movie.id });
  assert.equal(first.body.ok, false);
  assert.match(first.body.message, /refused/);
  const unrestricts = mock.counters.api["rd.unrestrict"];
  assert.equal((await post("/api/library/check", { id: movie.id })).status, 409);
  assert.equal((await post("/api/prefetch", { itemId: movie.id })).body.skipped, true);
  assert.equal((await fetch(`${base}/media/${movie.id}`)).status, 451);
  assert.equal(mock.counters.api["rd.unrestrict"], unrestricts, "no second request after a refusal");
  // The fine movie on the same account is unaffected.
  const fine = (await get("/api/library/files?q=fine")).body.files[0];
  assert.equal((await post("/api/library/check", { id: fine.id })).body.ok, true);
});

test("D5: an expired account gets its own message and no link requests", async () => {
  mock.setAccount({ token: [TB_KEY, RD_KEY], premiumUntilMs: Date.now() - DAY, plan: "2" });
  const a = await post("/api/sources/account", { provider: "torbox" });
  assert.equal(a.body.premium, false);
  const files = (await get("/api/library/files?provider=torbox&status=account")).body;
  assert.equal(files.counts.account, 8);
  assert.match(files.files[0].message, /premium ended/);
  const calls = mock.counters.api["tb.requestdl"];
  const m = await fetch(`${base}/media/${files.files[0].id}`);
  assert.equal(m.status, 409);
  assert.match(((await m.json()) as any).message, /premium/);
  const item = (await get(`/api/item?id=${files.files[0].id}`)).body;
  assert.equal(item.availability, "unavailable");
  assert.match(item.availabilityReason, /premium/);
  assert.equal(mock.counters.api["tb.requestdl"], calls);
  mock.setAccount({ token: [TB_KEY, RD_KEY], premiumUntilMs: Date.now() + 30 * DAY, plan: "2" });
  await post("/api/sources/account", { provider: "torbox" });
  assert.equal((await get("/api/library/files?provider=torbox")).body.counts.account, 0);
});

test("D5: a file removed from the provider says so, and leaves the air", async () => {
  mock.setFiles([...episodes.slice(1), { ref: "tb:200:1", name: "Unfinished.Show.S01E01.mkv", bytes: 5e8, state: "downloading" },
    { ref: "rd:def", name: "Fine.Movie.2001.1080p.mkv", bytes: fixture.byteLength, content: fixture }]);
  await post("/api/sources/refresh", { provider: "torbox" });
  const gone = (await get("/api/library/files?status=gone")).body.files;
  assert.equal(gone.length, 1);
  assert.match(gone[0].message, /No longer in your TorBox library/);
  assert.equal((await fetch(`${base}/media/${gone[0].id}`)).status, 409);
});

test("excluding a file keeps it off the air and is reversible", async () => {
  const f = (await get("/api/library/files?status=ready&provider=torbox")).body.files[0];
  await post("/api/library/exclude", { id: f.id, excluded: true });
  assert.equal((await get(`/api/library/files?q=${encodeURIComponent(f.title)}`)).body.files[0].status, "excluded");
  await post("/api/library/exclude", { id: f.id, excluded: false });
  assert.equal((await get(`/api/library/files?q=${encodeURIComponent(f.title)}`)).body.files[0].status, "ready");
});

test("history: measured, marked by hand, forgotten, exported without secrets", async () => {
  const f = (await get("/api/library/files?status=ready&provider=torbox")).body.files[0];
  await post("/api/watch", { itemId: f.id, fromMs: 0, toMs: 1000, channel: "x" });
  let h = (await get("/api/history")).body;
  assert.equal(h.recent[0].itemId, f.id);
  assert.equal(h.recent[0].watched, false, "1 s of 7.5 s is not watched (D8)");
  await post("/api/history/mark", { itemId: f.id, mark: "watched" });
  h = (await get("/api/history")).body;
  assert.equal(h.recent[0].watched, true);
  assert.equal(h.recent[0].manual, "watched");
  const ex = await fetch(`${base}/api/history/export`);
  assert.match(ex.headers.get("content-disposition") ?? "", /attachment/);
  const text = await ex.text();
  assert.doesNotMatch(text, new RegExp(`${TB_KEY}|${RD_KEY}`));
  await post("/api/history/forget", { itemId: f.id });
  assert.equal((await get("/api/history")).body.recent.some((r: any) => r.itemId === f.id), false);
  assert.equal((await get(`/api/item?id=${f.id}`)).body.seenMs, 0);
});

test("F4: settings export carries choices, never keys", async () => {
  const text = await (await fetch(`${base}/api/export`)).text();
  const x = JSON.parse(text);
  assert.equal(x.sources.torbox, true);
  assert.ok(x.lineup.numbers);
  assert.doesNotMatch(text, new RegExp(`${TB_KEY}|${RD_KEY}`));
  // N-26a: lineup only (the import reads `lineup`, which both files carry).
  const only = await fetch(`${base}/api/export?only=lineup`);
  assert.match(only.headers.get("content-disposition") ?? "", /debridtv-lineup\.json/);
  const l = (await only.json()) as any;
  assert.ok(l.lineup.numbers);
  assert.equal(l.sources, undefined);
  assert.equal(l.ratings, undefined);
});

test("N-03/N-16: rename, renumber (a taken number swaps), favorite, logo, kid and schedule settings stored", async () => {
  const chans = (await get("/api/bootstrap")).body.channels;
  const ch = chans.find((c: any) => c.name === "Test Show") ?? chans[0];
  const other = chans.find((c: any) => c.id !== ch.id);
  const put = (b: unknown) => fetch(`${base}/api/channels/${ch.id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const swap = await put({ number: other.number });
  assert.equal(swap.status, 200);
  assert.match(((await swap.json()) as any).note, /Swapped/);
  const afterSwap = (await get("/api/bootstrap")).body.channels;
  assert.equal(afterSwap.find((c: any) => c.id === other.id).number, ch.number, "the other channel took the old number");
  const r = await put({ name: "Show Time", number: 77, favorite: true, logo: { kind: "badge", text: "SHOW", hue: 200, style: "pill" }, kid: true,
    restrictedHours: [{ from: "22:00", to: "06:00", maxRating: "PG-13" }], slots: [{ days: [1, 2, 3], from: "18:00", to: "21:00", source: "show:test show" }] });
  assert.equal(r.status, 200);
  assert.equal((await put({ restrictedHours: [{ from: "25:00", to: "06:00", maxRating: "PG" }] })).status, 400);
  assert.equal((await put({ logo: { kind: "image", url: "https://tracker.example/logo.png" } })).status, 400, "no outside images");
  const view = (await get("/api/bootstrap")).body.channels.find((c: any) => c.id === ch.id);
  assert.deepEqual([view.name, view.number, view.favorite, view.logo.text, view.hue, view.kid], ["Show Time", 77, true, "SHOW", 200, true]);
  const s = (await get(`/api/channels/${ch.id}/settings`)).body;
  assert.equal(s.number, 77);
  assert.equal(s.slots[0].from, "18:00");
  assert.equal(s.restrictedHours[0].maxRating, "PG-13");
  await put({ name: null });
});

test("N-06a: the kid flag is enforced; unrated shows stay off until someone rates them (D7)", async () => {
  const ch = (await get("/api/bootstrap")).body.channels.find((c: any) => c.kid);
  const settings = (await get(`/api/channels/${ch.id}/settings`)).body;
  assert.equal(settings.enforced, true);
  assert.equal(typeof settings.timeZone, "string");
  assert.equal(settings.ratings.unrated, settings.ratings.total, "nothing on this channel has a rating yet");
  assert.equal(settings.ratings.kidSafe, 0);
  await sleep(400);
  const from = Date.now() + 3 * 3600_000; // past whatever is on now
  const rows = async () => (await get(`/api/guide?from=${from}&to=${from + 3 * 3600_000}`)).body.rows.find((r: any) => r.channel.id === ch.id);
  assert.equal((await rows()).airings.length, 0, "a kid channel with only unrated shows is off the air");

  const ratings = (await get("/api/ratings")).body;
  const testShow = ratings.shows.find((x: any) => x.name === "Test Show");
  assert.deepEqual([testShow.rating, testShow.from], [null, null]);
  assert.equal((await post("/api/ratings", { showKey: testShow.key, rating: "X-ish" })).status, 400);
  const r = await post("/api/ratings", { showKey: testShow.key, rating: "TV-G" });
  assert.deepEqual(r.body, { ok: true, rating: "G" });
  await sleep(400);
  const rated = (await get(`/api/channels/${ch.id}/settings`)).body.ratings;
  assert.ok(rated.total > 0 && rated.kidSafe === rated.total, JSON.stringify(rated));
  const back = await rows();
  assert.ok(back.airings.length > 0, "rated G, it airs again");
  assert.equal(back.airings[0].rating, "G");
  const exported = JSON.parse(await (await fetch(`${base}/api/export`)).text());
  assert.equal(exported.ratings.shows[testShow.key], "G", "hand-set ratings travel with the settings export");
  await post("/api/ratings", { showKey: testShow.key, rating: null });
  assert.equal((await get("/api/ratings")).body.shows.find((x: any) => x.key === testShow.key).rating, null);
});

test("N-07: content groups: saved, aired as a channel, included in custom channels and slots, described in the guide", async () => {
  const opts = (await get("/api/groups")).body.options;
  const show = opts.shows.find((x: any) => x.name === "Test Show");
  const film = opts.movies.find((x: any) => x.title === "Fine Movie");
  assert.ok(show && film, JSON.stringify(opts));
  assert.equal((await post("/api/groups", { name: "", entries: [] })).status, 400);
  assert.equal((await post("/api/groups", { name: "X", entries: [{ kind: "song", id: "a" }] })).status, 400);
  const made = await post("/api/groups", { id: "late", name: "Late Night", description: "Comedy after dark. Then a film.", ordering: "cyclic",
    entries: [{ kind: "movie", id: film.id }, { kind: "show", key: show.key }, { kind: "show", key: show.key }], channel: true });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const g = made.body.group;
  assert.deepEqual([g.id, g.entries.length, g.ruleKey], ["late", 2, "group:late"], "duplicate entries kept once");
  assert.ok(g.programs >= 2 && g.programs <= show.episodes + 1);
  await sleep(400);
  const own = (await get("/api/bootstrap")).body.channels.find((c: any) => c.ruleKey === "group:late");
  assert.ok(own, "a group with channel:true is a channel");
  assert.equal(own.kind, "group");
  assert.ok(own.number >= 60);
  const from = Date.now() + 3 * 3600_000;
  const row = (await get(`/api/guide?from=${from}&to=${from + 6 * 3600_000}`)).body.rows.find((r: any) => r.channel.id === own.id);
  assert.ok(row.airings.length > 0);
  assert.deepEqual(row.airings[0].group, { id: "late", name: "Late Night", description: "Comedy after dark. Then a film." });
  // Cyclic: the film, then the show's episodes in order, round again.
  const seq = row.airings.map((a: any) => (a.itemId === film.id ? "F" : a.episode));
  const fi = seq.indexOf("F");
  if (fi >= 0 && fi + 2 < seq.length) assert.deepEqual(seq.slice(fi, fi + 3), ["F", "S1 · E1", "S1 · E2"]);

  // A custom channel built from the group alone.
  assert.equal((await post("/api/channels/custom", { name: "Nope", groupIds: ["missing"] })).status, 400);
  assert.equal((await post("/api/channels/custom", { id: "fromgroup", name: "From Group", groupIds: ["late"], ordering: "shuffle" })).status, 200);
  const custom = (await get("/api/bootstrap")).body.channels.find((c: any) => c.ruleKey === "custom:fromgroup");
  assert.ok(custom);
  assert.equal((await get("/api/channels")).body.channels.find((c: any) => c.id === custom.id).items, g.programs);

  // As a slot source while not its own channel.
  assert.equal((await post("/api/groups", { id: "late", name: "Late Night", entries: [{ kind: "show", key: show.key }], channel: false })).status, 200);
  await sleep(400);
  assert.equal((await get("/api/bootstrap")).body.channels.some((c: any) => c.ruleKey === "group:late"), false, "channel:false takes it off the air");
  const host = (await get("/api/channels")).body.channels.find((c: any) => c.ruleKey === "custom:fromgroup");
  assert.ok(host, JSON.stringify((await get("/api/channels")).body.channels.map((c: any) => [c.ruleKey, c.items, c.hidden])));
  const put = (b: unknown) => fetch(`${base}/api/channels/${host.id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await put({ slots: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "00:00", to: "00:00", source: "group:late" }] })).status, 200);
  const listed = (await get("/api/groups")).body.groups.find((x: any) => x.id === "late");
  assert.deepEqual(listed.usedBy.map((u: any) => u.how).sort(), ["custom", "slot"]);
  assert.ok(listed.programs >= 1);

  // Deleting drops the slot and the custom channel's reference.
  assert.equal((await post("/api/groups/delete", { id: "late" })).status, 200);
  assert.equal((await post("/api/groups/delete", { id: "late" })).status, 404);
  const exp = JSON.parse(await (await fetch(`${base}/api/export`)).text());
  assert.deepEqual(exp.lineup.groups, []);
  assert.equal(exp.lineup.settings["custom:fromgroup"].slots, undefined, "the slot went with the group");
  assert.deepEqual(exp.lineup.custom.find((c: any) => c.id === "fromgroup").groupIds, undefined);
  await post("/api/channels/custom/delete", { id: "fromgroup" });
});

test("N-32: a channel's season and seasonal slots are stored, checked and shown", async () => {
  const ch = (await get("/api/bootstrap")).body.channels[0];
  const put = (b: unknown) => fetch(`${base}/api/channels/${ch.id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await put({ season: { from: "13-01", to: "10-31" } })).status, 400);
  assert.equal((await put({ slots: [{ days: [6], from: "08:00", to: "10:00", source: ch.ruleKey, dates: { from: "10-01" } }] })).status, 400);
  assert.equal((await put({ slots: [{ days: [6], from: "08:00", to: "10:00", source: ch.ruleKey, dates: { from: "12-15", to: "01-05" } }] })).status, 200);
  const today = new Date();
  const md = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const away = new Date(today.getTime() + 60 * 86_400_000);
  assert.equal((await put({ season: { from: md(away), to: md(away) } })).status, 200);
  const s = (await get(`/api/channels/${ch.id}/settings`)).body;
  assert.deepEqual(s.slots[0].dates, { from: "12-15", to: "01-05" });
  assert.equal(s.season.inSeason, false);
  assert.ok(s.season.nextChangeMs > Date.now());
  await sleep(400);
  const view = (await get("/api/bootstrap")).body.channels.find((c: any) => c.id === ch.id);
  assert.equal(view.season.from, md(away));
  const from = Date.now() + 3 * 3600_000;
  const row = (await get(`/api/guide?from=${from}&to=${from + 6 * 3600_000}`)).body.rows.find((r: any) => r.channel.id === ch.id);
  assert.equal(row.airings.length, 0, "out of season: off the air");
  assert.equal((await put({ season: null, slots: [] })).status, 200);
  assert.equal((await get(`/api/channels/${ch.id}/settings`)).body.season, null);
});

test("N-30: On Demand and Continue Watching read local facts only", async () => {
  const before = (await get("/api/meters")).body;
  const od = (await get("/api/ondemand")).body;
  const show = od.shows.find((x: any) => x.name === "Test Show");
  assert.ok(show, JSON.stringify(od.shows.map((x: any) => x.name)));
  assert.equal(show.episodes, 7, "one of the eight left the provider earlier");
  assert.ok(!od.movies.some((x: any) => x.title === "Refused Movie"), "refused files aren't offered");
  const page = (await get(`/api/ondemand/show?key=${encodeURIComponent(show.key)}`)).body;
  assert.equal(page.seasons[0].episodes.length, show.episodes);
  const ep = page.seasons[0].episodes[2];
  for (const k of ["id", "kind", "title", "showKey", "season", "episode", "label", "durationMs", "seenMs", "resumeMs", "watched", "availability"]) assert.ok(k in ep, k);
  assert.equal((await get("/api/ondemand/show?key=nope")).status, 404);
  // The fixture runs 7.5 s, too short to leave part way (a minute counts), so finish it: the next episode is up.
  assert.equal((await post("/api/watch", { itemId: ep.id, fromMs: 0, toMs: ep.durationMs, channel: "ondemand" })).status, 200);
  const c = (await get("/api/continue?limit=5")).body.items;
  assert.equal(c[0].id, page.seasons[0].episodes[3].id);
  assert.deepEqual([c[0].reason, c[0].resumeMs, c[0].channel], ["next", null, "ondemand"]);
  const after = (await get("/api/meters")).body;
  assert.equal(after.apiTotal, before.apiTotal, "no provider calls");
  assert.deepEqual(after.bytes, before.bytes, "no media bytes");
  await post("/api/history/forget", { itemId: ep.id });
});

test("A4: disconnecting deletes the key from disk and takes its channels off the air", async () => {
  await post("/api/sources/disconnect", { provider: "torbox" });
  assert.doesNotMatch(configOnDisk(), new RegExp(TB_KEY));
  assert.equal((await get("/api/sources")).body.torbox.connected, false);
  assert.equal((await get("/api/library/files?provider=torbox")).body.total, 0);
  await sleep(400);
  const b = (await get("/api/bootstrap")).body;
  assert.equal(b.channels.some((c: any) => c.name === "Test Show"), false);
});

test("N-27c: settings backups are written on request, listed, trimmed and restorable; keys never inside", async () => {
  let r = await post("/api/backups", { keep: 2, now: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.keep, 2);
  assert.match(r.body.made.name, /^settings-\d{4}-\d{2}-\d{2}\.json$/);
  await post("/api/backups", { now: true });
  r = await post("/api/backups", { now: true });
  assert.equal(r.body.backups.length, 2, "only the newest two are kept");
  const list = (await get("/api/backups")).body;
  assert.equal(list.backups.length, 2);
  const text = readFileSync(join(list.folder, list.backups[0].name), "utf8");
  assert.doesNotMatch(text, new RegExp(`${TB_KEY}|${RD_KEY}`));
  assert.equal((await post("/api/backups/restore", { name: list.backups[0].name })).status, 200);
  assert.equal((await post("/api/backups/restore", { name: "../config.json" })).status, 404);
});

test("forget everything wipes keys, library, history and channels", async () => {
  assert.equal((await post("/api/forget", {})).status, 400, "needs the confirmation phrase");
  const r = await post("/api/forget", { confirm: "forget everything" });
  assert.equal(r.status, 200);
  assert.equal(configOnDisk().trim(), "{}");
  assert.equal((await get("/api/bootstrap")).body.demo, true);
  assert.equal((await get("/api/history")).body.recent.length, 0);
  assert.equal((await get("/api/backups")).body.backups.length, 0, "backups go too");
});
