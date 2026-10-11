// Local .nfo metadata, hand-set ratings, and the channels and schedule rules built
// from them. Everything here is local: no provider or online lookup is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-meta-"));
process.env.DEBRIDTV_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { parseNfo } = await import("../src/library/nfo.ts");
const { Library, localMeta, effectiveRating } = await import("../app/library.ts");
const { Lineup, autoRules, metadataRules, scheduleRules } = await import("../app/lineup.ts");
const { Meters } = await import("../app/meters.ts");
const { StationClock } = await import("../src/clock/schedule.ts");
const { parseName } = await import("../src/library/parse.ts");
type LibItem = import("../app/library.ts").LibItem;
type NfoMeta = import("../src/library/nfo.ts").NfoMeta;

const MIN = 60_000;
let n = 0;
function item(name: string, over: Partial<LibItem> = {}): LibItem {
  n++;
  return { id: `m${n}`, provider: "local", ref: `/x/${n}`, name, bytes: 1e9, providerState: "on disk", ready: true,
    parsed: parseName(name), durationMs: 22 * MIN, availability: "listed", present: true, ...over };
}
const show = (name: string, count: number, meta: Partial<NfoMeta> = {}, minutes = 22) =>
  Array.from({ length: count }, (_, i) => item(`${name}.S01E${String(i + 1).padStart(2, "0")}.mkv`, { durationMs: minutes * MIN, meta: { kind: "episode", ...meta } }));

test("N-01c: Kodi movie, episode and show .nfo files are read; scores and nested blocks are not mistaken for fields", () => {
  const movie = parseNfo(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<!-- created by a scraper -->
<movie>
  <title>Back &amp; Forth</title>
  <ratings><rating name="imdb" max="10" default="true"><value>7.9</value></rating></ratings>
  <mpaa>Rated PG-13</mpaa>
  <genre>Comedy</genre><genre>Sci-Fi / Adventure</genre>
  <set><name>Back Trilogy</name><overview>Three films.</overview></set>
  <studio>Imaginary Pictures</studio>
  <premiered>1985-07-03</premiered>
  <actor><name>Somebody</name><role>Doc</role></actor>
  <plot><![CDATA[A teen <b>travels</b> in time.]]></plot>
</movie>`)!;
  assert.equal(movie.kind, "movie");
  assert.equal(movie.title, "Back & Forth");
  assert.equal(movie.rating, "PG-13");
  assert.equal(movie.ratingText, "Rated PG-13");
  assert.deepEqual(movie.genres, ["Comedy", "Sci-Fi", "Adventure"]);
  assert.equal(movie.collection, "Back Trilogy");
  assert.equal(movie.year, 1985);
  assert.equal(movie.plot, "A teen travels in time.");
  assert.deepEqual(movie.studios, ["Imaginary Pictures"]);

  const ep = parseNfo(`<episodedetails><title>The One With It</title><season>2</season><episode>5</episode><aired>1996-01-04</aired></episodedetails>
<episodedetails><title>Second half</title><season>2</season><episode>6</episode></episodedetails>`)!;
  assert.deepEqual([ep.kind, ep.title, ep.season, ep.episode, ep.rating], ["episode", "The One With It", 2, 5, undefined]);

  const tv = parseNfo(`<tvshow><title>Friends-ish</title><mpaa>US:TV-PG</mpaa><genre>Comedy</genre><studio>NBC</studio><set>Plain set</set></tvshow>`)!;
  assert.deepEqual([tv.kind, tv.rating, tv.studios?.[0]], ["show", "PG", "NBC"]);
  assert.equal(parseNfo("https://www.themoviedb.org/movie/105"), null, "URL-only hint files carry nothing");
  assert.equal(parseNfo("<musicvideo><title>x</title></musicvideo>"), null);
  assert.equal(parseNfo("<movie><set>Plain set</set><mpaa>NR</mpaa></movie>")!.collection, "Plain set");
  assert.equal(parseNfo("<movie><mpaa>NR</mpaa></movie>")!.rating, undefined, "not rated stays unknown");
});

test("N-01c: a local file's metadata comes from its own .nfo, movie.nfo, and the nearest tvshow.nfo inside the chosen folder", () => {
  const root = mkdtempSync(join(tmpdir(), "debridtv-nfo-"));
  try {
    mkdirSync(join(root, "Show", "Season 1"), { recursive: true });
    writeFileSync(join(root, "tvshow.nfo"), "<tvshow><mpaa>TV-MA</mpaa></tvshow>"); // above the chosen folder: never read
    const lib = join(root, "Show", "..");
    writeFileSync(join(root, "Show", "tvshow.nfo"), "<tvshow><title>Show</title><mpaa>TV-14</mpaa><genre>Drama</genre><studio>HBO-ish</studio></tvshow>");
    writeFileSync(join(root, "Show", "Season 1", "Show.S01E01.nfo"), "<episodedetails><title>Pilot</title><season>1</season><episode>1</episode></episodedetails>");
    const e1 = localMeta(join(root, "Show", "Season 1", "Show.S01E01.mkv"), lib, "episode")!;
    assert.deepEqual([e1.title, e1.rating, e1.genres?.[0], e1.studios?.[0]], ["Pilot", "PG-13", "Drama", "HBO-ish"]);
    const e2 = localMeta(join(root, "Show", "Season 1", "Show.S01E02.mkv"), lib, "episode")!;
    assert.deepEqual([e2.title, e2.rating], [undefined, "PG-13"], "no episode .nfo: the show's still applies");

    mkdirSync(join(root, "Films", "Heat (1995)"), { recursive: true });
    writeFileSync(join(root, "Films", "Heat (1995)", "movie.nfo"), "<movie><title>Heat</title><mpaa>R</mpaa></movie>");
    assert.equal(localMeta(join(root, "Films", "Heat (1995)", "Heat.1995.mkv"), join(root, "Films"), "movie")!.rating, "R");
    assert.equal(localMeta(join(root, "Films", "Other.2001.mkv"), join(root, "Films"), "movie"), null);
    const loose = mkdtempSync(join(tmpdir(), "debridtv-nfo-loose-"));
    try {
      writeFileSync(join(loose, "A.Show.S01E01.mkv"), "");
      assert.equal(localMeta(join(loose, "A.Show.S01E01.mkv"), loose, "episode"), null);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N-01c: a local scan stores .nfo metadata, and hand-set ratings win over it", () => {
  const root = mkdtempSync(join(tmpdir(), "debridtv-scan-"));
  try {
    mkdirSync(join(root, "Cartoon Hour"));
    writeFileSync(join(root, "Cartoon Hour", "tvshow.nfo"), "<tvshow><mpaa>TV-Y7</mpaa><genre>Animation</genre></tvshow>");
    for (let i = 1; i <= 3; i++) writeFileSync(join(root, "Cartoon Hour", `Cartoon.Hour.S01E0${i}.mkv`), "x");
    writeFileSync(join(root, "Late.Film.1999.mkv"), "x");
    writeFileSync(join(root, "Late.Film.1999.nfo"), "<movie><mpaa>R</mpaa><genre>Thriller</genre></movie>");
    const lib = new Library(() => ({ localDirs: [root] }), new Meters(), () => {});
    lib.refreshLocal();
    const items = lib.items().filter((i) => i.ref.startsWith(root));
    const toon = items.find((i) => i.name.includes("S01E02"))!;
    const film = items.find((i) => i.name.startsWith("Late"))!;
    assert.equal(toon.meta?.rating, "G");
    assert.equal(film.meta?.genres?.[0], "Thriller");
    assert.deepEqual(effectiveRating(film, lib.manualRatings()), { rating: "R", from: "nfo" });
    assert.ok(lib.setRating({ itemId: film.id }, "PG-13"));
    assert.ok(lib.setRating({ showKey: toon.parsed.kind === "episode" ? toon.parsed.showKey : "" }, "PG"));
    assert.deepEqual(effectiveRating(film, lib.manualRatings()), { rating: "PG-13", from: "you" });
    assert.equal(lib.mediaItems().find((m) => m.id === toon.id)!.rating, "PG");
    assert.ok(lib.setRating({ itemId: film.id }, null));
    assert.equal(lib.mediaItems().find((m) => m.id === film.id)!.rating, "R");
    assert.equal(lib.setRating({ itemId: film.id }, "X" as never), false);
    assert.equal(lib.importRatings({ items: { [film.id]: "G", bogus: "XXX" } }), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N-04: network, genre and collection channels come from metadata, with thresholds", () => {
  const items = [
    ...show("Alpha", 6, { genres: ["Comedy"], studios: ["NBC"] }),
    ...show("Bravo", 6, { genres: ["Comedy"], studios: ["NBC"] }),
    ...show("Charlie", 6, { genres: ["Drama"], studios: ["NBC"] }),
    ...show("Delta", 30, { genres: ["Drama"], studios: ["ABC"] }, 44),
    ...["Rocket One.1984", "Rocket Two.1986", "Rocket Three.1990"].map((t, i) =>
      item(`${t}.mkv`, { durationMs: 100 * MIN, meta: { kind: "movie", collection: "Rocket", year: 1984 + i * 2, genres: ["Sci-Fi"] } })),
    item("Lonely.2001.mkv", { durationMs: 120 * MIN, meta: { kind: "movie", collection: "Pair", genres: ["Comedy"] } }),
    item("Lonely 2.2003.mkv", { durationMs: 120 * MIN, meta: { kind: "movie", collection: "Pair", genres: ["Comedy"] } }),
  ];
  const rules = metadataRules(items);
  const byKey = new Map(rules.map((r) => [r.key, r]));
  const nbc = byKey.get("network:nbc")!;
  assert.equal(nbc.name, "NBC");
  assert.equal(nbc.itemIds.length, 18);
  assert.equal(byKey.has("network:abc"), false, "one show isn't a network");
  const comedy = byKey.get("genre:comedy")!;
  assert.equal(comedy.tagline, "Comedy shows and films");
  assert.equal(comedy.itemIds.length, 14);
  assert.equal(byKey.has("genre:sci-fi"), false, "three films, under eight hours");
  assert.ok(byKey.has("genre:drama"));
  const rocket = byKey.get("collection:rocket")!;
  assert.equal(rocket.name, "Rocket Collection");
  assert.deepEqual(rocket.itemIds, items.filter((i) => i.meta?.collection === "Rocket").map((i) => i.id), "release order");
  assert.equal(byKey.has("collection:pair"), false, "two films aren't a collection");
  // The same rules arrive through autoRules, with numbers in their own ranges.
  const lu = new Lineup("lineup-meta.json");
  lu.sync(new StationClock([]), autoRules(items, []), Date.now());
  const num = (key: string) => lu.channels().find((c) => c.meta.ruleKey === key)!.number;
  assert.ok(num("network:nbc") >= 20 && num("network:nbc") < 30);
  assert.ok(num("genre:comedy") >= 30 && num("genre:comedy") < 40);
  assert.equal(num("collection:rocket"), 40);
});

test("N-06a/N-09a: kid, restricted hours and slots reach the clock, and change only after what's on ends (C7)", () => {
  const toons = show("Toons", 8, { rating: "G" });
  const late = show("Late", 8, { rating: "R" });
  const unrated = show("Mystery", 8);
  const all = [...toons, ...late, ...unrated];
  const ratingOf = (i: LibItem) => i.meta?.rating;
  const clock = new StationClock(all.map((i) => ({ id: i.id, title: i.name, durationMs: i.durationMs, rating: ratingOf(i), source: { provider: "local" as const, ref: i.ref },
    showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined, episode: i.parsed.kind === "episode" ? i.parsed.episode : undefined })));
  const rules = autoRules(all, []);
  const lu = new Lineup("lineup-audience.json");
  const t0 = Date.UTC(2026, 9, 11, 12, 7);
  lu.sync(clock, rules, t0, { timeZone: "UTC" });
  const mix = () => lu.allChannels().find((c) => c.meta.ruleKey === "mix:half-hour")!;
  const lastRev = () => mix().revisions[mix().revisions.length - 1]!;
  assert.equal(lastRev().maxRating, undefined);

  assert.deepEqual(lu.updateSettings("mix:half-hour", { kid: true }), { ok: true });
  const onNow = clock.airingAt(mix(), t0 + MIN)!;
  lu.sync(clock, rules, t0 + MIN, { timeZone: "UTC" });
  assert.equal(lastRev().maxRating, "PG");
  assert.equal(lastRev().effectiveFromMs, onNow.endMs, "waits for the end of the current airing");
  const after = clock.airingsBetween(mix(), onNow.endMs, onNow.endMs + 24 * 60 * MIN);
  assert.ok(after.length > 0 && after.every((a) => toons.some((t) => t.id === a.itemId)), "only rated-G cartoons; R and unrated stay off");

  lu.updateSettings("mix:half-hour", { kid: false, restrictedHours: [{ from: "06:00", to: "20:00", maxRating: "PG" }],
    slots: [{ days: [1, 2, 3, 4, 5, 6, 7], from: "20:00", to: "22:00", source: "show:late" }, { days: [1], from: "08:00", to: "09:00", source: "show:gone" }] });
  lu.sync(clock, rules, t0 + 2 * MIN, { timeZone: "UTC" });
  const dp = lastRev().dayparts!;
  assert.equal(dp.timeZone, "UTC");
  assert.equal(dp.rules.length, 2, "a slot whose source channel doesn't exist is dropped");
  assert.equal(dp.rules[0]!.program!.key, "show:late");
  const later = lastRev().effectiveFromMs;
  for (const a of clock.airingsBetween(mix(), later, later + 3 * 24 * 60 * MIN)) {
    const h = new Date(a.startMs).getUTCHours();
    if (h >= 6 && h < 20) assert.ok(toons.some((t) => t.id === a.itemId), `${a.itemId} at ${h}h`);
    if (h >= 20 && h < 22) assert.ok(late.some((t) => t.id === a.itemId), `slot plays Late at ${h}h`);
  }
  // Nothing changed: no new revision.
  const count = mix().revisions.length;
  lu.sync(clock, rules, t0 + 3 * MIN, { timeZone: "UTC" });
  assert.equal(mix().revisions.length, count);
  // Same settings, other zone: a new revision follows the new local time.
  lu.sync(clock, rules, t0 + 4 * MIN, { timeZone: "America/Chicago" });
  assert.equal(lastRev().dayparts!.timeZone, "America/Chicago");
  assert.deepEqual(scheduleRules({}, new Map(), "UTC"), { maxRating: undefined, dayparts: undefined });
});

test("N-05: season-0 specials stay off a show's channel unless asked for, then air after the last season", () => {
  const regular = show("Echo", 6);
  const specials = [item("Echo.S00E01.Holiday.mkv"), item("Echo.S00E02.Reunion.mkv")];
  const all = [...specials, ...regular];
  const clock = new StationClock(all.map((i) => ({ id: i.id, title: i.name, durationMs: i.durationMs, source: { provider: "local" as const, ref: i.ref } })));
  const lu = new Lineup("lineup-specials.json");
  const t0 = Date.UTC(2026, 9, 11, 12, 7);
  lu.sync(clock, autoRules(all, []), t0);
  const ch = () => lu.allChannels().find((c) => c.meta.ruleKey === "show:echo")!;
  const ids = () => ch().revisions[ch().revisions.length - 1]!.itemIds;
  assert.deepEqual(ids(), regular.map((i) => i.id));
  lu.updateSettings("show:echo", { specials: true });
  lu.sync(clock, autoRules(all, []), t0 + MIN);
  assert.deepEqual(ids(), [...regular, ...specials].map((i) => i.id), "specials come after the regular seasons");
  assert.equal(lu.settingsFor("show:echo").specials, true);
});

test("N-37: banner badges prefer header facts and fall back to release-name tags", async () => {
  const { mediaBadges } = await import("../app/library.ts");
  assert.deepEqual(mediaBadges(item("Show.S01E01.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10.H.265.mkv")), { hdr: "dv", height: 2160, audioChannels: 6, atmos: true });
  assert.deepEqual(mediaBadges(item("Movie.2019.1080p.BluRay.HDR10+.x265.TrueHD.7.1.mkv")), { hdr: "hdr10+", height: 1080, audioChannels: 8 });
  assert.deepEqual(mediaBadges(item("Old.Show.S01E01.AAC2.0.mkv")), { audioChannels: 2 });
  const probed = item("Plain.Name.S01E01.mkv", { tracks: [
    { kind: "video", index: 0, codec: "hevc", lang: "und", height: 1080, hdr: "hlg" },
    { kind: "audio", index: 0, codec: "aac", lang: "eng", channels: 2 },
    { kind: "audio", index: 1, codec: "eac3", lang: "eng", channels: 6, default: true },
  ] });
  assert.deepEqual(mediaBadges(probed), { hdr: "hlg", height: 1080, audioChannels: 6 }, "the default audio track counts");
});

test("N-09b/N-05/N-10/N-09a: exclusions, watched rules, reshuffle and weights shape a channel at sync", async () => {
  const { shapeRule, mixRules } = await import("../app/lineup.ts").then((m) => m);
  const alpha = show("Alpha", 6, { genres: ["Comedy"] });
  const bravo = show("Bravo", 6, { genres: ["Horror"] });
  const all = [...alpha, ...bravo];
  const watched = new Set([alpha[0]!.id, alpha[1]!.id]);
  const info = (id: string) => {
    const i = all.find((x) => x.id === id)!;
    return { showKey: i.parsed.kind === "episode" ? i.parsed.showKey : undefined, genres: i.meta?.genres, watched: watched.has(id), recent: id === bravo[5]!.id };
  };
  const rule = { key: "mix:test", name: "Test", kind: "mix" as const, tagline: "", itemIds: all.map((i) => i.id), ordering: "round-robin-cyclic" as const };
  assert.deepEqual(shapeRule(rule, { exclude: { genres: ["horror"] } }, {}, info)!.itemIds, alpha.map((i) => i.id), "genre matched loosely");
  assert.deepEqual(shapeRule(rule, { exclude: { shows: ["alpha", "bravo"] } }, {}, info)!.itemIds, rule.itemIds, "a channel never goes dark from its own exclusions");
  assert.equal(shapeRule({ ...rule, itemIds: bravo.map((i) => i.id) }, {}, { shows: ["bravo"] }, info), null, "excluded everywhere: the channel goes");
  assert.deepEqual(shapeRule(rule, { watched: "unwatched" }, {}, info)!.itemIds, all.slice(2).map((i) => i.id));
  const resumed = shapeRule(rule, { watched: "resume" }, {}, info)!.itemIds;
  assert.deepEqual(resumed.slice(0, 6), [...alpha.slice(2), ...alpha.slice(0, 2)].map((i) => i.id), "Alpha picks up at episode 3");
  assert.deepEqual(resumed.slice(6), bravo.map((i) => i.id), "nothing watched: from the start");
  const m = mixRules({ weights: { alpha: 80 }, balance: "time", marathons: true, premieres: true, reshuffle: 2 }, rule, info);
  assert.equal(m.seed, "mix:test~2");
  assert.deepEqual(m.mix, { weights: { alpha: 80 }, balance: "duration", marathon: { chance: 0.03, maxMs: 4 * 60 * MIN }, premieres: [bravo[5]!.id] });
  assert.deepEqual(mixRules({}, rule, info), { seed: "mix:test", mix: undefined });

  // Through sync: a reshuffle and weights become a new revision after the current program.
  const clock = new StationClock(all.map((i) => ({ id: i.id, title: i.name, durationMs: i.durationMs, showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined, source: { provider: "local" as const, ref: i.ref } })));
  const lu = new Lineup("lineup-shape.json");
  const t0 = Date.UTC(2026, 9, 11, 12, 7);
  lu.sync(clock, autoRules(all, []), t0, { info });
  const key = "mix:half-hour";
  const ch = () => lu.allChannels().find((c) => c.meta.ruleKey === key)!;
  const onNow = clock.airingAt(ch(), t0 + MIN)!;
  lu.updateSettings(key, { reshuffle: true, weights: { alpha: 100, bravo: 0 } });
  lu.sync(clock, autoRules(all, []), t0 + MIN, { info });
  const rev = ch().revisions[ch().revisions.length - 1]!;
  assert.equal(rev.effectiveFromMs, onNow.endMs);
  assert.equal(rev.seed, `${key}~1`);
  const later = clock.airingsBetween(ch(), rev.effectiveFromMs, rev.effectiveFromMs + 6 * 60 * MIN);
  assert.ok(later.length > 5 && later.every((a) => alpha.some((x) => x.id === a.itemId)), "weight 0 keeps Bravo off");
});
