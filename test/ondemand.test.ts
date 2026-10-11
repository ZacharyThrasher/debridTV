// On Demand and Continue Watching (N-30), and the channel watched rules (N-05):
// pure functions over library and history facts, no server, no provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName } from "../src/library/parse.ts";
import { WatchLedger } from "../src/history/watched.ts";
import type { LibItem } from "../app/library.ts";
import { browse, continueWatching, nextUp, show, type OnDemandDeps } from "../app/ondemand.ts";
import { shapeRule, type ItemInfo, type Rule } from "../app/lineup.ts";

const MIN = 60_000;
const item = (name: string, minutes = 22, extra: Partial<LibItem> = {}): LibItem => ({
  id: name.replace(/\W+/g, "-").toLowerCase(), provider: "local", ref: `/m/${name}`, name, bytes: 1, providerState: "", ready: true,
  parsed: parseName(name), durationMs: minutes * MIN, availability: "playable", present: true, ...extra,
});

const lib = [
  ...Array.from({ length: 5 }, (_, i) => item(`Alpha.Show.S01E0${i + 1}.mkv`)),
  item("Alpha.Show.S02E01.mkv", 22, { subtitle: "The Lighthouse" }),
  item("Alpha.Show.S00E01.mkv"),
  ...Array.from({ length: 3 }, (_, i) => item(`Beta.Show.S01E0${i + 1}.mkv`, 44)),
  item("Zed.Movie.1999.mkv", 100),
  item("Able.Movie.2004.mkv", 95),
  item("Refused.Movie.2001.mkv", 90, { availability: "policy-blocked" }),
  item("Gone.Movie.2002.mkv", 90, { present: false }),
];
const id = (name: string) => item(name).id;

function deps(ledger: WatchLedger, locked: string[] = []): OnDemandDeps {
  return {
    items: lib,
    seenMs: (i) => ledger.seenMs(i),
    furthestMs: (i) => ledger.furthestMs(i),
    watched: (i, d) => (d ? ledger.isWatched(i, d) : false),
    locked: (i) => locked.includes(i),
    extra: () => ({ availability: "playable" }),
  };
}

test("N-30: browse lists shows by name and films by title; refused, removed and locked files are left out", () => {
  const d = deps(new WatchLedger(), [id("Able.Movie.2004.mkv")]);
  const all = browse(d);
  assert.deepEqual(all.shows.map((s) => s.name), ["Alpha Show", "Beta Show"]);
  assert.deepEqual(all.movies.map((m) => m.title), ["Zed Movie"]);
  const alpha = all.shows[0]!;
  assert.equal(alpha.episodes, 7);
  assert.deepEqual(alpha.seasons, [1, 2, 0], "specials last");
  assert.equal(alpha.nextUp?.label, "S1 · E1", "nothing seen: start at the beginning");
  assert.equal(browse(d, "", "movie").shows.length, 0);
  assert.equal(browse(d, "", "show").movies.length, 0);
  assert.deepEqual(browse(d, "lighthouse").shows.map((s) => s.name), ["Alpha Show"], "episode subtitles match");
  assert.deepEqual(browse(d, "lighthouse").episodes.map((e) => e.label), ["S2 · E1"], "and the episode itself");
  assert.deepEqual(all.episodes, [], "no search, no episode list");
  assert.deepEqual(browse(d, "zed").movies.map((m) => m.title), ["Zed Movie"]);
});

test("N-30: resume point is the furthest time seen; under a minute or watched means none", () => {
  const led = new WatchLedger();
  led.record(id("Zed.Movie.1999.mkv"), 0, 30 * 1000);
  let m = browse(deps(led)).movies.find((x) => x.title === "Zed Movie")!;
  assert.equal(m.resumeMs, null);
  led.record(id("Zed.Movie.1999.mkv"), 10 * MIN, 25 * MIN);
  m = browse(deps(led)).movies.find((x) => x.title === "Zed Movie")!;
  assert.equal(m.resumeMs, 25 * MIN);
  assert.equal(m.seenMs, 15 * MIN + 30_000);
  led.record(id("Zed.Movie.1999.mkv"), 0, 100 * MIN);
  m = browse(deps(led)).movies.find((x) => x.title === "Zed Movie")!;
  assert.equal(m.resumeMs, null);
  assert.equal(m.watched, true);
});

test("N-30: next up follows the last finished episode; the show page groups seasons", () => {
  const led = new WatchLedger();
  const d = deps(led);
  led.record(id("Alpha.Show.S01E02.mkv"), 0, 22 * MIN);
  const alpha = lib.filter((i) => i.name.startsWith("Alpha"));
  assert.equal(nextUp(d, alpha)?.id, id("Alpha.Show.S01E03.mkv"), "E1 unseen doesn't matter: after the last finished one");
  led.record(id("Alpha.Show.S01E04.mkv"), 0, 5 * MIN);
  assert.equal(nextUp(d, alpha)?.id, id("Alpha.Show.S01E04.mkv"), "one in progress after it comes first");
  for (const n of [3, 4, 5]) led.record(id(`Alpha.Show.S01E0${n}.mkv`), 0, 22 * MIN);
  led.record(id("Alpha.Show.S02E01.mkv"), 0, 22 * MIN);
  assert.equal(nextUp(d, alpha)?.id, id("Alpha.Show.S00E01.mkv"), "specials after the regular seasons");
  led.record(id("Alpha.Show.S00E01.mkv"), 0, 22 * MIN);
  assert.equal(nextUp(d, alpha), null, "all caught up");
  const page = show(d, alpha[0]!.parsed.kind === "episode" ? alpha[0]!.parsed.showKey : "")!;
  assert.deepEqual(page.seasons.map((s) => [s.season, s.episodes.length]), [[1, 5], [2, 1], [0, 1]]);
  assert.equal(show(d, "nope"), null);
});

test("N-30: continue watching: in-progress programs and next episodes, one row per show, newest first", () => {
  const led = new WatchLedger();
  const d = deps(led);
  led.record(id("Zed.Movie.1999.mkv"), 0, 40 * MIN);
  led.record(id("Beta.Show.S01E01.mkv"), 0, 44 * MIN);
  led.record(id("Alpha.Show.S01E01.mkv"), 0, 22 * MIN);
  led.record(id("Alpha.Show.S01E02.mkv"), 0, 3 * MIN);
  led.record(id("Able.Movie.2004.mkv"), 0, 95 * MIN);
  const recent = [
    { at: 500, itemId: id("Able.Movie.2004.mkv"), channel: "ch-1" },
    { at: 400, itemId: id("Alpha.Show.S01E02.mkv"), channel: "ondemand" },
    { at: 300, itemId: id("Alpha.Show.S01E01.mkv"), channel: "ch-2" },
    { at: 200, itemId: id("Beta.Show.S01E01.mkv"), channel: "ch-3" },
    { at: 100, itemId: id("Zed.Movie.1999.mkv"), channel: "ch-4" },
  ];
  const c = continueWatching(d, recent).items;
  assert.deepEqual(c.map((x) => [x.id, x.reason, x.lastAt, x.channel]), [
    [id("Alpha.Show.S01E02.mkv"), "resume", 400, "ondemand"],
    [id("Beta.Show.S01E02.mkv"), "next", 200, "ch-3"],
    [id("Zed.Movie.1999.mkv"), "resume", 100, "ch-4"],
  ], "a finished film drops off; Alpha appears once");
  assert.equal(c[0]!.resumeMs, 3 * MIN);
  assert.equal(continueWatching(d, recent, 1).items.length, 1);
  assert.equal(continueWatching(deps(led, [id("Zed.Movie.1999.mkv")]), recent).items.length, 2, "locked items are left out");
});

// ---------------------------------------------------------------- N-05 watched rules

const rule: Rule = { key: "show:alpha", name: "Alpha", kind: "show", tagline: "", ordering: "cyclic",
  itemIds: ["a1", "a2", "a3", "a4", "b1", "b2", "b3"] };
const infoOf = (watched: string[]) => (i: string): ItemInfo => ({ showKey: i[0], watched: watched.includes(i) });

test("N-05: watched 'all' leaves the lineup alone", () => {
  assert.equal(shapeRule(rule, {}, {}, infoOf(["a1", "a2"])), rule);
  assert.equal(shapeRule(rule, { watched: "all" }, {}, infoOf(["a1"])), rule);
});

test("N-05: 'unwatched' drops watched programs, but never empties the channel", () => {
  assert.deepEqual(shapeRule(rule, { watched: "unwatched" }, {}, infoOf(["a1", "a3", "b2"]))!.itemIds, ["a2", "a4", "b1", "b3"]);
  assert.deepEqual(shapeRule(rule, { watched: "unwatched" }, {}, infoOf(rule.itemIds))!.itemIds, rule.itemIds, "all watched: keep everything");
});

test("N-05: 'resume' starts each show after its last watched episode, keeping each show's places in the list", () => {
  // a: last watched a2 -> a3 a4 a1 a2. b: nothing watched -> unchanged.
  assert.deepEqual(shapeRule(rule, { watched: "resume" }, {}, infoOf(["a2"]))!.itemIds, ["a3", "a4", "a1", "a2", "b1", "b2", "b3"]);
  // Last watched counts, not the first gap: a1 and a3 watched -> after a3.
  assert.deepEqual(shapeRule(rule, { watched: "resume" }, {}, infoOf(["a1", "a3", "b3"]))!.itemIds, ["a4", "a1", "a2", "a3", "b1", "b2", "b3"]);
  // A show watched to its last episode starts over at its first.
  assert.deepEqual(shapeRule(rule, { watched: "resume" }, {}, infoOf(["a4"]))!.itemIds, rule.itemIds);
});

test("N-05: watched rules apply after exclusions and specials", () => {
  const r = { ...rule, specialIds: ["a4"] };
  assert.deepEqual(shapeRule(r, { watched: "unwatched" }, {}, infoOf(["a1"]))!.itemIds, ["a2", "a3", "b1", "b2", "b3"]);
  assert.deepEqual(shapeRule(r, { watched: "unwatched", exclude: { shows: ["b"] } }, {}, infoOf(["a1"]))!.itemIds, ["a2", "a3"]);
});
