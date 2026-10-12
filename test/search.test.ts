// Indexer and Internet Archive search against a local server serving fixture
// answers. No real network is touched.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { searchIndexer, indexerCaps, searchArchive, redactUrl, parseRss, type Indexer } from "../src/acquire/search.ts";

const KEY = "s3cretkey123";

const TORZNAB = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <title>Test</title>
  <!-- <item><title>commented out</title></item> -->
  <item>
    <title><![CDATA[Night of the Living Dead (1968) Tom & Jerry <Restored>]]></title>
    <guid>https://tracker.example/details/42</guid>
    <link>https://tracker.example/dl/42.torrent?passkey=x&amp;id=42</link>
    <comments>https://tracker.example/details/42#comments</comments>
    <pubDate>Mon, 05 Oct 2026 12:00:00 +0000</pubDate>
    <size>999</size>
    <category>2000</category>
    <enclosure url="https://tracker.example/dl/42.torrent?passkey=x&amp;id=42" length="1468006400" type="application/x-bittorrent" />
    <torznab:attr name="category" value="2040"/>
    <torznab:attr name="seeders" value="57"/>
    <torznab:attr name="peers" value="63"/>
    <torznab:attr name="infohash" value="AABBCCDDEEFF00112233445566778899AABBCCDD"/>
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:AABBCCDDEEFF00112233445566778899AABBCCDD&amp;dn=notld"/>
  </item>
  <item>
    <title>Caf&#233; &#x2014; Base32 &quot;Edition&quot;</title>
    <guid isPermaLink="false">abc-guid</guid>
    <link>magnet:?xt=urn:btih:VKVMZTHO5YABCIRTIRKWM54ITGVLXTG5&amp;dn=x</link>
    <torznab:attr name="size" value="2048"/>
    <torznab:attr name="seeders" value="0"/>
  </item>
</channel>
</rss>`;

const NEWZNAB = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel>
  <item>
    <title>Some.Show.S01E02.1080p.WEB-DL</title>
    <guid isPermaLink="true">https://nzb.example/details/abc</guid>
    <link>https://nzb.example/getnzb/abc.nzb&amp;i=1&amp;r=${KEY}</link>
    <pubDate>Tue, 06 Oct 2026 08:30:00 +0000</pubDate>
    <enclosure url="https://nzb.example/getnzb/abc.nzb&amp;i=1&amp;r=${KEY}" length="734003200" type="application/x-nzb"/>
    <newznab:attr name="category" value="5040"/>
    <newznab:attr name="size" value="734003200"/>
  </item>
</channel>
</rss>`;

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.0" title="Prowlarr &amp; Friends" />
  <limits max="100" default="100"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <tv-search available="yes" supportedParams="q,season,ep"/>
    <movie-search available="no" supportedParams="q"/>
    <audio-search available="yes"></audio-search>
  </searching>
</caps>`;

const ARCHIVE = {
  responseHeader: { status: 0 },
  response: {
    numFound: 2,
    docs: [
      { identifier: "night_of_the_living_dead", title: "Night of the Living Dead", year: "1968", item_size: 1234567, downloads: 900000 },
      { identifier: "plan9", title: ["Plan 9 from Outer Space"], item_size: "42" },
      { title: "no identifier, skipped" },
    ],
  },
};

const seen: URL[] = [];
let base = "";
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  seen.push(u);
  const xml = (body: string, status = 200) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(body);
  };
  if (u.pathname === "/torznab/api") {
    if (u.searchParams.get("t") === "caps") return xml(CAPS);
    return xml(TORZNAB);
  }
  if (u.pathname === "/newznab/api") return xml(NEWZNAB);
  if (u.pathname === "/badkey/api") return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<error code="100" description="Incorrect user credentials"/>`);
  if (u.pathname === "/echokey/api")
    return xml(`<error code="100" description="Key ${u.searchParams.get("apikey")} is not valid (apikey=${u.searchParams.get("apikey")})"/>`, 401);
  if (u.pathname === "/broken/api") return xml("oops", 500);
  if (u.pathname === "/slow/api") return; // never answers
  if (u.pathname === "/advancedsearch.php") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(ARCHIVE));
  }
  xml("nope", 404);
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const ix = (path: string, kind: Indexer["kind"] = "torznab", extra = ""): Indexer => ({
  id: path,
  name: `Test ${path}`,
  url: `${base}/${path}/api${extra}`,
  apiKey: KEY,
  kind,
});

test("torznab: attrs, CDATA with entities, enclosure torrent link and details page", async () => {
  const rs = await searchIndexer(ix("torznab"), { q: "night of the living dead", type: "movie", imdbId: "tt0063350", limit: 50 });
  assert.equal(rs.length, 2);
  const r = rs[0]!;
  assert.equal(r.title, "Night of the Living Dead (1968) Tom & Jerry <Restored>");
  assert.equal(r.kind, "torrent");
  assert.equal(r.source, "Test torznab");
  assert.equal(r.sourceId, "torznab");
  assert.equal(r.seeders, 57);
  assert.equal(r.peers, 63);
  assert.equal(r.infoHash, "aabbccddeeff00112233445566778899aabbccdd");
  assert.equal(r.id, "torznab:aabbccddeeff00112233445566778899aabbccdd");
  assert.equal(r.magnet, "magnet:?xt=urn:btih:AABBCCDDEEFF00112233445566778899AABBCCDD&dn=notld");
  assert.equal(r.torrentUrl, "https://tracker.example/dl/42.torrent?passkey=x&id=42");
  assert.equal(r.nzbUrl, undefined);
  assert.equal(r.size, 1468006400, "enclosure length beats <size> when no size attr");
  assert.equal(r.category, "2040");
  assert.equal(r.published, Date.UTC(2026, 9, 5, 12, 0, 0));
  assert.equal(r.infoUrl, "https://tracker.example/details/42#comments");

  const u = seen.at(-1)!;
  assert.equal(u.searchParams.get("t"), "movie");
  assert.equal(u.searchParams.get("q"), "night of the living dead");
  assert.equal(u.searchParams.get("imdbid"), "0063350");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(u.searchParams.get("extended"), "1");
  assert.equal(u.searchParams.get("apikey"), KEY);
});

test("torznab: base32 magnet link becomes a hex info hash, numeric entities decode", async () => {
  const r = (await searchIndexer(ix("torznab"), { q: "x" }))[1]!;
  assert.equal(r.title, 'Café — Base32 "Edition"');
  assert.equal(r.infoHash, "aaaacccceeee00112233445566778899aabbccdd");
  assert.match(r.magnet!, /^magnet:\?xt=urn:btih:VKVM/);
  assert.equal(r.torrentUrl, undefined);
  assert.equal(r.size, 2048);
  assert.equal(r.seeders, 0);
  assert.equal(r.peers, null);
  assert.equal(r.infoUrl, undefined, "a non-URL guid is not a details page");
});

test("tvsearch params, and a query string already in the indexer URL is kept", async () => {
  await searchIndexer(ix("torznab", "torznab", "?cat=5000"), { q: "show", type: "tvsearch", season: 1, episode: 2 });
  const u = seen.at(-1)!;
  assert.equal(u.searchParams.get("t"), "tvsearch");
  assert.equal(u.searchParams.get("season"), "1");
  assert.equal(u.searchParams.get("ep"), "2");
  assert.equal(u.searchParams.get("cat"), "5000");
});

test("newznab: usenet item with an nzb link", async () => {
  const [r] = await searchIndexer(ix("newznab", "newznab"), { q: "some show" });
  assert.equal(r!.kind, "usenet");
  assert.equal(r!.nzbUrl, `https://nzb.example/getnzb/abc.nzb&i=1&r=${KEY}`);
  assert.equal(r!.torrentUrl, undefined);
  assert.equal(r!.magnet, undefined);
  assert.equal(r!.size, 734003200);
  assert.equal(r!.category, "5040");
  assert.equal(r!.seeders, null);
  assert.equal(r!.infoUrl, "https://nzb.example/details/abc");
  assert.equal(r!.id, "newznab:https://nzb.example/details/abc");
});

test("caps: server title and the search types marked available", async () => {
  const caps = await indexerCaps(ix("torznab"));
  assert.deepEqual(caps, { ok: true, title: "Prowlarr & Friends", searchTypes: ["search", "tv-search", "audio-search"] });
  assert.equal(seen.at(-1)!.searchParams.get("t"), "caps");
  const bad = await indexerCaps(ix("badkey"));
  assert.deepEqual(bad, { ok: false, error: "Indexer said: Incorrect user credentials" });
});

test("an <error> reply is thrown with its description and never the API key", async () => {
  await assert.rejects(searchIndexer(ix("badkey"), { q: "x" }), (e: Error) => {
    assert.equal(e.message, "Indexer said: Incorrect user credentials");
    return true;
  });
  await assert.rejects(searchIndexer(ix("echokey"), { q: "x" }), (e: Error) => {
    assert.ok(!e.message.includes(KEY), e.message);
    assert.match(e.message, /Incorrect|not valid/);
    return true;
  });
});

test("HTTP 500 without an error document", async () => {
  await assert.rejects(searchIndexer(ix("broken"), { q: "x" }), { message: "Indexer said HTTP 500" });
});

test("timeout and caller abort", async () => {
  await assert.rejects(searchIndexer(ix("slow"), { q: "x" }, { timeoutMs: 100 }), /No answer from the indexer within/);
  const ac = new AbortController();
  const p = searchIndexer(ix("slow"), { q: "x" }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, { message: "Search cancelled" });
});

test("a connection failure doesn't leak the key", async () => {
  const dead: Indexer = { id: "d", name: "dead", url: "http://127.0.0.1:1/api", apiKey: KEY, kind: "torznab" };
  await assert.rejects(searchIndexer(dead, { q: "x" }), (e: Error) => {
    assert.match(e.message, /^Could not reach the indexer/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  const caps = await indexerCaps(dead);
  assert.equal(caps.ok, false);
});

test("Internet Archive: query, mapping and torrent links", async () => {
  const rs = await searchArchive('night: "of" (the)', { base, rows: 10 });
  const u = seen.at(-1)!;
  assert.equal(u.pathname, "/advancedsearch.php");
  assert.equal(u.searchParams.get("q"), 'title:(night\\: \\"of\\" \\(the\\)) AND mediatype:(movies)');
  assert.deepEqual(u.searchParams.getAll("fl[]"), ["identifier", "title", "year", "item_size", "downloads"]);
  assert.equal(u.searchParams.get("sort[]"), "downloads desc");
  assert.equal(u.searchParams.get("rows"), "10");
  assert.equal(u.searchParams.get("output"), "json");
  assert.equal(rs.length, 2);
  assert.deepEqual(rs[0], {
    id: "archive:night_of_the_living_dead",
    source: "Internet Archive",
    sourceId: "archive",
    kind: "torrent",
    title: "Night of the Living Dead (1968)",
    size: 1234567,
    seeders: null,
    peers: null,
    torrentUrl: `${base}/download/night_of_the_living_dead/night_of_the_living_dead_archive.torrent`,
    infoUrl: `${base}/details/night_of_the_living_dead`,
  });
  assert.equal(rs[1]!.title, "Plan 9 from Outer Space");
  assert.equal(rs[1]!.size, 42);
});

test("redactUrl hides the key and leaves the rest", () => {
  assert.equal(redactUrl("https://h/api?t=search&apikey=abc123&q=x"), "https://h/api?t=search&apikey=***&q=x");
  assert.equal(redactUrl("https://h/api?APIKEY=abc#frag"), "https://h/api?APIKEY=***#frag");
  assert.equal(redactUrl("https://h/api?t=caps"), "https://h/api?t=caps");
});

test("parseRss keeps all categories and ignores items in comments", () => {
  const items = parseRss(TORZNAB);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0]!.categories, ["2000"]);
  assert.equal(items[0]!.attrs.seeders, "57");
  assert.equal(items[0]!.enclosure.type, "application/x-bittorrent");
  assert.deepEqual(parseRss("<rss><channel></channel></rss>"), []);
});
