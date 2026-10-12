// Show identity: one show under many file names, look-alikes kept apart, arcs that
// are seasons, database ids as the strongest key, and the viewer's own fixes.
// Pure functions over parsed names; the corpus is test/fixtures/show-names.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseName } from "../src/library/parse.ts";
import { editDistance, placeEpisode, readShowName, resolveShows, sameSpelling, searchFor, type IdentityOverrides, type TmdbShow } from "../src/library/identity.ts";
import type { LibItem } from "../app/library.ts";
import { autoRules, usableLibrary } from "../app/lineup.ts";
import { queryFor } from "../app/metadata/tmdb.ts";
import { DIFFERENT_SHOWS, SAME_SHOW } from "./fixtures/show-names.ts";

process.env.DEBRIDTV_HOME = mkdtempSync(join(tmpdir(), "debridtv-identity-"));
const { ShowIdentity, placeItem, unitsOf } = await import("../app/shows.ts");

const MIN = 60_000;
let n = 0;
const item = (name: string, extra: Partial<LibItem> = {}): LibItem => ({
  id: `i${n++}`, provider: "torbox", ref: `tb:${n}`, name, bytes: 1, providerState: "", ready: true,
  parsed: parseName(name), durationMs: 24 * MIN, availability: "playable", present: true, ...extra,
});
type Ids = Record<string, { tmdb?: string }>;
/** Group these files and say where each one lands. */
function place(items: LibItem[], opts: { ids?: Ids; tmdb?: Record<string, TmdbShow>; overrides?: IdentityOverrides } = {}) {
  const units = unitsOf(items, (i) => (i.parsed.kind === "episode" ? opts.ids?.[i.parsed.searchAs?.show ?? i.parsed.show] : undefined));
  const res = resolveShows(units, { overrides: opts.overrides, tmdbShow: (id) => opts.tmdb?.[id] });
  return { res, out: items.map((i) => placeItem(i, res, new Map(units.map((u) => [u.id, u])))), units };
}
const ep = (i: LibItem) => {
  assert.equal(i.parsed.kind, "episode", i.name);
  return i.parsed as Extract<LibItem["parsed"], { kind: "episode" }>;
};

test("identity: every spelling in the corpus files under one show, at the right season and episode", () => {
  const items = SAME_SHOW.map((c) => item(c.name));
  const { out } = place(items);
  SAME_SHOW.forEach((c, k) => {
    const p = ep(out[k]!);
    assert.deepEqual([p.show, p.season, p.episode], [c.show, c.season, c.episode], c.name);
  });
  const shows = new Set(out.map((i) => ep(i).showKey));
  assert.equal(shows.size, new Set(SAME_SHOW.map((c) => c.show)).size, "one key per show");
});

test("identity: look-alikes stay two shows (remakes, US/UK, spin-offs, short names)", () => {
  for (const [a, b] of DIFFERENT_SHOWS) {
    const { out } = place([item(a), item(b)]);
    assert.notEqual(ep(out[0]!).showKey, ep(out[1]!).showKey, `${a} / ${b}`);
  }
});

test("identity: two years of one name get the year in their names; a name without a year joins the only year there is", () => {
  const { out } = place([item("Battlestar.Galactica.1978.S01E01.mkv"), item("Battlestar.Galactica.2004.S01E01.mkv"), item("Battlestar.Galactica.S01E02.mkv")]);
  assert.deepEqual(out.map((i) => ep(i).show), ["Battlestar Galactica (1978)", "Battlestar Galactica (2004)", "Battlestar Galactica"],
    "two years: the yearless file can't tell which, so it stays apart");
  const one = place([item("Arcane (2021)/Arcane.S01E01.mkv"), item("Arcane.S01E02.mkv")]).out;
  assert.equal(ep(one[0]!).showKey, ep(one[1]!).showKey);
  assert.equal(ep(one[0]!).show, "Arcane", "one show of that name: no year needed");
});

test("identity: copies of one episode under two spellings become copies (one airs), not two episodes", () => {
  const a = item("Dan.Da.Dan.S01E01.1080p.WEB.mkv", { provider: "torbox" });
  const b = item("[SubsPlease] Dandadan - 01 (1080p).mkv", { provider: "realdebrid" });
  const { out } = place([a, b]);
  const { usable } = usableLibrary(out);
  assert.equal(usable.length, 1, "one copy airs");
  assert.equal(usable[0]!.provider, "torbox");
});

test("identity: arcs keep their own seasons, so Phantom Blood and Stardust Crusaders episode 1 are both kept", () => {
  const files = [
    ...Array.from({ length: 4 }, (_, i) => item(`JoJo's Bizarre Adventure (2012) - S01E0${i + 1}.mkv`)),
    ...Array.from({ length: 4 }, (_, i) => item(`[HorribleSubs] JoJo's Bizarre Adventure - Stardust Crusaders - 0${i + 1} [720p].mkv`)),
  ];
  const { out } = place(files);
  assert.equal(new Set(out.map((i) => ep(i).showKey)).size, 1);
  const { usable } = usableLibrary(out);
  assert.equal(usable.length, 8, "no episode mistaken for another's copy");
  const rules = autoRules(out, []);
  const show = rules.find((r) => r.kind === "show")!;
  assert.equal(show.name, "JoJo's Bizarre Adventure");
  assert.equal(show.itemIds.length, 8, "one channel, both arcs, in order");
  assert.deepEqual(show.itemIds.slice(0, 5), [files[0]!.id, files[1]!.id, files[2]!.id, files[3]!.id, files[4]!.id]);
});

test("identity: an arc nothing knows becomes the next season; TMDB's season names place it exactly", () => {
  const files = [item("Bleach.S01E01.mkv"), item("Bleach.S02E01.mkv"), item("[Group] Bleach - Thousand-Year Blood War - 01.mkv")];
  assert.equal(ep(place(files).out[2]!).season, 3, "offline: after the seasons on disk");
  const tmdb: Record<string, TmdbShow> = { "30984": { name: "Bleach", seasons: [
    ...Array.from({ length: 16 }, (_, i) => ({ season: i + 1, name: `Season ${i + 1}`, episodes: 20 })),
    { season: 17, name: "Thousand-Year Blood War", episodes: 13 },
  ] } };
  const online = place(files, { ids: { Bleach: { tmdb: "30984" } }, tmdb }).out;
  assert.equal(ep(online[2]!).season, 17);
  // An unknown arc that TMDB names as a season of the show it found.
  const kk = place([item("Kaiju.S01E01.mkv"), item("Kaiju - Tokyo Arc - 03.mkv")], {
    ids: { Kaiju: { tmdb: "9" } }, tmdb: { "9": { name: "Kaiju", seasons: [{ season: 1, name: "Season 1", episodes: 12 }, { season: 2, name: "Tokyo", episodes: 11 }] } },
  }).out;
  assert.deepEqual([ep(kk[1]!).season, ep(kk[1]!).episode], [2, 3]);
});

test("identity: absolute numbers past season 1 move to later seasons when TMDB knows the episode counts", () => {
  const files = [item("[SubsPlease] Sousou no Frieren - 01 (1080p).mkv"), item("[SubsPlease] Sousou no Frieren - 29 (1080p).mkv")];
  const tmdb = { "209867": { name: "Frieren: Beyond Journey's End", seasons: [{ season: 1, episodes: 28 }, { season: 2, episodes: 10 }] } };
  const { out } = place(files, { ids: { "Frieren: Beyond Journey's End": { tmdb: "209867" } }, tmdb });
  assert.deepEqual([ep(out[0]!).season, ep(out[0]!).episode], [1, 1]);
  assert.deepEqual([ep(out[1]!).season, ep(out[1]!).episode, ep(out[1]!).absolute], [2, 1, undefined]);
  assert.deepEqual(placeEpisode(undefined, { season: 1, episode: 29, absolute: true }), { season: 1, episode: 29, absolute: true }, "offline: left alone");
});

test("identity: a shared database id joins names nothing else could; different ids keep one name apart", () => {
  const joined = place([item("Kimi.ni.Todoke.S01E01.mkv"), item("From.Me.to.You.S01E02.mkv")], {
    ids: { "Kimi ni Todoke": { tmdb: "1" }, "From Me to You": { tmdb: "1" } }, tmdb: { "1": { name: "Kimi ni Todoke: From Me to You" } },
  });
  assert.equal(new Set(joined.out.map((i) => ep(i).showKey)).size, 1);
  assert.equal(ep(joined.out[0]!).show, "Kimi ni Todoke: From Me to You", "TMDB's name when it has one");
  assert.equal(joined.res.groups[0]!.members.find((m) => m.why)?.why, "database id");
  // One name once "The" is dropped, but tvshow.nfo files say they are different shows.
  const a = item("The.Office.S01E01.mkv", { meta: { kind: "episode", showIds: { tmdb: "2316" } } });
  const b = item("Office.S01E02.mkv", { meta: { kind: "episode", showIds: { tmdb: "2996" } } });
  assert.equal(resolveShows(unitsOf([a, b], (i) => i.meta?.showIds)).groups.length, 2);
  assert.equal(resolveShows(unitsOf([a, b], () => undefined)).groups.length, 1, "without the ids they would be one");
});

test("identity: the viewer's merge, split and name win", () => {
  const files = [item("Kimi.ni.Todoke.S01E01.mkv"), item("From.Me.to.You.S01E02.mkv"), item("Dan.Da.Dan.S01E01.mkv"), item("Dandadan.S01E02.mkv")];
  const before = place(files);
  assert.equal(before.res.groups.length, 3);
  const [kimi, from] = [before.units.find((u) => u.name === "Kimi ni Todoke")!.id, before.units.find((u) => u.name === "From Me to You")!.id];
  const merged = place(files, { overrides: { merge: [[kimi, from]] } });
  assert.equal(ep(merged.out[0]!).showKey, ep(merged.out[1]!).showKey);
  assert.equal(merged.res.groups.find((g) => g.members.length === 2 && g.members.some((m) => m.unit === from))!.members.find((m) => m.unit === from)!.why, "you merged");
  const dandadan = before.units.find((u) => u.name === "Dandadan")!.id;
  const split = place(files, { overrides: { apart: [dandadan] } });
  assert.notEqual(ep(split.out[2]!).showKey, ep(split.out[3]!).showKey);
  const named = place(files, { overrides: { names: { "dan da dan": "DAN DA DAN" } } });
  assert.equal(ep(named.out[2]!).show, "DAN DA DAN");
  assert.equal(ep(named.out[2]!).showKey, "dan da dan", "the key stays put, so channels keep their settings");
});

test("identity: names are tidied without losing what tells shows apart", () => {
  const r = (s: string, y?: number) => readShowName(s, y);
  assert.deepEqual([r("The Office US").name, r("The Office US").base], ["The Office (US)", "office us"]);
  assert.equal(r("This Is Us").name, "This Is Us", "a title word, not a country");
  assert.equal(r("Avatar The Last Airbender COMPLETE SERIES Dual Audio").name, "Avatar The Last Airbender");
  assert.equal(r("Avatar - The Last Airbender Season 1-3 S01-S03 Complete Batch").base, "avatar the last airbender");
  assert.deepEqual([r("Dandadan 2nd Season").base, r("Dandadan 2nd Season").season], ["dandadan", 2]);
  assert.deepEqual([r("Mob Psycho 100 II").base, r("Mob Psycho 100 II").season], ["mob psycho 100", 2]);
  assert.deepEqual([r("Attack on Titan Season 3").name, r("Attack on Titan Season 3").season], ["Attack on Titan", 3]);
  assert.equal(r("Kimetsu no Yaiba - Yuukaku-hen").arc, "Yuukaku-hen");
  assert.equal(r("Shingeki no Kyojin / Attack on Titan").name, "Attack on Titan");
  assert.equal(r("JOJO'S BIZARRE ADVENTURES - STARDUST CRUSADERS").name, "JoJo's Bizarre Adventure");
  assert.equal(r("STAR TREK - DISCOVERY").name, "Star Trek - Discovery", "all caps read in title case; an unknown subtitle is part of the title");
  assert.equal(r("Pokémon").base, "pokemon");
  // What TMDB is asked for: the show, without an arc's or a later season's year.
  assert.deepEqual(searchFor({ name: "JoJo no Kimyou na Bouken - Stardust Crusaders", year: 2014 }), { show: "JoJo's Bizarre Adventure" });
  assert.deepEqual(searchFor({ name: "The Office US", year: 2005 }), { show: "The Office", year: 2005 });
});

test("identity: TMDB is asked about the show behind the name, not the release name or the arc", () => {
  const [arc, plain] = new ShowIdentity({ idsOf: () => undefined }).apply([
    item("[HorribleSubs] JoJo's Bizarre Adventure - Stardust Crusaders - 05 [720p].mkv"), item("JoJo's Bizarre Adventure (2012) - S01E01.mkv")]);
  assert.deepEqual(queryFor(arc!), { key: "tv|jojo s bizarre adventure|", media: "tv", title: "JoJo's Bizarre Adventure" });
  assert.deepEqual(queryFor(plain!), { key: "tv|jojo s bizarre adventure|2012", media: "tv", title: "JoJo's Bizarre Adventure", year: 2012 });
});

test("identity: spelling slips match; other words, numbers and short names don't", () => {
  for (const [a, b] of [["dandadan", "dan da dan"], ["braking bad", "breaking bad"], ["better caul saul", "better call saul"], ["jojos bizarre adventures", "jojos bizarre adventure"], ["spiderman the animated series", "spider man the animated series"]])
    assert.ok(sameSpelling(a, b), `${a} ~ ${b}`);
  for (const [a, b] of [["lost", "last"], ["fargo", "cargo"], ["dragon ball", "dragon ball z"], ["9 1 1", "9 1 1 lone star"], ["the 100", "the 101"], ["heroes", "herons"], ["gotham", "gotham knights"]])
    assert.ok(!sameSpelling(a, b), `${a} !~ ${b}`);
  assert.equal(editDistance("braking", "breaking"), 1);
  assert.equal(editDistance("adventrue", "adventure"), 1, "swapped letters count once");
});

test("identity: ShowIdentity keeps the viewer's fixes on disk and applies them to every view", () => {
  const files = [item("Kimi.ni.Todoke.S01E01.mkv"), item("From.Me.to.You.S01E02.mkv"), item("Dan.Da.Dan.S01E01.mkv"), item("Dandadan.S01E02.mkv")];
  const ids = new ShowIdentity({ idsOf: () => undefined });
  assert.equal(ids.groups(files).length, 3);
  const g = ids.merge(files, "from me to you", "kimi ni todoke")!;
  assert.equal(g.members.length, 2);
  const again = new ShowIdentity({ idsOf: () => undefined });
  const applied = again.apply(files);
  assert.equal(ep(applied[0]!).showKey, ep(applied[1]!).showKey, "read back from shows.json");
  assert.equal(again.view(files[1]!)!.parsed.kind === "episode" && (again.view(files[1]!)!.parsed as { showKey: string }).showKey, ep(applied[0]!).showKey);
  const dd = again.groups(files).find((x) => x.key === "dan da dan")!;
  const split = again.split(files, dd.members[1]!.unit)!;
  assert.equal(split.members.length, 1);
  assert.equal(again.groups(files).length, 3);
  again.rename(files, "dan da dan", "DAN DA DAN");
  assert.equal(again.groups(files).find((x) => x.key === "dan da dan")!.name, "DAN DA DAN");
  again.reset(files, "dan da dan");
  assert.equal(again.groups(files).length, 2, "reset: back to automatic, Dandadan joins again");
  const plain = item("Harbor.Lights.S01E01.mkv");
  assert.equal(again.apply([plain])[0], plain, "nothing to change: the same object");
  assert.deepEqual(again.export().apart, []);
  rmSync(process.env.DEBRIDTV_HOME!, { recursive: true, force: true });
});
