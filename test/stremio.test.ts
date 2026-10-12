// Stremio addons as an Add source: manifest check, stream lists turned into
// torrents to add, IMDb lookup through TMDB, and the addon address (which often
// holds the viewer's keys) kept on the PC. A local server plays the addon; no real
// network is touched, and no play link is ever opened.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startTmdbMock, TEST_KEY } from "./tmdb-mock.ts";

const home = mkdtempSync(join(tmpdir(), "debridtv-stremio-"));
process.env.DEBRIDTV_HOME = home;
const { createApp } = await import("../app/server.ts");
const { OnlineMetadata } = await import("../app/metadata/tmdb.ts");
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { addonBase, addonHost, addonManifest, readQuery, searchAddon, streamToResult } = await import("../src/acquire/stremio.ts");

const SECRET = "eyJkZWJyaWRBcGlLZXkiOiJTVVBFUlNFQ1JFVCJ9";
const H1 = "aabbccddeeff00112233445566778899aabbccdd";
const H2 = "0123456789abcdef0123456789abcdef01234567";

const hits: string[] = [];
const addon = http.createServer((req, res) => {
  hits.push(req.url!);
  const p = new URL(req.url!, "http://x").pathname;
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  if (p === `/${SECRET}/manifest.json`)
    return json({ id: "test.addon", name: "Test Addon", version: "1.0.0", types: ["movie", "series"], resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }], catalogs: [] });
  if (p === "/catalogs-only/manifest.json") return json({ id: "x", name: "X", types: ["movie"], resources: ["catalog", "meta"], catalogs: [] });
  if (p === `/${SECRET}/stream/movie/tt0078748.json`)
    return json({
      streams: [
        // A debrid-backed addon: no infoHash, but the play link's path carries it.
        { name: "[RD+] Test\n4K", description: "Alien.1979.Directors.Cut.2160p.UHD.BluRay.x265\n💾 61.2 GB 👤 87 🔎 SomeSite", url: `http://play.example/${SECRET}/playback/${H1}/0/Alien.mkv` },
        { name: "Test 1080p", title: "Alien (1979) 1080p\n👤 12", infoHash: H2.toUpperCase(), fileIdx: 1, sources: ["tracker:udp://tracker.example:1337/announce", "dht:" + H2], behaviorHints: { filename: "Alien.1979.1080p.mkv", videoSize: 9_000_000_000 } },
        // Play-only: nothing to add.
        { name: "Direct", url: "https://cdn.example/alien.mp4" },
        // Same torrent again (another file of it): shown once.
        { name: "Test", title: "dup", infoHash: H2 },
      ],
    });
  if (p === `/${SECRET}/stream/series/tt0386676:2:5.json`) return json({ streams: [{ title: "The.Office.S02E05.720p\n💾 350 MB", infoHash: H1 }] });
  if (p === `/${SECRET}/stream/series/tt0386676:1:1.json`) return json({ streams: [] });
  res.writeHead(404).end();
});
await new Promise<void>((r) => addon.listen(0, "127.0.0.1", r));
const addonUrl = `http://127.0.0.1:${(addon.address() as AddressInfo).port}/${SECRET}/manifest.json`;
const ix = { id: "ad1", name: "Test Addon", url: addonUrl, kind: "stremio" as const };

const mock = await startMockProviders({ files: [] });
const lookups: string[] = [];
const app = createApp({
  port: 0, ffmpeg: false, timers: false,
  bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` },
  acquire: {
    timing: { rdSpacingMs: 0, tbSpacingMs: 0, rdHoldsMs: [40, 40], rdPollMs: 5, refreshAfterMs: 5 },
    imdbLookup: async (title, media) => {
      lookups.push(`${media ?? "any"}:${title}`);
      if (/^the office$/i.test(title)) return { imdbId: "tt0386676", media: "tv", name: "The Office", year: 2005 };
      if (/^alien$/i.test(title)) return { imdbId: "tt0078748", media: "movie", name: "Alien", year: 1979 };
      return null;
    },
  },
});
let url = "";
before(async () => {
  url = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  await mock.close();
  await new Promise((r) => addon.close(r));
  rmSync(home, { recursive: true, force: true });
});
const get = async (p: string) => {
  const r = await fetch(url + p);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

test("addon addresses: stremio:// and manifest.json are trimmed, and only the host is ever shown", () => {
  assert.equal(addonBase("stremio://addon.example/abc/manifest.json"), "https://addon.example/abc");
  assert.equal(addonBase("https://addon.example/abc/manifest.json?x=1"), "https://addon.example/abc");
  assert.equal(addonBase("https://addon.example/abc/"), "https://addon.example/abc");
  assert.equal(addonHost(`https://addon.example/${SECRET}/manifest.json`), "https://addon.example/…");
});

test("the search box reads IMDb ids, episodes and seasons", () => {
  assert.deepEqual(readQuery("The Office S02E05"), { title: "The Office", season: 2, episode: 5 });
  assert.deepEqual(readQuery("the office 2x05"), { title: "the office", season: 2, episode: 5 });
  assert.deepEqual(readQuery("Doctor Who season 3"), { title: "Doctor Who", season: 3 });
  assert.deepEqual(readQuery("tt0078748"), { title: "", imdbId: "tt0078748" });
  assert.deepEqual(readQuery("Alien"), { title: "Alien" });
});

test("streams become torrents to add; play-only links are left out and never opened", async () => {
  const r = await searchAddon(ix, { type: "movie", imdbId: "tt0078748" });
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.results.map((x) => x.infoHash), [H1, H2, H2]);
  const [a, b] = r.results;
  assert.equal(a!.title, "Alien.1979.Directors.Cut.2160p.UHD.BluRay.x265");
  assert.equal(a!.size, 61_200_000_000);
  assert.equal(a!.seeders, 87);
  assert.ok(!JSON.stringify(r).includes(SECRET), "the play link (and the key in it) is not kept");
  assert.equal(b!.title, "Alien.1979.1080p.mkv");
  assert.equal(b!.size, 9_000_000_000);
  assert.equal(b!.seeders, 12);
  assert.match(b!.magnet!, new RegExp(`^magnet:\\?xt=urn:btih:${H2}&dn=`));
  assert.match(b!.magnet!, /&tr=udp%3A%2F%2Ftracker\.example%3A1337%2Fannounce/);
  assert.ok(!hits.some((h) => h.includes("/playback/")), "no play link requested");
  assert.equal(streamToResult(ix, { url: "https://cdn.example/x.mp4" }), null);
});

test("the manifest test says what's wrong in plain words and never shows the address", async () => {
  const ok = await addonManifest(ix);
  assert.deepEqual(ok, { ok: true, title: "Test Addon", searchTypes: ["movie", "series"] });
  const port = (addon.address() as AddressInfo).port;
  const cat = await addonManifest({ ...ix, url: `http://127.0.0.1:${port}/catalogs-only/manifest.json` });
  assert.equal(cat.ok, false);
  const gone = await addonManifest({ ...ix, url: `http://127.0.0.1:1/${SECRET}/manifest.json` });
  assert.equal(gone.ok, false);
  assert.ok(!JSON.stringify(gone).includes(SECRET));
  await assert.rejects(searchAddon({ ...ix, url: `http://127.0.0.1:${port}/${SECRET}x/manifest.json` }, { type: "movie", imdbId: "tt1" }), /IMDb/);
  await assert.rejects(searchAddon({ ...ix, url: `http://127.0.0.1:${port}/${SECRET}x/manifest.json` }, { type: "movie", imdbId: "tt0000001" }), (e: Error) => !e.message.includes(SECRET));
});

test("added addons: saved by name from the manifest, address hidden, searched by title, added like any result", async () => {
  const saved = await post("/api/indexers", { kind: "stremio", url: addonUrl.replace("http://", "http://"), apiKey: "ignored" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.test.ok, true);
  assert.equal(saved.body.indexer.name, "Test Addon");
  assert.equal(saved.body.indexer.hasKey, false);
  const list = await get("/api/indexers");
  assert.ok(!JSON.stringify(list.body).includes(SECRET), "the browser never sees the address path");
  assert.match(list.body.indexers[0].url, /^http:\/\/127\.0\.0\.1:\d+\/…$/);

  const s = await get("/api/acquire/search?q=Alien&type=movie&sources=" + saved.body.indexer.id);
  assert.equal(s.status, 200);
  assert.equal(lookups.at(-1), "movie:Alien");
  assert.deepEqual(s.body.results.map((r: any) => r.infoHash), [H1, H2], "the same torrent shows once, most seeders first");
  assert.equal(s.body.sources[0].note, "Alien (1979) · 1 play-only link left out");
  assert.ok(!JSON.stringify(s.body).includes(SECRET));

  // A show without an episode asks for S1 E1 and says so; with one, that episode.
  const tv1 = await get("/api/acquire/search?q=The%20Office&type=tvsearch&sources=" + saved.body.indexer.id);
  assert.match(tv1.body.sources[0].note, /S1 E1 \(type S2E5/, JSON.stringify(tv1.body));
  const tv = await get("/api/acquire/search?q=the%20office%20S02E05&sources=" + saved.body.indexer.id);
  assert.equal(lookups.at(-1), "tv:the office");
  assert.equal(tv.body.results[0].infoHash, H1);
  assert.equal(tv.body.sources[0].note, "The Office (2005), S2 E5");

  // A typed IMDb id needs no lookup.
  const n = lookups.length;
  const byId = await get("/api/acquire/search?q=tt0078748&type=movie&sources=" + saved.body.indexer.id);
  assert.equal(byId.body.results.length, 2);
  assert.equal(lookups.length, n);

  const miss = await get("/api/acquire/search?q=Nothing%20Like%20It&sources=" + saved.body.indexer.id);
  assert.match(miss.body.sources[0].error, /No IMDb id found/);

  // Adding goes through the normal gate: refused while adding is off, then a plain magnet add.
  await post("/api/sources", { provider: "torbox", key: "t".repeat(20) });
  const off = await post("/api/acquire/add", { result: s.body.results[1], provider: "torbox" });
  assert.equal(off.status, 409);
  assert.equal(mock.adds.length, 0);
  await post("/api/acquire/settings", { allowAdding: true });
  const a = await post("/api/acquire/add", { result: s.body.results[1], provider: "torbox" });
  assert.equal(a.status, 202);
  for (let i = 0; i < 200 && mock.adds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(mock.adds.at(-1)!.detail, new RegExp(`btih:${H2}`));
  assert.ok(!hits.some((h) => h.includes("/playback/")), "no play link requested");

  await post("/api/indexers/remove", { id: saved.body.indexer.id });
});

test("TMDB turns a typed title into an IMDb id once, then answers from its cache", async () => {
  const tmdb = await startTmdbMock({
    extra: {
      "/search/multi?query=Alien": { results: [{ id: 999, media_type: "person", name: "Alien" }, { id: 348, media_type: "movie", title: "Alien", release_date: "1979-05-25" }] },
      "/movie/348/external_ids": { imdb_id: "tt0078748" },
    },
  });
  try {
    const online = new OnlineMetadata({ apiBase: tmdb.apiBase, imageBase: tmdb.imageBase, spacingMs: 0 });
    assert.equal(await online.imdbFor("Alien"), null, "off until a key is set");
    assert.equal(tmdb.requests.length, 0);
    assert.equal((await online.setKey(TEST_KEY)).ok, true);
    const before = tmdb.requests.length;
    assert.deepEqual(await online.imdbFor("Alien"), { imdbId: "tt0078748", media: "movie", name: "Alien", year: 1979 });
    assert.equal(tmdb.requests.length - before, 2);
    await online.imdbFor("Alien");
    assert.equal(tmdb.requests.length - before, 2, "cached");
    assert.equal(await online.imdbFor("Zzz Unknown"), null);
    online.stop();
  } finally {
    await tmdb.close();
  }
});
