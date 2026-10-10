// Ordering modes. NostalgiaTV documents eight labels (handoff §3.2, N03) but not
// their exact rules, so each mode here is DebridTV's own testable definition.
// Parity is "same intent", not "verified identical behaviour".
//
// Every mode returns a permutation of the eligible items for cycle k: each item airs
// exactly once per cycle, which keeps cycle length constant and the clock pure.
// "Cyclic" variants keep each show's episodes in order (season, episode, then
// library order); "shuffle" variants don't promise that across blocks.
//
//   cyclic               library order, every cycle            (NostalgiaTV: Cyclic)
//   shuffle              fresh permutation per cycle; no seam repeat (Random)
//   block-shuffle        each show cut into consecutive 2–4 episode blocks; all blocks shuffled
//   block-cyclic         same blocks; shows interleave at random but each show's blocks stay in order
//   marathon-shuffle     like block-shuffle with 5–8 episode blocks
//   marathon-cyclic      like block-cyclic with 5–8 episode blocks
//   round-robin-shuffle  shows take turns, one episode per turn; turn order and each show's episode order shuffled
//   round-robin-cyclic   shows take turns, one episode per turn; each show's episodes in order
//
// Known limit: within a cycle every episode airs once, so a 100-episode show
// still fills the tail of a round-robin cycle after small shows run out. True
// per-minute fairness needs a different cycle model (open question F2).

import { seededShuffle, mulberry32, hash32 } from "./rng.ts";
import type { ChannelRevision, MediaItem, Ordering } from "./types.ts";

export const ORDERINGS: readonly Ordering[] = [
  "cyclic", "shuffle", "block-shuffle", "block-cyclic",
  "marathon-shuffle", "marathon-cyclic", "round-robin-shuffle", "round-robin-cyclic",
];

type Meta = (id: string) => MediaItem | undefined;

export function cycleOrder(rev: ChannelRevision, k: number, eligible: string[], meta: Meta = () => undefined): string[] {
  const key = `${rev.seed}|${k}`;
  switch (rev.ordering) {
    case "cyclic":
      return eligible.slice();
    case "shuffle": {
      const order = seededShuffle(eligible, key);
      if (order.length >= 3 && k > 0) {
        const prev = seededShuffle(eligible, `${rev.seed}|${k - 1}`);
        if (order[0] === prev[prev.length - 1]) [order[0], order[1]] = [order[1]!, order[0]!];
      }
      return order;
    }
    case "block-shuffle":
    case "marathon-shuffle":
      return seededShuffle(blocksByShow(eligible, meta, rev.ordering, key), key).flat();
    case "block-cyclic":
    case "marathon-cyclic":
      return interleave(blocksPerShow(eligible, meta, rev.ordering, key), key).flat();
    case "round-robin-shuffle":
    case "round-robin-cyclic": {
      const shows = showsInOrder(eligible, meta).map((eps, i) =>
        rev.ordering === "round-robin-shuffle" ? seededShuffle(eps, `${key}|show${i}`) : eps,
      );
      const turnOrder = seededShuffle(shows, `${key}|turns`);
      const out: string[] = [];
      for (let round = 0; out.length < eligible.length; round++)
        for (const eps of turnOrder) if (round < eps.length) out.push(eps[round]!);
      return out;
    }
  }
}

/** Group by show (items without a show are their own show), episodes in order. */
function showsInOrder(eligible: string[], meta: Meta): string[][] {
  const groups = new Map<string, string[]>();
  eligible.forEach((id) => {
    const show = meta(id)?.showId ?? `__item:${id}`;
    groups.set(show, [...(groups.get(show) ?? []), id]);
  });
  const pos = new Map(eligible.map((id, i) => [id, i]));
  const rank = (id: string) => {
    const m = meta(id);
    return [m?.season ?? 0, m?.episode ?? 0, pos.get(id)!];
  };
  return [...groups.values()].map((eps) =>
    eps.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0]! - rb[0]! || ra[1]! - rb[1]! || ra[2]! - rb[2]!;
    }),
  );
}

function blockRange(mode: Ordering): [number, number] {
  return mode.startsWith("marathon") ? [5, 8] : [2, 4];
}

function blocksPerShow(eligible: string[], meta: Meta, mode: Ordering, key: string): string[][][] {
  const [lo, hi] = blockRange(mode);
  const rand = mulberry32(hash32(`${key}|blocks`));
  return showsInOrder(eligible, meta).map((eps) => {
    const blocks: string[][] = [];
    for (let i = 0; i < eps.length; ) {
      const size = lo + Math.floor(rand() * (hi - lo + 1));
      blocks.push(eps.slice(i, i + size));
      i += size;
    }
    return blocks;
  });
}

function blocksByShow(eligible: string[], meta: Meta, mode: Ordering, key: string): string[][] {
  return blocksPerShow(eligible, meta, mode, key).flat();
}

/** Random merge of per-show block queues, keeping each queue's order. */
function interleave(queues: string[][][], key: string): string[][] {
  const rand = mulberry32(hash32(`${key}|merge`));
  const qs = queues.map((q) => q.slice());
  const out: string[][] = [];
  let remaining = qs.reduce((n, q) => n + q.length, 0);
  while (remaining > 0) {
    // Weight by blocks left so long shows spread through the cycle instead of
    // piling up at the end.
    let r = Math.floor(rand() * remaining);
    const q = qs.find((q) => (r -= q.length) < 0)!;
    out.push(q.shift()!);
    remaining--;
  }
  return out;
}
