import { test } from "node:test";
import assert from "node:assert/strict";
import { StationClock } from "../src/clock/schedule.ts";
import { inDates, localFields, seasonState, windows, zonedMs } from "../src/clock/dayparts.ts";
import { normalizeRating, allowedUnder } from "../src/clock/ratings.ts";
import type { Channel, ChannelRevision, MediaItem } from "../src/clock/types.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = "America/New_York";

function item(id: string, minutes: number, rating?: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { id, title: id, durationMs: minutes * MIN, rating, source: { provider: "local", ref: id }, ...extra };
}

function chan(rev: Omit<ChannelRevision, "effectiveFromMs" | "seed"> & Partial<ChannelRevision>): Channel {
  return { id: "c", number: 5, name: "C", revisions: [{ effectiveFromMs: Date.UTC(2026, 9, 5, 4), seed: "c", ...rev }] };
}

/** Local "HH:MM" of an instant in TZ. */
function hhmm(ms: number): string {
  const f = localFields(ms, TZ);
  return `${String(f.h).padStart(2, "0")}:${String(f.min).padStart(2, "0")}`;
}
function localMinutes(ms: number): number {
  const f = localFields(ms, TZ);
  return f.h * 60 + f.min;
}

test("ratings: film and TV wordings fold onto one scale; anything unclear is unknown", () => {
  assert.equal(normalizeRating("Rated PG-13"), "PG-13");
  assert.equal(normalizeRating("US:R"), "R");
  assert.equal(normalizeRating("pg13"), "PG-13");
  assert.equal(normalizeRating("TV-14"), "PG-13");
  assert.equal(normalizeRating("TV-Y7"), "G");
  assert.equal(normalizeRating("TV-MA"), "R");
  assert.equal(normalizeRating("DE:12 / US:PG"), "PG");
  assert.equal(normalizeRating("NR"), null);
  assert.equal(normalizeRating("Unrated"), null);
  assert.equal(normalizeRating(undefined), null);
  assert.ok(allowedUnder("G", "PG"));
  assert.ok(!allowedUnder("R", "PG-13"));
  assert.ok(!allowedUnder(undefined, "NC-17"), "D7: unknown never passes a limit");
  assert.ok(allowedUnder(undefined, undefined), "no limit, anything goes");
});

test("C5: local times resolve across DST in a named zone", () => {
  // 2026-03-08: New York springs forward at 02:00 → 03:00. 02:30 never happens.
  assert.equal(zonedMs({ y: 2026, m: 3, d: 8 }, 150, TZ), Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(zonedMs({ y: 2026, m: 3, d: 8 }, 60, TZ), Date.UTC(2026, 2, 8, 6, 0));
  assert.equal(zonedMs({ y: 2026, m: 3, d: 8 }, 22 * 60, TZ), Date.UTC(2026, 2, 9, 2, 0));
  // 2026-11-01: falls back at 02:00 → 01:00. 01:30 happens twice; take the first (EDT).
  assert.equal(zonedMs({ y: 2026, m: 11, d: 1 }, 90, TZ), Date.UTC(2026, 10, 1, 5, 30));
  assert.equal(zonedMs({ y: 2026, m: 11, d: 1 }, 22 * 60, TZ), Date.UTC(2026, 10, 2, 3, 0));
  // A zone with a half-hour offset and none of this.
  assert.equal(zonedMs({ y: 2026, m: 6, d: 1 }, 0, "Asia/Kolkata"), Date.UTC(2026, 4, 31, 18, 30));
});

test("windows: an overnight rule is one window per night, on local time through a DST change", () => {
  const dp = { timeZone: TZ, rules: [{ from: "22:00", to: "06:00", maxRating: "PG-13" as const }] };
  const ws = [...take(windows(dp, Date.UTC(2026, 9, 28, 12)), 13)].slice(1); // the first starts at local midnight
  for (const w of ws) {
    assert.equal(hhmm(w.startMs), w.maxRating ? "22:00" : "06:00");
    assert.equal(hhmm(w.endMs), w.maxRating ? "06:00" : "22:00");
  }
  // The night of the fall-back change is an hour longer in UTC.
  const night = ws.find((w) => w.maxRating && w.startMs > Date.UTC(2026, 9, 31, 12) && w.startMs < Date.UTC(2026, 10, 1, 12))!;
  assert.equal(night.endMs - night.startMs, 9 * HOUR);
});

test("windows: earlier slots win overlaps; rating limits combine to the strictest", () => {
  const prog = (key: string) => ({ key, itemIds: [key], ordering: "cyclic" as const });
  const dp = {
    timeZone: "UTC",
    rules: [
      { days: [6], from: "08:00", to: "11:00", program: prog("a") },
      { days: [6], from: "10:00", to: "12:00", program: prog("b") },
      { from: "09:00", to: "10:30", maxRating: "PG" as const },
    ],
  };
  const sat = Date.UTC(2026, 9, 10); // a Saturday
  const ws = [...take(windows(dp, sat, "PG-13"), 8)].filter((w) => w.startMs < sat + DAY);
  const at = (h: number) => ws.find((w) => w.startMs <= sat + h * HOUR && w.endMs > sat + h * HOUR)!;
  assert.equal(at(8.5).program, 0);
  assert.equal(at(8.5).maxRating, "PG-13");
  assert.equal(at(9.5).maxRating, "PG");
  assert.equal(at(10.5).program, 0, "first slot keeps its time");
  assert.equal(at(11.5).program, 1);
  assert.equal(at(13).program, -1);
});

test("N-06a: a kid channel airs only what's rated PG or lower; unrated stays off (D7)", () => {
  const lib = [item("g", 22, "G"), item("pg", 22, "TV-PG"), item("r", 22, "R"), item("nr", 22)];
  const ch = chan({ itemIds: lib.map((m) => m.id), ordering: "shuffle", slotMs: 30 * MIN, maxRating: "PG" });
  const clock = new StationClock(lib);
  const t0 = ch.revisions[0]!.effectiveFromMs;
  const seen = new Set(clock.airingsBetween(ch, t0, t0 + 2 * DAY).map((a) => a.itemId));
  assert.deepEqual([...seen].sort(), ["g", "pg"]);
  assert.deepEqual(clock.excluded(ch.revisions[0]!), [{ itemId: "r", reason: "rated-above" }, { itemId: "nr", reason: "unrated" }]);
});

test("N-06a: restricted hours keep higher-rated programs out of the window, and nothing straddles its edges", () => {
  const lib = [
    ...Array.from({ length: 6 }, (_, i) => item(`kid${i}`, 22, "TV-G")),
    ...Array.from({ length: 6 }, (_, i) => item(`adult${i}`, 44, "TV-MA")),
    item("film", 118, "R"),
  ];
  const ch = chan({ itemIds: lib.map((m) => m.id), ordering: "shuffle", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "06:00", to: "21:00", maxRating: "PG" }] } });
  const clock = new StationClock(lib);
  const t0 = ch.revisions[0]!.effectiveFromMs;
  const list = clock.airingsBetween(ch, t0, t0 + 10 * DAY);
  assert.ok(list.length > 200);
  let adultsAtNight = 0;
  for (const a of list) {
    const s = localMinutes(a.startMs);
    const lastMinute = localMinutes(a.endMs - 1);
    const inDay = (m: number) => m >= 6 * 60 && m < 21 * 60;
    if (inDay(s)) assert.ok(a.itemId.startsWith("kid"), `${a.itemId} at ${hhmm(a.startMs)}`);
    // Neither side of the 06:00 / 21:00 edges runs into the other.
    assert.equal(inDay(s), inDay(lastMinute), `${a.itemId} ${hhmm(a.startMs)}–${hhmm(a.endMs)} crosses an edge`);
    if (!inDay(s) && !a.itemId.startsWith("kid")) adultsAtNight++;
  }
  assert.ok(adultsAtNight > 20, "the rest of the lineup still airs after hours");
  for (let i = 1; i < list.length; i++) assert.ok(list[i]!.startMs >= list[i - 1]!.endMs, "no overlaps");
  // Every window is covered end to end: programs plus their closing breaks.
  for (let i = 1; i < list.length; i++) assert.equal(list[i]!.startMs, list[i - 1]!.endMs, `gap at ${hhmm(list[i - 1]!.endMs)}`);
});

test("N-09a: a Saturday-morning slot airs its show in order and picks up next week where it stopped", () => {
  const cartoons = Array.from({ length: 30 }, (_, i) => item(`toon${i + 1}`, 11, "TV-Y7", { showId: "toons", season: 1, episode: i + 1 }));
  const usual = Array.from({ length: 20 }, (_, i) => item(`usual${i}`, 44, "TV-14"));
  const lib = [...cartoons, ...usual];
  const ch = chan({ itemIds: usual.map((m) => m.id), ordering: "shuffle", slotMs: 60 * MIN,
    dayparts: { timeZone: TZ, rules: [{ days: [6], from: "08:00", to: "11:00",
      program: { key: "show:toons", itemIds: cartoons.map((m) => m.id), ordering: "cyclic", slotMs: 15 * MIN } }] } });
  const clock = new StationClock(lib);
  const t0 = ch.revisions[0]!.effectiveFromMs;
  const list = clock.airingsBetween(ch, t0, t0 + 15 * DAY);
  const toons = list.filter((a) => a.itemId.startsWith("toon"));
  // 3 hours of 15-minute slots = 12 cartoons each Saturday.
  const saturdays = new Map<string, string[]>();
  for (const a of toons) {
    const f = localFields(a.startMs, TZ);
    const key = `${f.m}/${f.d}`;
    saturdays.set(key, [...(saturdays.get(key) ?? []), a.itemId]);
    assert.ok(localMinutes(a.startMs) >= 8 * 60 && localMinutes(a.endMs - 1) < 11 * 60);
  }
  const weeks = [...saturdays.values()];
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks[0], cartoons.slice(0, 12).map((m) => m.id));
  assert.deepEqual(weeks[1], cartoons.slice(12, 24).map((m) => m.id));
  // Outside the slot, only the usual lineup.
  for (const a of list.filter((a) => !a.itemId.startsWith("toon"))) {
    const f = localFields(a.startMs, TZ);
    const sat = new Date(Date.UTC(f.y, f.m - 1, f.d)).getUTCDay() === 6;
    assert.ok(!(sat && localMinutes(a.startMs) >= 8 * 60 && localMinutes(a.startMs) < 11 * 60), `${a.itemId} in the slot`);
  }
});

test("windowed schedules are pure: two clocks agree, and tune lands inside the airing", () => {
  const lib = Array.from({ length: 25 }, (_, i) => item(`m${i}`, 80 + ((i * 37) % 70), ["G", "PG", "PG-13", "R"][i % 4]));
  const ch = chan({ itemIds: lib.map((m) => m.id), ordering: "shuffle", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "06:00", to: "22:00", maxRating: "PG-13" }, { days: [7], from: "13:00", to: "17:00", maxRating: "G" }] } });
  const a = new StationClock(lib);
  const b = new StationClock(lib);
  const t0 = ch.revisions[0]!.effectiveFromMs;
  // b is asked in a different order (far future first) and must agree.
  b.airingAt(ch, t0 + 9 * DAY);
  for (let t = t0; t < t0 + 9 * DAY; t += 41 * MIN + 7_000) {
    const x = a.airingAt(ch, t);
    assert.deepEqual(x, b.airingAt(ch, t));
    const tt = a.tune(ch, t);
    if (x) {
      assert.ok(tt && tt.airing.startMs <= t && t < tt.airing.endMs);
      if (tt!.segment.kind === "program") assert.ok(tt!.fileOffsetMs! >= 0 && tt!.fileOffsetMs! < lib.find((m) => m.id === x.itemId)!.durationMs!);
    } else assert.equal(tt, null);
  }
});

test("a window nothing may air in is off the air, and the guide skips past it", () => {
  const lib = [item("r1", 90, "R"), item("r2", 95, "R"), item("r3", 100, "R")];
  const ch = chan({ itemIds: lib.map((m) => m.id), ordering: "cyclic", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "06:00", to: "21:00", maxRating: "PG" }] } });
  const clock = new StationClock(lib);
  const day = zonedMs({ y: 2026, m: 10, d: 7 }, 0, TZ);
  assert.equal(clock.airingAt(ch, day + 12 * HOUR), null, "noon: nothing allowed");
  const list = clock.airingsBetween(ch, day + 12 * HOUR, day + 36 * HOUR);
  assert.ok(list.length >= 3);
  assert.equal(hhmm(list[0]!.startMs), "21:00");
  assert.ok(list.every((a) => localMinutes(a.startMs) >= 21 * 60 || localMinutes(a.endMs - 1) < 6 * 60));
});

test("planning months of a windowed channel stays quick", () => {
  const lib = Array.from({ length: 200 }, (_, i) => item(`e${i}`, 20 + (i % 30), ["TV-G", "TV-14", "TV-MA"][i % 3]));
  const ch = chan({ itemIds: lib.map((m) => m.id), ordering: "block-shuffle", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "06:00", to: "20:00", maxRating: "PG" }, { days: [1, 2, 3, 4, 5], from: "15:00", to: "17:00", maxRating: "G" }] } });
  const clock = new StationClock(lib);
  const t0 = ch.revisions[0]!.effectiveFromMs;
  const start = performance.now();
  assert.ok(clock.airingAt(ch, t0 + 180 * DAY));
  const g = clock.airingsBetween(ch, t0 + 180 * DAY, t0 + 180 * DAY + 12 * HOUR);
  assert.ok(g.length > 10);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
});

function* take<T>(it: Iterable<T>, n: number): Generator<T> {
  if (n <= 0) return;
  for (const x of it) {
    yield x;
    if (--n <= 0) return;
  }
}

test("N-32: yearly date ranges are inclusive and wrap the new year", () => {
  const oct = { from: "10-01", to: "10-31" };
  assert.ok(inDates({ m: 10, d: 1 }, oct) && inDates({ m: 10, d: 31 }, oct));
  assert.ok(!inDates({ m: 9, d: 30 }, oct) && !inDates({ m: 11, d: 1 }, oct));
  const holidays = { from: "12-15", to: "01-05" };
  assert.ok(inDates({ m: 12, d: 25 }, holidays) && inDates({ m: 1, d: 5 }, holidays));
  assert.ok(!inDates({ m: 1, d: 6 }, holidays) && !inDates({ m: 12, d: 14 }, holidays));
  const s = seasonState(oct, zonedMs({ y: 2026, m: 9, d: 20 }, 12 * 60, TZ), TZ);
  assert.deepEqual(s, { inSeason: false, nextChangeMs: zonedMs({ y: 2026, m: 10, d: 1 }, 0, TZ) });
  const inside = seasonState(oct, zonedMs({ y: 2026, m: 10, d: 20 }, 12 * 60, TZ), TZ);
  assert.deepEqual(inside, { inSeason: true, nextChangeMs: zonedMs({ y: 2026, m: 11, d: 1 }, 0, TZ) });
  assert.equal(seasonState({ from: "01-01", to: "12-31" }, Date.UTC(2026, 5, 1), TZ).nextChangeMs, null);
});

test("N-32: a seasonal slot airs its program only between its dates, and the usual lineup otherwise", () => {
  const scary = Array.from({ length: 20 }, (_, i) => item(`scary${i}`, 90));
  const usual = Array.from({ length: 20 }, (_, i) => item(`usual${i}`, 44));
  const ch: Channel = { id: "c", number: 5, name: "C", revisions: [{ effectiveFromMs: zonedMs({ y: 2026, m: 9, d: 25 }, 0, TZ), seed: "c",
    itemIds: usual.map((m) => m.id), ordering: "shuffle", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "20:00", to: "00:00", dates: { from: "10-01", to: "10-31" },
      program: { key: "group:scary", itemIds: scary.map((m) => m.id), ordering: "shuffle" } }] } }] };
  const clock = new StationClock([...scary, ...usual]);
  const list = clock.airingsBetween(ch, zonedMs({ y: 2026, m: 9, d: 25 }, 0, TZ), zonedMs({ y: 2026, m: 10, d: 8 }, 0, TZ));
  for (const a of list) {
    const f = localFields(a.startMs, TZ);
    const evening = localMinutes(a.startMs) >= 20 * 60;
    if (a.itemId.startsWith("scary")) assert.ok(f.m === 10 && evening, `${a.itemId} at ${f.m}/${f.d} ${hhmm(a.startMs)}`);
    else if (f.m === 10) assert.ok(localMinutes(a.endMs - 1) < 20 * 60 || !evening, `usual in the October evening slot at ${f.d} ${hhmm(a.startMs)}`);
  }
  assert.ok(list.filter((a) => a.itemId.startsWith("scary")).length >= 7 * 2, "two or more films a night through the first week of October");
});

test("N-32: a seasonal channel is off the air out of season, and on all day in it", () => {
  const lib = Array.from({ length: 10 }, (_, i) => item(`xmas${i}`, 95));
  const ch: Channel = { id: "c", number: 5, name: "C", revisions: [{ effectiveFromMs: zonedMs({ y: 2026, m: 12, d: 1 }, 0, TZ), seed: "c",
    itemIds: lib.map((m) => m.id), ordering: "shuffle", slotMs: 30 * MIN,
    dayparts: { timeZone: TZ, rules: [{ from: "00:00", to: "00:00", dates: { from: "12-15", to: "01-05" }, outside: true, offAir: true }] } }] };
  const clock = new StationClock(lib);
  assert.equal(clock.airingAt(ch, zonedMs({ y: 2026, m: 12, d: 10 }, 12 * 60, TZ)), null);
  assert.ok(clock.airingAt(ch, zonedMs({ y: 2026, m: 12, d: 20 }, 3 * 60, TZ)));
  assert.ok(clock.airingAt(ch, zonedMs({ y: 2027, m: 1, d: 3 }, 22 * 60, TZ)), "across the new year");
  assert.equal(clock.airingAt(ch, zonedMs({ y: 2027, m: 1, d: 6 }, 12 * 60, TZ)), null);
  const list = clock.airingsBetween(ch, zonedMs({ y: 2026, m: 12, d: 14 }, 12 * 60, TZ), zonedMs({ y: 2026, m: 12, d: 15 }, 6 * 60, TZ));
  assert.equal(hhmm(list[0]!.startMs), "00:00", "the guide skips to the first day of the season");
  const last = clock.airingsBetween(ch, zonedMs({ y: 2027, m: 1, d: 5 }, 20 * 60, TZ), zonedMs({ y: 2027, m: 1, d: 6 }, 6 * 60, TZ));
  assert.ok(last.every((a) => a.endMs <= zonedMs({ y: 2027, m: 1, d: 6 }, 0, TZ)), "nothing runs past the season's last midnight");
});
