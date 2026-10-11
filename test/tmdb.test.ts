// Online posters and descriptions (N-01c online): TMDB, off until the viewer enters
// a key, asked only for titles and years, cached on disk, never above local files,
// never for PIN-locked items. Runs against test/tmdb-mock.ts; no real TMDB traffic.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTmdbMock, TEST_KEY, PNG } from "./tmdb-mock.ts";

const home = mkdtempSync(join(tmpdir(), "debridtv-tmdb-home-"));
process.env.DEBRIDTV_HOME = home;
const { OnlineMetadata, pick, queryFor } = await import("../app/metadata/tmdb.ts");
const { createApp } = await import("../app/server.ts");
const { parseName } = await import("../src/library/parse.ts");
type LibItem = import("../app/library.ts").LibItem;

const root = mkdtempSync(join(tmpdir(), "debridtv-tmdb-"));
const mock = await startTmdbMock();
after(async () => {
  await mock.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const fast = { apiBase: mock.apiBase, imageBase: mock.imageBase, spacingMs: 0 };

let n = 0;
function item(name: string, over: Partial<LibItem> = {}): LibItem {
  n++;
  return { id: `t${n}`, provider: "torbox", ref: `tb:${n}`, name, bytes: 1e9, providerState: "cached", ready: true,
    parsed: parseName(name), durationMs: 1_320_000, availability: "listed", present: true, ...over };
}

test("N-01c online: picks the exact title over TMDB's first answer, and refuses a vague guess", () => {
  const results = [
    { id: 1, name: "Night Owls Revisited", first_air_date: "2011-01-01" },
    { id: 2, name: "Night Owls", first_air_date: "1994-09-12" },
  ];
  assert.equal(pick(results, { title: "Night Owls" })?.id, 2);
  assert.equal(pick(results, { title: "night owls!" })?.id, 2, "punctuation and case don't matter");
  assert.equal(pick([{ id: 3, title: "Heat", release_date: "1986-01-01" }, { id: 4, title: "Heat", release_date: "1995-12-15" }], { title: "Heat", year: 1995 })?.id, 4);
  assert.equal(pick([], { title: "x" }), undefined);
  // Only file-name facts go into a query: show name, film title, year.
  const q = queryFor(item("Paper.Moonlight.1987.1080p.BluRay.x264-GRP.mkv"))!;
  assert.deepEqual(q, { key: "movie|paper moonlight|1987", media: "movie", title: "Paper Moonlight", year: 1987 });
  assert.equal(queryFor(item("sample.mkv")), undefined);
});

test("N-01c online: off with no key; a wrong key is refused; nothing but titles, years and seasons leaves", async () => {
  const om = new OnlineMetadata(fast);
  const items = [item("Night.Owls.S01E01.Sign.On.1080p.WEB.mkv"), item("Night.Owls.S01E02.mkv"), item("Paper.Moonlight.1987.1080p.BluRay.x264-GRP.mkv")];
  await om.sync(items);
  assert.equal(mock.requests.length, 0, "no key, no requests");
  assert.equal(om.status().state, "off");

  const bad = await om.setKey("not-the-key");
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /didn't accept/);
  assert.equal(om.enabled(), false);
  assert.ok(!existsSync(join(home, "tmdb-key.json")) || !readFileSync(join(home, "tmdb-key.json"), "utf8").includes("not-the-key"));

  assert.deepEqual(await om.setKey(TEST_KEY), { ok: true });
  mock.requests.length = 0;
  await om.sync(items);
  const urls = mock.requests.map((r) => decodeURIComponent(r.url.replace(/api_key=\w+/, "")));
  // One search per title, the show's logo list, one season, then the pictures.
  assert.deepEqual(urls.map((u) => u.split("?")[0]).sort(), [
    "/3/search/movie", "/3/search/tv", "/3/tv/4242/images", "/3/tv/4242/season/1",
    "/img/w1280/owls-backdrop.jpg", "/img/w500/moon-poster.jpg", "/img/w500/owls-logo.png", "/img/w500/owls-poster.jpg",
  ]);
  for (const u of urls) assert.doesNotMatch(u, /1080p|BluRay|WEB|GRP|mkv|tb:|Sign\.On/i, `only titles and years: ${u}`);
  assert.ok(mock.requests.every((r) => !r.referer));

  const [e1, e2, film] = items;
  assert.deepEqual(om.text(e1), { overview: "Wendy takes the graveyard shift.", name: "Sign On" });
  assert.equal(om.text(e2)?.name, "Dead Air");
  assert.equal(om.text(film)?.overview, "Two projectionists save a drive-in.");
  assert.deepEqual(om.kinds(e1).sort(), ["fanart", "logo", "poster"]);
  assert.deepEqual(om.kinds(film), ["poster"]);
  assert.deepEqual(readFileSync(om.imageFile(e1, "poster")!), PNG);

  // Cached on disk: a second pass (and a fresh process) asks TMDB for nothing.
  mock.requests.length = 0;
  await om.sync(items);
  await new OnlineMetadata(fast).sync(items);
  assert.equal(mock.requests.length, 0);
  assert.equal(om.status().withPictures, 2);
});

test("N-01c online: local .nfo text and Kodi art win; misses aren't asked again; locked items are skipped; 401 stops", async () => {
  const om = new OnlineMetadata(fast);
  assert.ok(om.enabled(), "key from the previous test is on disk");
  mock.requests.length = 0;
  const local = item("Night.Owls.S01E01.mkv", { provider: "local", meta: { kind: "episode", plot: "My own words." }, art: { poster: "/x/p.jpg", fanart: "/x/f.jpg", logo: "/x/l.png" } });
  const unknown = item("Nobody.Knows.This.2001.mkv");
  const locked = item("Secret.Film.1999.mkv");
  await om.sync([local, unknown, locked], (id) => id === locked.id);
  const asked = mock.requests.map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")));
  assert.equal(asked.length, 1, "the local episode needs nothing; the locked film is never asked about");
  assert.match(asked[0]!, /search\/movie\?query=Nobody Knows This/);
  await om.sync([unknown]);
  assert.equal(mock.requests.length, 1, "a miss is remembered");

  // A key TMDB stops accepting pauses everything until a new one is entered.
  writeFileSync(join(home, "tmdb-key.json"), JSON.stringify({ key: "revoked" }));
  const om2 = new OnlineMetadata(fast);
  await om2.sync([item("Some.Show.S01E01.mkv"), item("Other.Show.S01E01.mkv")]);
  assert.equal(mock.requests.length, 2, "one refused request, then nothing");
  assert.equal(om2.status().state, "rejected");
  assert.equal(om2.enabled(), false);
});

test("N-01c online: a 429 waits for Retry-After and tries once more", async () => {
  const slow = await startTmdbMock({ tooMany: 1 });
  const h = mkdtempSync(join(tmpdir(), "debridtv-tmdb-429-"));
  process.env.DEBRIDTV_HOME = h;
  try {
    writeFileSync(join(h, "tmdb-key.json"), JSON.stringify({ key: TEST_KEY }));
    const om = new OnlineMetadata({ apiBase: slow.apiBase, imageBase: slow.imageBase, spacingMs: 0 });
    const t0 = Date.now();
    const film = item("Paper.Moonlight.1987.mkv");
    await om.sync([film]);
    assert.ok(Date.now() - t0 >= 900, "waited for Retry-After");
    assert.equal(slow.requests.filter((r) => r.url.includes("search")).length, 2, "the refused search, then one more");
    assert.equal(om.text(film)?.overview, "Two projectionists save a drive-in.");
  } finally {
    process.env.DEBRIDTV_HOME = home;
    await slow.close();
    rmSync(h, { recursive: true, force: true });
  }
});

test("N-01c online: the app shows TMDB posters and descriptions, keeps the key out of exports, and Forget deletes it all", async () => {
  const show = join(root, "Lib", "Night Owls");
  mkdirSync(show, { recursive: true });
  const fixture = new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url);
  for (let i = 1; i <= 8; i++) copyFileSync(fixture, join(show, `Night.Owls.S01E0${i}.mkv`));
  writeFileSync(join(show, "clearlogo.png"), PNG); // the viewer's own logo beats TMDB's
  writeFileSync(join(home, "tmdb-key.json"), "{}");
  const app = createApp({ port: 0, ffmpeg: false, timers: false, tmdb: fast });
  const base = `http://127.0.0.1:${await app.listen()}`;
  const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    assert.equal((await get("/api/metadata")).state, "off");
    assert.equal((await post("/api/sources", { provider: "local", dirs: [join(root, "Lib")] })).status, 200);
    await post("/api/scan/start", { perMinute: 600 });
    let ch: any;
    for (let t = 0; t < 100 && !ch; t++) {
      await new Promise((r) => setTimeout(r, 100));
      ch = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Night Owls");
    }
    assert.ok(ch, "show channel on the air");
    let now = await get(`/api/now?channel=${ch.id}`);
    assert.equal(now.airing.description, undefined, "no key: no online text");
    assert.equal(now.airing.art.poster, undefined);

    assert.equal((await post("/api/metadata", { key: "wrong" })).status, 400);
    const on = await post("/api/metadata", { key: TEST_KEY });
    assert.equal(on.status, 200);
    assert.match(((await on.json()) as any).attribution, /not endorsed or certified by TMDB/);
    for (let t = 0; t < 100 && !now.airing.art?.poster; t++) {
      await new Promise((r) => setTimeout(r, 50));
      now = await get(`/api/now?channel=${ch.id}`);
    }
    assert.match(now.airing.art.poster, /^\/api\/art\/[\w-]+\/poster$/);
    assert.match(now.airing.description, /Wendy|transmitter|radio crew/);
    const logo = await fetch(base + now.airing.art.logo);
    assert.equal(logo.status, 200);
    const poster = await fetch(base + now.airing.art.poster);
    assert.equal(poster.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await poster.arrayBuffer()), PNG);
    const cached = readdirSync(join(home, "metadata", "img"));
    assert.ok(cached.includes("tv-4242-poster.png"));

    // Off hides TMDB's text and pictures at once; the cache stays, so back on costs nothing.
    assert.equal((await post("/api/metadata", { key: null })).status, 200);
    const off = await get(`/api/now?channel=${ch.id}`);
    assert.equal(off.airing.art.poster, undefined);
    assert.equal(off.airing.description, undefined);
    const asked = mock.requests.length;
    assert.equal((await post("/api/metadata", { key: TEST_KEY })).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(mock.requests.length, asked + 1, "only the key check");
    assert.match((await get(`/api/now?channel=${ch.id}`)).airing.art.poster, /poster$/);

    const exported = await (await fetch(`${base}/api/export`)).text();
    assert.ok(!exported.includes(TEST_KEY), "the key is never exported");
    assert.ok(!JSON.stringify(await get("/api/metadata")).includes(TEST_KEY), "nor sent to the browser");

    assert.equal((await post("/api/forget", { confirm: "forget everything" })).status, 200);
    assert.equal((await get("/api/metadata")).state, "off");
    assert.deepEqual(readdirSync(join(home, "metadata", "img")), []);
  } finally {
    await app.close();
  }
});
