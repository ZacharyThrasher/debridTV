// Search + add (Settings → Add) against the mock providers and a local fake
// indexer. Nothing here touches a real account or the real network.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "debridtv-acquire-"));
process.env.DEBRIDTV_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { createApp } = await import("../app/server.ts");
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { parsePaste, pickFiles } = await import("../app/acquire.ts");
const { parseMagnet, parseTorrent, hashToMagnet, base32ToHex } = await import("../src/acquire/torrent.ts");

// ------------------------------------------------------------ bencode helper

function benc(v: unknown): Buffer {
  if (typeof v === "number") return Buffer.from(`i${v}e`);
  if (typeof v === "string") return Buffer.concat([Buffer.from(`${Buffer.byteLength(v)}:`), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(benc), Buffer.from("e")]);
  const o = v as Record<string, unknown>;
  return Buffer.concat([Buffer.from("d"), ...Object.keys(o).sort().flatMap((k) => [benc(k), benc(o[k])]), Buffer.from("e")]);
}
const INFO = { name: "Old.Film.1950", "piece length": 16384, pieces: "x".repeat(20), files: [{ length: 700, path: ["Old.Film.1950.mkv"] }, { length: 9, path: ["Sample", "sample.mkv"] }] };
const TORRENT = benc({ announce: "http://tracker.invalid/announce", info: INFO });
const INFO_HASH = createHash("sha1").update(benc(INFO)).digest("hex");

// ------------------------------------------------------------ pure parts

test("magnets, bare hashes and .torrent files are read without the network", () => {
  assert.equal(parseMagnet("magnet:?xt=urn:btih:AABBCCDDEEFF00112233445566778899AABBCCDD&dn=Name").infoHash, "aabbccddeeff00112233445566778899aabbccdd");
  assert.equal(parseMagnet("magnet:?xt=urn:btih:AABBCCDDEEFF00112233445566778899AABBCCDD&dn=Name").name, "Name");
  assert.equal(base32ToHex("VKVMZTHO5YABCIRTIRKWM54ITGVLXTG5")?.length, 40);
  assert.equal(hashToMagnet("  AABBCCDDEEFF00112233445566778899AABBCCDD "), "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd");
  assert.equal(hashToMagnet("not a hash"), null);
  const t = parseTorrent(new Uint8Array(TORRENT));
  assert.equal(t.infoHash, INFO_HASH);
  assert.equal(t.name, "Old.Film.1950");
  assert.deepEqual(t.files.map((f) => f.path), ["Old.Film.1950/Old.Film.1950.mkv", "Old.Film.1950/Sample/sample.mkv"]);
  assert.throws(() => parseTorrent(new TextEncoder().encode("<html>")));
});

test("a paste becomes one add per line, and junk lines are named back", () => {
  const { inputs, skipped } = parsePaste([
    "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd",
    "aabbccddeeff00112233445566778899aabbccdd",
    "https://example.org/files/x.torrent",
    "https://nzb.example/api?t=get&id=5",
    "https://example.org/video.mkv",
    "hello there",
    "",
    "https://example.org/files/x.torrent",
  ].join("\n"));
  assert.deepEqual(inputs.map((i) => i.kind), ["magnet", "magnet", "torrent-url", "nzb-url", "web"]);
  assert.deepEqual(skipped, ["hello there"]);
});

test("Real-Debrid keeps the videos and leaves samples and extras behind", () => {
  const files = [{ id: 1, path: "/A/Show.S01E01.mkv", bytes: 1, selected: 0 }, { id: 2, path: "/A/Sample/sample.mkv", bytes: 1, selected: 0 },
    { id: 3, path: "/A/info.nfo", bytes: 1, selected: 0 }, { id: 4, path: "/A/Show.S01E02-sample.mkv", bytes: 1, selected: 0 }];
  assert.deepEqual(pickFiles(files), [1]);
  assert.equal(pickFiles([{ id: 1, path: "/readme.txt", bytes: 1, selected: 0 }]), "all");
});

// ------------------------------------------------------------ against the app

const KEY = "indexerkey12345";
let refuseAdds = false;
const mock = await startMockProviders({ files: [], rdAddRefused: () => refuseAdds });
const hits: string[] = [];
// One local server plays a Torznab indexer, the Internet Archive and a site whose .torrent link redirects to a magnet.
const fake = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  hits.push(req.url!);
  if (u.pathname === "/ix/api") {
    if (u.searchParams.get("apikey") !== KEY) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/xml" });
    if (u.searchParams.get("t") === "caps") return void res.end(`<caps><server title="Fake"/><searching><search available="yes"/></searching></caps>`);
    return void res.end(`<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
      <item><title>Old Film 1950</title><guid>g1</guid><link>${base()}/ix/dl/1.torrent?jackett_apikey=${KEY}</link><size>700</size>
        <torznab:attr name="seeders" value="3"/></item>
      <item><title>Old Film 1950 Better</title><guid>g2</guid><link>${base()}/ix/dl/2.torrent?apikey=${KEY}</link>
        <torznab:attr name="seeders" value="40"/><torznab:attr name="infohash" value="${"c".repeat(40)}"/></item>
    </channel></rss>`);
  }
  if (u.pathname.startsWith("/ix/dl/")) {
    if (u.searchParams.get("jackett_apikey") !== KEY && u.searchParams.get("apikey") !== KEY) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/x-bittorrent" });
    return void res.end(TORRENT);
  }
  if (u.pathname === "/to-magnet.torrent") {
    res.writeHead(302, { location: "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Redirected" });
    return void res.end();
  }
  if (u.pathname === "/advancedsearch.php") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ response: { docs: [{ identifier: "old_film_1950", title: "Old Film", year: "1950", item_size: 500 }] } }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const base = () => `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

const app = createApp({
  port: 0, ffmpeg: false, timers: false,
  bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` },
  acquire: { archiveBase: base(), timing: { rdSpacingMs: 0, tbSpacingMs: 0, rdHoldsMs: [40, 40], rdPollMs: 5, refreshAfterMs: 5 } },
});
let url = "";
before(async () => {
  url = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  await mock.close();
  await new Promise((r) => fake.close(r));
});

const get = async (p: string) => {
  const r = await fetch(url + p);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const j = (await get("/api/acquire/jobs")).body.jobs.find((x: any) => x.id === id);
    if (j && (j.state === "added" || j.state === "failed")) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("add never finished");
}

test("nothing is added while adding is off, and the providers hear nothing", async () => {
  await post("/api/sources", { provider: "realdebrid", key: "r".repeat(20) });
  await post("/api/sources", { provider: "torbox", key: "t".repeat(20) });
  const r = await post("/api/acquire/add", { text: "aabbccddeeff00112233445566778899aabbccdd" });
  assert.equal(r.status, 409);
  assert.equal(r.body.addingOff, true);
  assert.equal(mock.adds.length, 0);
  const s = await post("/api/acquire/settings", { allowAdding: true, addTo: "realdebrid" });
  assert.equal(s.body.allowAdding, true);
  assert.deepEqual(s.body.targets, ["torbox", "realdebrid"]);
});

test("a pasted magnet goes to Real-Debrid, which keeps only the episode", async () => {
  const r = await post("/api/acquire/add", { text: "magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd&dn=Show.S01" });
  assert.equal(r.status, 202);
  const job = await settled(r.body.jobs[0].id);
  assert.equal(job.state, "added", job.message);
  assert.equal(job.infoHash, "aabbccddeeff00112233445566778899aabbccdd");
  assert.equal(mock.adds.at(-1)!.endpoint, "addMagnet");
  assert.equal(mock.counters.api["rd.selectFiles"], 1);
  assert.match(job.message, /Ready/);
});

test("a Real-Debrid 451 waits and tries again; a refused name fails at once with a plain reason", async () => {
  refuseAdds = true;
  setTimeout(() => (refuseAdds = false), 60);
  const r = await post("/api/acquire/add", { text: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Film.2020.1080p.x265" });
  const job = await settled(r.body.jobs[0].id);
  assert.equal(job.state, "added", job.message);

  refuseAdds = true;
  const before = mock.counters.api["rd.addMagnet"]!;
  const r2 = await post("/api/acquire/add", { text: "magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&dn=Film.2020.1080p.WEB-DL.x264" });
  const j2 = await settled(r2.body.jobs[0].id);
  refuseAdds = false;
  assert.equal(j2.state, "failed");
  assert.match(j2.message, /WEB-DL.*TorBox/);
  assert.equal(mock.counters.api["rd.addMagnet"]! - before, 1, "a refused name is asked once, not held and retried");
});

test("TorBox takes .torrent files, web links and Usenet; Real-Debrid refuses links it can't take", async () => {
  const f = await post("/api/acquire/add", { file: TORRENT.toString("base64"), name: "Old.Film.1950.torrent", provider: "torbox" });
  const j = await settled(f.body.jobs[0].id);
  assert.equal(j.state, "added", j.message);
  assert.equal(j.infoHash, INFO_HASH);
  assert.deepEqual([mock.adds.at(-1)!.endpoint, mock.adds.at(-1)!.detail], ["createtorrent", "Old.Film.1950.torrent"]);

  const w = await post("/api/acquire/add", { text: "https://example.org/public-domain.mkv", provider: "torbox" });
  await settled(w.body.jobs[0].id);
  assert.deepEqual([mock.adds.at(-1)!.endpoint, mock.adds.at(-1)!.detail], ["createwebdownload", "https://example.org/public-domain.mkv"]);

  const n = await post("/api/acquire/add", { text: "https://nzb.example/x.nzb" });
  await settled(n.body.jobs[0].id);
  assert.equal(mock.adds.at(-1)!.endpoint, "createusenetdownload", "Usenet always goes to TorBox");

  const refused = await post("/api/acquire/add", { text: "https://example.org/video.mkv", provider: "realdebrid" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /TorBox/);
});

test("a .torrent link that redirects to a magnet is added as that magnet", async () => {
  const r = await post("/api/acquire/add", { result: { title: "Redirected", torrentUrl: `${base()}/to-magnet.torrent` } });
  const j = await settled(r.body.jobs[0].id);
  assert.equal(j.state, "added", j.message);
  assert.match(mock.adds.at(-1)!.detail, /btih:d{40}/);
});

test("indexer keys stay on the PC: masked in lists and results, put back only to download", async () => {
  const saved = await post("/api/indexers", { name: "My indexer", url: `${base()}/ix/api`, apiKey: KEY, kind: "torznab" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.test.ok, true);
  const list = await get("/api/indexers");
  assert.equal(list.body.indexers[0].hasKey, true);
  assert.ok(!JSON.stringify(list.body).includes(KEY));

  const s = await get("/api/acquire/search?q=old%20film");
  assert.equal(s.status, 200);
  assert.ok(!JSON.stringify(s.body).includes(KEY), "no key in search results");
  assert.deepEqual(s.body.results.map((r: any) => r.source), ["My indexer", "My indexer", "Internet Archive"], "most seeders first");
  assert.ok(s.body.sources.every((x: any) => x.error === null));

  // The 3-seeder result has no hash or magnet, so DebridTV fetches its .torrent with the real key.
  const pick = s.body.results.find((r: any) => r.seeders === 3);
  const a = await post("/api/acquire/add", { result: pick, provider: "torbox" });
  const j = await settled(a.body.jobs[0].id);
  assert.equal(j.state, "added", j.message);
  assert.ok(hits.some((h) => h.startsWith("/ix/dl/1.torrent") && h.includes(KEY)));

  await post("/api/indexers/remove", { id: saved.body.indexer.id });
  assert.equal((await get("/api/indexers")).body.indexers.length, 0);
});

test("files dropped in the watched folder are added, then filed under added/", async () => {
  const dir = join(home, "watch");
  mkdirSync(dir);
  const bad = await post("/api/acquire/settings", { watchDir: join(home, "nope") });
  assert.equal(bad.status, 400);
  await post("/api/acquire/settings", { watchDir: dir });
  writeFileSync(join(dir, "film.magnet"), "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=Folder.Film\n");
  writeFileSync(join(dir, "notes.doc"), "ignored");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, "film.magnet"), old, old);
  const r = await post("/api/acquire/folder", {});
  assert.equal(r.body.queued, 1);
  for (let i = 0; i < 200 && !existsSync(join(dir, "added", "film.magnet")); i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(existsSync(join(dir, "added", "film.magnet")));
  assert.ok(existsSync(join(dir, "notes.doc")));

  // Turning adding off stops the folder too.
  await post("/api/acquire/settings", { allowAdding: false });
  writeFileSync(join(dir, "later.magnet"), "magnet:?xt=urn:btih:1111111111111111111111111111111111111111");
  utimesSync(join(dir, "later.magnet"), old, old);
  assert.equal((await post("/api/acquire/folder", {})).body.queued, 0);
});
