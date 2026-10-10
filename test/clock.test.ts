import { test } from "node:test";
import assert from "node:assert/strict";
import { StationClock, cycleOrder } from "../src/clock/schedule.ts";
import type { Channel, MediaItem } from "../src/clock/types.ts";
import { WatchLedger } from "../src/history/watched.ts";
import { Gates, GateDeniedError } from "../src/gates.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);

function ep(n: number, minutes: number, extra: Partial<MediaItem> = {}): MediaItem {
  return { id: `ep${n}`, title: `Episode ${n}`, showId: "s", episode: n, durationMs: minutes * MIN,
    source: { provider: "local", ref: `f${n}` }, ...extra };
}

const library = [ep(1, 22), ep(2, 23), ep(3, 21, { breakpointsMs: [10 * MIN] }), ep(4, 44), ep(5, 22)];

const channel: Channel = {
  id: "c1", number: 3, name: "Sitcoms",
  revisions: [{ effectiveFromMs: T0, seed: "c1", itemIds: library.map((m) => m.id),
    ordering: "shuffle", slotMs: 30 * MIN, midBreakMs: 2 * MIN }],
};

test("C1/C6: two independent clocks agree at every instant (restart-safe)", () => {
  const a = new StationClock(library);
  const b = new StationClock(library);
  for (let t = T0; t < T0 + 3 * 24 * 60 * MIN; t += 7 * MIN + 13_000) {
    assert.deepEqual(a.airingAt(channel, t), b.airingAt(channel, t));
  }
});

test("airings tile the timeline with no gaps or overlaps", () => {
  const clock = new StationClock(library);
  const list = clock.airingsBetween(channel, T0, T0 + 48 * 60 * MIN);
  for (let i = 1; i < list.length; i++) assert.equal(list[i]!.startMs, list[i - 1]!.endMs);
  for (const a of list) {
    assert.equal(a.segments[0]!.startMs, a.startMs);
    assert.equal(a.segments[a.segments.length - 1]!.endMs, a.endMs);
    assert.equal((a.endMs - a.startMs) % (30 * MIN), 0, "slot aligned");
  }
});

test("C2: tuning later lands later in the same program, not at its start", () => {
  const clock = new StationClock(library);
  const a = clock.tune(channel, T0 + 5 * MIN)!;
  const b = clock.tune(channel, T0 + 8 * MIN)!;
  assert.equal(a.airing.itemId, b.airing.itemId);
  if (a.fileOffsetMs !== null && b.fileOffsetMs !== null) assert.equal(b.fileOffsetMs - a.fileOffsetMs, 3 * MIN);
});

test("C3: joining during a mid-program break lands in the break, and program time resumes after it", () => {
  const clock = new StationClock(library);
  const a = clock.airingsBetween(channel, T0, T0 + 24 * 60 * MIN).find((x) => x.itemId === "ep3")!;
  const brk = a.segments.find((s) => s.kind === "break" && s.reason === "mid")!;
  const inBreak = clock.tune(channel, brk.startMs + 30_000)!;
  assert.equal(inBreak.segment.kind, "break");
  assert.equal(inBreak.fileOffsetMs, null);
  const after = clock.tune(channel, brk.endMs + 1_000)!;
  assert.equal(after.fileOffsetMs, 10 * MIN + 1_000, "station time ≠ program time across a break");
});

test("C7: editing a channel keeps the current airing and leaves other channels untouched", () => {
  const clock = new StationClock(library);
  const other: Channel = { ...channel, id: "c2", revisions: [{ ...channel.revisions[0]!, seed: "c2" }] };
  const editAt = T0 + 37 * MIN;
  const before = clock.airingAt(channel, editAt)!;
  const otherBefore = clock.airingsBetween(other, T0, T0 + 6 * 60 * MIN);
  const edited = clock.revise(channel, editAt, { itemIds: ["ep1", "ep2"] });
  assert.deepEqual(clock.airingAt(edited, editAt), before);
  assert.ok(["ep1", "ep2"].includes(clock.airingAt(edited, before.endMs)!.itemId));
  assert.deepEqual(clock.airingsBetween(other, T0, T0 + 6 * 60 * MIN), otherBefore);
});

test("D6: unknown duration is excluded with a reason instead of breaking the schedule", () => {
  const lib = [...library, ep(6, 0, { durationMs: null })];
  const ch: Channel = { ...channel, revisions: [{ ...channel.revisions[0]!, itemIds: [...channel.revisions[0]!.itemIds, "ep6", "ghost"] }] };
  const clock = new StationClock(lib);
  assert.deepEqual(clock.excluded(ch.revisions[0]!), [
    { itemId: "ep6", reason: "duration-unknown" },
    { itemId: "ghost", reason: "not-in-library" },
  ]);
  const ids = new Set(clock.airingsBetween(ch, T0, T0 + 48 * 60 * MIN).map((a) => a.itemId));
  assert.ok(!ids.has("ep6") && !ids.has("ghost"));
});

test("shuffle: each cycle is a permutation and never repeats across the cycle seam", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `x${i}`);
  const rev = { effectiveFromMs: T0, seed: "s", itemIds: ids, ordering: "shuffle" as const };
  for (let k = 1; k < 500; k++) {
    const prev = cycleOrder(rev, k - 1, ids);
    const cur = cycleOrder(rev, k, ids);
    assert.deepEqual([...cur].sort(), [...ids].sort());
    // The seam rule uses the previous raw shuffle; with ≥3 items the adjustment
    // only swaps positions 0/1, so the previous cycle's last element is stable.
    assert.notEqual(cur[0], prev[prev.length - 1]);
  }
});

test("block-shuffle: blocks keep episode order and cover every item once", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `e${String(i).padStart(2, "0")}`);
  const order = cycleOrder({ effectiveFromMs: 0, seed: "b", itemIds: ids, ordering: "block-shuffle" }, 3, ids);
  assert.deepEqual([...order].sort(), ids);
  let ascendingPairs = 0;
  for (let i = 1; i < order.length; i++) if (order[i]! > order[i - 1]!) ascendingPairs++;
  assert.ok(ascendingPairs >= 10, "most neighbours are in-block and ascending");
});

test("D8: joining the last two minutes of an hour does not mark it watched", () => {
  const w = new WatchLedger();
  w.record("ep4", 58 * MIN, 60 * MIN);
  assert.equal(w.isWatched("ep4", 60 * MIN), false);
  w.record("ep4", 0, 50 * MIN);
  w.record("ep4", 40 * MIN, 55 * MIN);
  assert.equal(w.seenMs("ep4"), 57 * MIN);
  assert.equal(w.isWatched("ep4", 60 * MIN), true);
});

test("gates default closed and need a stated basis", () => {
  const g = new Gates();
  for (const gate of ["sharing", "cloud-relay", "tuner-export"] as const) {
    assert.throws(() => g.require(gate), GateDeniedError);
  }
  assert.throws(() => g.grant({ gate: "tuner-export", grantedAt: "", grantedBy: "me", basis: " " }));
  g.grant({ gate: "tuner-export", grantedAt: "2026-10-10", grantedBy: "Zachary", basis: "LAN-only test" });
  assert.equal(g.isGranted("tuner-export"), true);
  assert.equal(g.isGranted("sharing"), false, "gates are independent");
});
