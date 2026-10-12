// "What's missing" and "New this week" for show channels, from TMDB air dates.
// Information only: counts aired episodes the library lacks, never adds anything.
// Runs against test/tmdb-mock.ts with dates set relative to today.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTmdbMock, TEST_KEY } from "./tmdb-mock.ts";

const home = mkdtempSync(join(tmpdir(), "debridtv-missing-home-"));
process.env.DEBRIDTV_HOME = home;
const { OnlineMetadata } = await import("../app/metadata/tmdb.ts");
const { showGaps, gapsFrom, dayIn } = await import("../app/missing.ts");
const { parseName } = await import("../src/library/parse.ts");
type LibItem = import("../app/library.ts").LibItem;
type ShowSchedule = import("../app/metadata/tmdb.ts").ShowSchedule;

const today = dayIn(Date.now());
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Night Owls (TMDB 4242): season 1 ended long ago, season 2 is on the air now.
const mock = await startTmdbMock({
  extra: {
    "/tv/4242": {
      id: 4242, name: "Night Owls", status: "Returning Series", number_of_seasons: 2,
      seasons: [
        { season_number: 0, episode_count: 2, air_date: "1995-12-24" },
        { season_number: 1, episode_count: 10, air_date: "1994-09-12" },
        { season_number: 2, episode_count: 8, air_date: day(-30) },
      ],
      last_episode_to_air: { season_number: 2, episode_number: 5, air_date: day(-2), name: "Static" },
      next_episode_to_air: { season_number: 2, episode_number: 6, air_date: day(5), name: "Call-In Night" },
    },
    "/tv/4242/season/2": {
      season_number: 2,
      episodes: [-30, -23, -16, -6, -2, 5, 12, 19].map((d, i) => ({ episode_number: i + 1, air_date: day(d), name: `Ep ${i + 1}` })),
    },
  },
});
after(async () => {
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});
const fast = { apiBase: mock.apiBase, imageBase: mock.imageBase, spacingMs: 0 };

let n = 0;
function item(name: string, over: Partial<LibItem> = {}): LibItem {
  n++;
  return { id: `m${n}`, provider: "torbox", ref: `tb:${n}`, name, bytes: 1e9, providerState: "cached", ready: true,
    parsed: parseName(name), durationMs: 1_320_000, availability: "listed", present: true, ...over };
}

const library = [
  "Night.Owls.S01E01.mkv", "Night.Owls.S01E02E03.mkv", // a two-episode file counts as both
  "Night.Owls.S01E05.mkv", "Night.Owls.S01E06.mkv", "Night.Owls.S01E08.mkv", "Night.Owls.S01E09.mkv", "Night.Owls.S01E10.mkv",
  "Night.Owls.S02E01.mkv", "Night.Owls.S02E02.mkv", "Night.Owls.S02E03.mkv", "Night.Owls.S02E05.mkv",
].map((x) => item(x));
const locked = item("Night.Owls.S02E04.mkv");
const items = [...library, locked];
const showKey = library[0]!.parsed.kind === "episode" ? library[0]!.parsed.showKey : "";

test("missing: off without TMDB, and nothing is asked", async () => {
  const om = new OnlineMetadata(fast);
  const got = await showGaps(showKey, { items, locked: () => false, online: om });
  assert.equal(got, null);
  assert.equal(mock.requests.length, 0);
});

test("missing: counts aired episodes per season, new this week and what airs next", async () => {
  writeFileSync(join(home, "tmdb-key.json"), JSON.stringify({ key: TEST_KEY }));
  const om = new OnlineMetadata(fast);
  await om.sync(items); // the usual lookup makes the show match
  mock.requests.length = 0;
  const deps = { items, locked: (id: string) => id === locked.id, online: om };
  const g = await showGaps(showKey, deps);
  assert.ok(g);
  assert.equal(g.name, "Night Owls");
  assert.equal(g.tmdbId, 4242);
  // Specials are left out: the library has none. Season 2 counts only what has aired.
  assert.deepEqual(g.seasons, [
    { season: 1, have: 8, aired: 10, total: 10, missing: [4, 7] },
    { season: 2, have: 4, aired: 5, total: 8, missing: [4] }, // E04 sits only on a locked channel, so it isn't counted
  ]);
  assert.deepEqual(g.newThisWeek, [
    { season: 2, episode: 4, name: "Ep 4", airDate: day(-6), inLibrary: false },
    { season: 2, episode: 5, name: "Ep 5", airDate: day(-2), inLibrary: true },
  ]);
  assert.deepEqual(g.nextAir, { season: 2, episode: 6, airDate: day(5), name: "Ep 6" });

  // Only the show id went out: the details and the season on the air now. Then it's cached.
  const urls = mock.requests.map((r) => r.url.split("?")[0]);
  assert.deepEqual(urls, ["/3/tv/4242", "/3/tv/4242/season/2"]);
  for (const r of mock.requests) assert.doesNotMatch(r.url, /query=|Night|Owls|mkv/i);
  mock.requests.length = 0;
  await showGaps(showKey, deps);
  await showGaps(showKey, { ...deps, online: new OnlineMetadata(fast) });
  assert.equal(mock.requests.length, 0, "kept on disk for 12 hours");
});

test("missing: unknown shows, locked shows and TMDB turned off give nothing", async () => {
  const om = new OnlineMetadata(fast);
  mock.requests.length = 0;
  assert.equal(await showGaps("no such show", { items, locked: () => false, online: om }), null);
  assert.equal(await showGaps(showKey, { items, locked: () => true, online: om }), null, "every copy locked: not looked up");
  const unmatched = [item("Never.Heard.Of.It.S01E01.mkv")];
  const k = unmatched[0]!.parsed.kind === "episode" ? unmatched[0]!.parsed.showKey : "";
  assert.equal(await showGaps(k, { items: unmatched, locked: () => false, online: om }), null, "no TMDB match yet: no new search");
  assert.equal(mock.requests.length, 0);
  await om.setKey(null);
  assert.equal(await showGaps(showKey, { items, locked: () => false, online: om }), null);
});

test("missing: an ended show is answered by the counts; seasons on air use dates; absolute numbering maps to seasons", () => {
  const ended: ShowSchedule = {
    id: 1, name: "Old Show", at: 0, nextAir: null, episodes: {},
    seasons: [{ season: 1, episodeCount: 3, airDate: "2001-01-01" }, { season: 2, episodeCount: 4, airDate: "2002-01-01" }],
    lastAired: { season: 2, episode: 4, airDate: "2002-03-01" },
  };
  const eps = ["Old Show - 01.mkv", "Old Show - 02.mkv", "Old Show - 05.mkv"].map((x) => item(x)); // absolute 5 = S02E02
  const g = gapsFrom("old show", eps, ended, "2026-10-12");
  assert.deepEqual(g.seasons, [
    { season: 1, have: 2, aired: 3, total: 3, missing: [3] },
    { season: 2, have: 1, aired: 4, total: 4, missing: [1, 3, 4] },
  ]);
  assert.deepEqual(g.newThisWeek, []);
  assert.equal(g.nextAir, null);

  // Aired means aired by today: an episode dated tomorrow isn't missing yet.
  const airing: ShowSchedule = {
    ...ended, nextAir: null,
    seasons: [{ season: 1, episodeCount: 3, airDate: "2026-09-01" }],
    lastAired: { season: 1, episode: 3, airDate: "2026-10-13" }, // TMDB is a day ahead of the station
    episodes: { "1": [{ episode: 1, airDate: "2026-09-29" }, { episode: 2, airDate: "2026-10-06" }, { episode: 3, airDate: "2026-10-13", name: "Finale" }] },
  };
  const g2 = gapsFrom("old show", [item("Old.Show.S01E01.mkv")], airing, "2026-10-12");
  assert.deepEqual(g2.seasons, [{ season: 1, have: 1, aired: 2, total: 3, missing: [2] }]);
  assert.deepEqual(g2.newThisWeek, [{ season: 1, episode: 2, airDate: "2026-10-06", inLibrary: false }]);
  assert.deepEqual(g2.nextAir, { season: 1, episode: 3, airDate: "2026-10-13", name: "Finale" });
  // Specials show up once the library has one.
  const g3 = gapsFrom("old show", [item("Old.Show.S00E01.mkv")], { ...ended, seasons: [{ season: 0, episodeCount: 2, airDate: "2001-12-24" }, ...ended.seasons] }, "2026-10-12");
  assert.deepEqual(g3.seasons[0], { season: 0, have: 1, aired: 2, total: 2, missing: [2] });
});
