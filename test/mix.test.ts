// Weighted mixes (N-09a weights, N-09c premieres, N-09d balance, N-09e marathons).

import { test } from "node:test";
import assert from "node:assert/strict";
import { StationClock } from "../src/clock/schedule.ts";
import type { Channel, MediaItem, MixRules } from "../src/clock/types.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 5, 4);

const show = (key: string, n: number, minutes: number): MediaItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${key}${i + 1}`, title: `${key} ${i + 1}`, showId: key, season: 1, episode: i + 1,
    durationMs: minutes * MIN, source: { provider: "local", ref: `${key}${i}` } }));
const lib = [...show("a", 30, 22), ...show("b", 30, 22), ...show("c", 30, 44),
  ...Array.from({ length: 5 }, (_, i): MediaItem => ({ id: `f${i}`, title: `film ${i}`, durationMs: 100 * MIN, source: { provider: "local", ref: `f${i}` } }))];
const chan = (mix: MixRules, ids = lib.map((m) => m.id)): Channel =>
  ({ id: "m", number: 2, name: "Mix", revisions: [{ effectiveFromMs: T0, seed: "mix", itemIds: ids, ordering: "round-robin-cyclic", slotMs: 30 * MIN, mix }] });
const tally = (list: { itemId: string; startMs: number; endMs: number }[]) => {
  const n: Record<string, number> = {};
  const ms: Record<string, number> = {};
  for (const a of list) {
    const k = a.itemId.startsWith("f") ? "films" : a.itemId[0]!;
    n[k] = (n[k] ?? 0) + 1;
    ms[k] = (ms[k] ?? 0) + a.endMs - a.startMs;
  }
  return { n, ms };
};

test("N-09a: weights set each show's share of turns; weight 0 never airs; episodes stay in order", () => {
  const clock = new StationClock(lib);
  const ch = chan({ weights: { a: 100, b: 50, c: 0, films: 0 } });
  const list = clock.airingsBetween(ch, T0, T0 + 3 * DAY);
  const { n } = tally(list);
  assert.equal(n.c, undefined);
  assert.equal(n.films, undefined);
  assert.ok(Math.abs(n.a! / n.b! - 2) < 0.1, JSON.stringify(n));
  const aEps = list.filter((x) => x.itemId.startsWith("a")).map((x) => Number(x.itemId.slice(1)));
  assert.deepEqual(aEps.slice(0, 31), [...Array.from({ length: 30 }, (_, i) => i + 1), 1], "in order, then round again");
  for (let i = 1; i < list.length; i++) assert.equal(list[i]!.startMs, list[i - 1]!.endMs);
});

test("N-09d: balance by airtime gives long and short shows the same time, by turns the same count", () => {
  const clock = new StationClock(lib);
  const ids = lib.filter((m) => m.showId === "a" || m.showId === "c").map((m) => m.id);
  const byTime = tally(clock.airingsBetween(chan({ balance: "duration" }, ids), T0, T0 + 4 * DAY));
  assert.ok(Math.abs(byTime.ms.a! / byTime.ms.c! - 1) < 0.05, JSON.stringify(byTime.ms));
  const byCount = tally(clock.airingsBetween(chan({ balance: "count" }, ids), T0, T0 + 4 * DAY));
  assert.ok(Math.abs(byCount.n.a! - byCount.n.c!) <= 1, JSON.stringify(byCount.n));
});

test("N-09c: premieres air first, once each", () => {
  const clock = new StationClock(lib);
  const list = clock.airingsBetween(chan({ premieres: ["b30", "c29"] }), T0, T0 + DAY);
  const firstFew = list.slice(0, 6).map((x) => x.itemId);
  assert.ok(firstFew.includes("b30") && firstFew.includes("c29"), firstFew.join(" "));
  assert.equal(list.filter((x) => x.itemId === "b30").length, 1);
});

test("N-09e: a marathon stays on one show for up to its length, then the mix resumes", () => {
  const clock = new StationClock(lib);
  const list = clock.airingsBetween(chan({ marathon: { chance: 1, maxMs: 4 * 60 * MIN }, weights: { films: 0 } }), T0, T0 + DAY);
  // With chance 1 every pick starts a run: runs of one show lasting ~4 hours.
  const runs: Array<{ show: string; ms: number }> = [];
  for (const a of list) {
    const s = a.itemId[0]!;
    if (runs.length && runs[runs.length - 1]!.show === s) runs[runs.length - 1]!.ms += a.endMs - a.startMs;
    else runs.push({ show: s, ms: a.endMs - a.startMs });
  }
  assert.ok(runs.length >= 4 && runs.slice(0, -1).every((r) => r.ms >= 4 * 60 * MIN && r.ms <= 5 * 60 * MIN), JSON.stringify(runs));
  const none = clock.airingsBetween(chan({ marathon: { chance: 0, maxMs: 4 * 60 * MIN }, weights: { films: 0 } }), T0, T0 + DAY);
  assert.ok(none.slice(0, 6).map((a) => a.itemId[0]).join("") !== "aaaaaa");
});

test("weighted mixes are pure: two clocks agree whatever order they're asked in", () => {
  const ch = chan({ weights: { a: 80, c: 20 }, balance: "duration", marathon: { chance: 0.05, maxMs: 3 * 60 * MIN }, premieres: ["a5"] });
  const x = new StationClock(lib);
  const y = new StationClock(lib);
  y.airingAt(ch, T0 + 5 * DAY);
  for (let t = T0; t < T0 + 5 * DAY; t += 53 * MIN) assert.deepEqual(x.airingAt(ch, t), y.airingAt(ch, t));
});
