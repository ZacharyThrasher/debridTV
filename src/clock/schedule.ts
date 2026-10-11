// The station clock: a pure function from (channel config, media durations, time)
// to "what is airing and where in it". It never touches a provider, so building or
// browsing a guide costs zero API calls and zero media bytes (gates B1, C1, C6).
//
// Model: each revision of a channel repeats "cycles". A cycle is one pass over the
// eligible items in an order derived from (seed, cycle index). Airing lengths are
// derived from exact file durations plus break layout, so the position at any
// instant is found with arithmetic and a binary search — no materialised log.

import { cycleOrder } from "./ordering.ts";
import { windows, type Window } from "./dayparts.ts";
import { allowedUnder, normalizeRating, type Rating } from "./ratings.ts";
import { hash32, seededShuffle } from "./rng.ts";
import type {
  Airing,
  Channel,
  ChannelRevision,
  MediaItem,
  MixRules,
  Segment,
  TuneTarget,
} from "./types.ts";

interface Cycle {
  order: string[];
  /** prefix[i] = offset of airing i from cycle start; prefix[n] = cycle length. */
  prefix: number[];
}

export interface ExcludedItem {
  itemId: string;
  /** rated-above: rated higher than the channel allows. unrated: no known rating, so a limited channel can't air it. */
  reason: "not-in-library" | "duration-unknown" | "rated-above" | "unrated";
}

export { cycleOrder };

export class StationClock {
  private readonly library: ReadonlyMap<string, MediaItem>;
  private readonly cycles = new Map<string, Cycle>();
  private readonly plans = new WeakMap<ChannelRevision, WindowPlan>();

  constructor(library: Iterable<MediaItem>) {
    this.library = new Map(Array.from(library, (m) => [m.id, m]));
  }

  /** Items the revision lists but cannot schedule, with reasons (gate D6). */
  excluded(rev: ChannelRevision): ExcludedItem[] {
    const out: ExcludedItem[] = [];
    for (const id of rev.itemIds) {
      const m = this.library.get(id);
      if (!m) out.push({ itemId: id, reason: "not-in-library" });
      else if (!(m.durationMs && m.durationMs > 0))
        out.push({ itemId: id, reason: "duration-unknown" });
      else if (!allowedUnder(m.rating, rev.maxRating))
        out.push({ itemId: id, reason: normalizeRating(m.rating) ? "rated-above" : "unrated" });
    }
    return out;
  }

  /** The airing covering instant t, or null when the channel is off air. */
  airingAt(channel: Channel, t: number): Airing | null {
    const ri = revisionIndexAt(channel, t);
    if (ri < 0) return null;
    const rev = channel.revisions[ri]!;
    if (planned(rev)) {
      const p = this.plan(rev).find(t);
      return p ? this.buildAiring(channel, ri, p.itemId, p.startMs, p.slotMs, p.endMs) : null;
    }
    const eligible = this.eligible(rev);
    if (eligible.length === 0) return null;

    const cycleLen = this.cycle(channel, ri, 0, eligible).prefix[eligible.length]!;
    const local = t - rev.effectiveFromMs;
    const k = Math.floor(local / cycleLen);
    const cyc = this.cycle(channel, ri, k, eligible);
    const within = local - k * cycleLen;
    const i = upperBound(cyc.prefix, within) - 1;
    const start = rev.effectiveFromMs + k * cycleLen + cyc.prefix[i]!;
    return this.buildAiring(channel, ri, cyc.order[i]!, start);
  }

  /** Airings overlapping [fromMs, toMs), for the guide. */
  airingsBetween(channel: Channel, fromMs: number, toMs: number): Airing[] {
    const out: Airing[] = [];
    let t = fromMs;
    while (t < toMs) {
      const a = this.airingAt(channel, t);
      if (!a) {
        // Off air until something starts: later in a windowed revision, or the next revision.
        const ri = revisionIndexAt(channel, t);
        const rev = channel.revisions[ri];
        const next = channel.revisions.find((r) => r.effectiveFromMs > t);
        const resume = rev && planned(rev) ? this.plan(rev).nextStart(t, Math.min(toMs, next?.effectiveFromMs ?? Infinity)) : null;
        if (resume != null) {
          t = resume;
          continue;
        }
        if (!next) break;
        t = next.effectiveFromMs;
        continue;
      }
      out.push(a);
      t = a.endMs;
    }
    return out;
  }

  /** Where a viewer lands when tuning in at instant t (gates C2, C3). */
  tune(channel: Channel, t: number): TuneTarget | null {
    const airing = this.airingAt(channel, t);
    if (!airing) return null;
    const segment = airing.segments.find((s) => t >= s.startMs && t < s.endMs)!;
    const offsetInSegmentMs = t - segment.startMs;
    const fileOffsetMs =
      segment.kind === "program" ? segment.fileFromMs + offsetInSegmentMs : null;
    return { airing, segment, offsetInSegmentMs, fileOffsetMs };
  }

  /**
   * Apply an edit without disturbing what is on air: the new revision takes effect
   * at the end of the airing in progress at `editAtMs` (gates C6, C7). Revisions
   * that had been scheduled to start later are superseded.
   */
  revise(
    channel: Channel,
    editAtMs: number,
    change: Partial<Omit<ChannelRevision, "effectiveFromMs">>,
  ): Channel {
    const current = this.airingAt(channel, editAtMs);
    const effectiveFromMs = current ? current.endMs : editAtMs;
    const base = channel.revisions[revisionIndexAt(channel, editAtMs)];
    if (!base && !(change.itemIds && change.seed && change.ordering))
      throw new Error("first revision needs itemIds, seed and ordering");
    const next = { ...base, ...change, effectiveFromMs } as ChannelRevision;
    const kept = channel.revisions.filter((r) => r.effectiveFromMs < effectiveFromMs);
    return { ...channel, revisions: [...kept, next] };
  }

  private eligible(rev: ChannelRevision, itemIds = rev.itemIds, limit = rev.maxRating): string[] {
    return itemIds.filter((id) => {
      const m = this.library.get(id);
      return m != null && m.durationMs != null && m.durationMs > 0 && allowedUnder(m.rating, limit);
    });
  }

  private airingLength(rev: ChannelRevision, itemId: string, slotMs = rev.slotMs): number {
    const m = this.library.get(itemId)!;
    const bps = validBreakpoints(m);
    const raw = m.durationMs! + bps.length * (rev.midBreakMs ?? 0);
    if (!slotMs) return raw;
    return Math.ceil(raw / slotMs) * slotMs;
  }

  private plan(rev: ChannelRevision): WindowPlan {
    let p = this.plans.get(rev);
    if (!p) {
      p = new WindowPlan(rev, {
        eligible: (ids, limit) => this.eligible(rev, ids, limit),
        length: (id, slotMs) => this.airingLength(rev, id, slotMs),
        meta: (id) => this.library.get(id),
      });
      this.plans.set(rev, p);
    }
    return p;
  }

  private cycle(channel: Channel, ri: number, k: number, eligible: string[]): Cycle {
    const key = `${channel.id}#${channel.revisions[ri]!.effectiveFromMs}#${channel.revisions[ri]!.seed}#${k}`;
    const hit = this.cycles.get(key);
    if (hit) return hit;
    const rev = channel.revisions[ri]!;
    const order = cycleOrder(rev, k, eligible, (id) => this.library.get(id));
    const prefix = [0];
    for (const id of order) prefix.push(prefix[prefix.length - 1]! + this.airingLength(rev, id));
    const cyc = { order, prefix };
    if (this.cycles.size > 10_000) this.cycles.clear();
    this.cycles.set(key, cyc);
    return cyc;
  }

  private buildAiring(channel: Channel, ri: number, itemId: string, startMs: number, slotMs?: number, endMs?: number): Airing {
    const rev = channel.revisions[ri]!;
    const m = this.library.get(itemId)!;
    const mid = rev.midBreakMs ?? 0;
    const segments: Segment[] = [];
    let t = startMs;
    let fileFrom = 0;
    const cuts = mid > 0 ? validBreakpoints(m) : [];
    for (const bp of [...cuts, m.durationMs!]) {
      segments.push({ kind: "program", itemId, startMs: t, endMs: t + (bp - fileFrom), fileFromMs: fileFrom });
      t += bp - fileFrom;
      fileFrom = bp;
      if (bp !== m.durationMs!) {
        segments.push({ kind: "break", startMs: t, endMs: t + mid, reason: "mid" });
        t += mid;
      }
    }
    const fullEnd = endMs ?? startMs + this.airingLength(rev, itemId, slotMs);
    if (fullEnd > t) segments.push({ kind: "break", startMs: t, endMs: fullEnd, reason: "padding" });

    const nextRev = channel.revisions[ri + 1];
    const cap = nextRev ? nextRev.effectiveFromMs : Infinity;
    const truncated = fullEnd > cap;
    const end = Math.min(fullEnd, cap);
    const clipped = segments
      .filter((s) => s.startMs < end)
      .map((s) => (s.endMs > end ? { ...s, endMs: end } : s));
    return { channelId: channel.id, itemId, startMs, endMs: end, segments: clipped, truncated };
  }
}

function validBreakpoints(m: MediaItem): number[] {
  const d = m.durationMs ?? 0;
  return Array.from(new Set(m.breakpointsMs ?? []))
    .filter((b) => b > 0 && b < d)
    .sort((a, b) => a - b);
}

function revisionIndexAt(channel: Channel, t: number): number {
  let idx = -1;
  for (let i = 0; i < channel.revisions.length; i++) {
    if (channel.revisions[i]!.effectiveFromMs <= t) idx = i;
    else break;
  }
  return idx;
}

/** First index whose value is > x. */
function upperBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------- windowed channels

interface Planned {
  startMs: number;
  /** Includes slot padding, and the break that fills out the end of a window. */
  endMs: number;
  itemId: string;
  slotMs?: number;
}

interface Cursor {
  k: number;
  i: number;
  /** Items passed over because they didn't fit before a window closed; they go first next time. */
  pending: string[];
}

interface MixGroup {
  key: string;
  ids: string[];
  order: string[];
  pos: number;
  lap: number;
  /** Turns or airtime so far. */
  aired: number;
  premieres: string[];
}

interface MixCursor {
  groups: MixGroup[];
  turn: number;
  marathon?: { key: string; untilMs: number };
}

/** Revisions the clock plans forward instead of repeating a fixed cycle. */
function planned(rev: ChannelRevision): boolean {
  return !!(rev.dayparts?.rules.length || rev.mix);
}

interface Source {
  key: string;
  eligible: string[];
  rev: ChannelRevision;
  slotMs?: number;
}

interface PlanDeps {
  eligible: (itemIds: string[], limit: Rating | undefined) => string[];
  length: (itemId: string, slotMs: number | undefined) => number;
  meta: (id: string) => MediaItem | undefined;
}

/** How far ahead of the next program in order the clock looks for one that fits a window's end. */
const LOOKAHEAD = 12;
const MAX_PENDING = 24;

/**
 * The schedule of a revision with wall-clock rules, worked out window by window
 * from the revision's start and kept for later questions.
 *
 * Each window airs whole programs from its source, in that source's own running
 * order: the usual lineup, or a slot's program, filtered by the rating limit in
 * force. A program never runs past its window. When the next one in order is too
 * long for what's left, the clock looks a few programs ahead for one that fits and
 * keeps the skipped ones first in line for next time; when nothing fits, the last
 * program's closing break runs to the end of the window. A window where nothing at
 * all may air is off the air.
 *
 * Each source keeps its place between windows, so a Saturday-morning slot picks up
 * next week where it stopped, and the usual lineup resumes after it.
 */
export class WindowPlan {
  private readonly airings: Planned[] = [];
  private readonly cursors = new Map<string, Cursor>();
  private readonly sources = new Map<string, Source>();
  private readonly orders = new Map<string, string[]>();
  private readonly gen: Generator<Window>;
  private peeked: Window | null = null;
  private win: Window | null = null;
  /** Everything before this instant is settled. */
  private t: number;
  /** Index of the first airing placed in the current window. */
  private winFirst = 0;
  private readonly rev: ChannelRevision;
  private readonly deps: PlanDeps;

  constructor(rev: ChannelRevision, deps: PlanDeps) {
    this.rev = rev;
    this.deps = deps;
    this.gen = rev.dayparts?.rules.length
      ? windows(rev.dayparts, rev.effectiveFromMs, rev.maxRating)
      : (function* () {
          yield { startMs: rev.effectiveFromMs, endMs: Infinity, program: -1, maxRating: rev.maxRating, key: `base|${rev.maxRating ?? "any"}` };
        })();
    this.t = rev.effectiveFromMs;
  }

  /** The planned airing covering t, if any. */
  find(t: number): Planned | null {
    if (t < this.rev.effectiveFromMs) return null;
    this.extend(t);
    const i = lastStartingAtOrBefore(this.airings, t);
    const a = i >= 0 ? this.airings[i]! : null;
    // The newest airing's end isn't final until the next one is placed or its
    // window closes (its closing break may grow to the window's end).
    while (a && i === this.airings.length - 1 && !this.done && this.t <= a.endMs) this.extend(a.endMs);
    return a && t < a.endMs ? a : null;
  }

  /** When the next airing after t starts, if one starts before `limit`. */
  nextStart(t: number, limit: number): number | null {
    const step = 6 * 3_600_000;
    for (let probe = t; probe < limit; probe += step) {
      this.extend(Math.min(probe + step, limit));
      const i = lastStartingAtOrBefore(this.airings, t) + 1;
      const a = this.airings[i];
      if (a) return a.startMs < limit ? a.startMs : null;
      if (this.done) return null;
    }
    return null;
  }

  private done = false;

  /** Work out the schedule until everything at or before `until` is settled. */
  private extend(until: number): void {
    let steps = 0;
    while (this.t <= until && !this.done) {
      if (++steps > 200_000) throw new Error("schedule too dense to plan");
      if (!this.win) {
        const w = this.nextWindow();
        if (!w) {
          this.done = true;
          return;
        }
        this.win = { ...w, startMs: Math.max(w.startMs, this.rev.effectiveFromMs) };
        this.t = Math.max(this.t, this.win.startMs);
        this.winFirst = this.airings.length;
        if (this.win.endMs <= this.t) {
          this.win = null;
          continue;
        }
      }
      const w = this.win;
      const src = this.source(w);
      const id = src.eligible.length ? this.pick(src, w.endMs - this.t) : null;
      if (id) {
        const len = this.deps.length(id, src.slotMs);
        this.airings.push({ startMs: this.t, endMs: this.t + len, itemId: id, slotMs: src.slotMs });
        this.t += len;
        continue;
      }
      // Nothing fits. If the same source simply carries on, keep going in the next window.
      const nx = this.peek();
      if (nx && nx.key === w.key && nx.startMs === w.endMs && src.eligible.length) {
        this.peeked = null;
        w.endMs = nx.endMs;
        continue;
      }
      const last = this.airings[this.airings.length - 1];
      if (last && this.airings.length > this.winFirst) last.endMs = w.endMs;
      this.t = w.endMs;
      this.win = null;
    }
  }

  private peek(): Window | null {
    if (!this.peeked) {
      const n = this.gen.next();
      this.peeked = n.done ? null : n.value;
    }
    return this.peeked;
  }

  private nextWindow(): Window | null {
    const w = this.peek();
    this.peeked = null;
    return w;
  }

  private source(w: Window): Source {
    let s = this.sources.get(w.key);
    if (!s) {
      const prog = w.program >= 0 ? this.rev.dayparts!.rules[w.program]!.program! : null;
      const rev: ChannelRevision = prog
        ? { ...this.rev, seed: `${this.rev.seed}|${prog.key}`, itemIds: prog.itemIds, ordering: prog.ordering }
        : { ...this.rev, seed: `${this.rev.seed}|${w.key}` };
      s = { key: w.key, rev, eligible: w.off ? [] : this.deps.eligible(rev.itemIds, w.maxRating), slotMs: prog ? (prog.slotMs ?? this.rev.slotMs) : this.rev.slotMs };
      this.sources.set(w.key, s);
    }
    return s;
  }

  private order(src: Source, k: number): string[] {
    const key = `${src.key}#${k}`;
    let o = this.orders.get(key);
    if (!o) {
      o = cycleOrder(src.rev, k, src.eligible, this.deps.meta);
      if (this.orders.size > 2_000) this.orders.clear();
      this.orders.set(key, o);
    }
    return o;
  }

  private readonly mixes = new Map<string, MixCursor>();

  /**
   * Weighted pick (MixRules): the show furthest behind its share whose next
   * program fits; ties broken by a seeded hash so it is stable but not alphabetical.
   */
  private pickMix(src: Source, room: number, mix: MixRules): string | null {
    let mc = this.mixes.get(src.key);
    if (!mc) {
      const groups = new Map<string, MixGroup>();
      for (const id of src.eligible) {
        const key = this.deps.meta(id)?.showId ?? "films";
        const g = groups.get(key) ?? { key, ids: [], order: [], pos: 0, lap: 0, aired: 0, premieres: [] };
        g.ids.push(id);
        groups.set(key, g);
      }
      const prem = new Set(mix.premieres ?? []);
      for (const g of groups.values()) {
        g.premieres = g.ids.filter((id) => prem.has(id));
        g.order = this.groupOrder(src, g);
      }
      mc = { groups: [...groups.values()].filter((g) => (mix.weights?.[g.key] ?? 50) > 0), turn: 0 };
      this.mixes.set(src.key, mc);
    }
    const next = (g: MixGroup) => g.premieres[0] ?? g.order[g.pos]!;
    const fits = (g: MixGroup) => this.deps.length(next(g), src.slotMs) <= room;
    let chosen: MixGroup | undefined;
    // After a marathon, another show goes next (if one fits).
    let rest: string | undefined;
    if (mc.marathon && this.t < mc.marathon.untilMs) chosen = mc.groups.find((g) => g.key === mc!.marathon!.key && fits(g));
    if (mc.marathon && !chosen) {
      rest = mc.marathon.key;
      mc.marathon = undefined;
    }
    if (!chosen) {
      let best = Infinity;
      let bestTie = Infinity;
      const others = rest ? mc.groups.some((g) => g.key !== rest && fits(g)) : false;
      for (const g of mc.groups) {
        if (!fits(g) || (others && g.key === rest)) continue;
        const w = (mix.weights?.[g.key] ?? 50) * (g.premieres.length ? 3 : 1);
        const score = g.aired / w;
        const tie = hash32(`${src.rev.seed}|${mc.turn}|${g.key}`);
        if (score < best - 1e-9 || (Math.abs(score - best) <= 1e-9 && tie < bestTie)) (best = score), (bestTie = tie), (chosen = g);
      }
      if (!chosen) return null;
      if (mix.marathon && mc.groups.length > 1 && hash32(`${src.rev.seed}|${mc.turn}|marathon`) / 4294967296 < mix.marathon.chance)
        mc.marathon = { key: chosen.key, untilMs: this.t + mix.marathon.maxMs };
    }
    const id = next(chosen);
    if (chosen.premieres.length) chosen.premieres.shift();
    else if (++chosen.pos >= chosen.order.length) {
      chosen.lap++;
      chosen.pos = 0;
      chosen.order = this.groupOrder(src, chosen);
    }
    chosen.aired += mix.balance === "duration" ? this.deps.length(id, src.slotMs) : 1;
    mc.turn++;
    return id;
  }

  /** A show's episodes in order (shuffled per lap for shuffle orderings); films shuffled per lap. */
  private groupOrder(src: Source, g: MixGroup): string[] {
    const shuffle = g.key === "films" || src.rev.ordering.includes("shuffle");
    if (shuffle) return seededShuffle(g.ids, `${src.rev.seed}|${g.key}|${g.lap}`);
    const pos = new Map(g.ids.map((id, i) => [id, i]));
    const rank = (id: string) => { const m = this.deps.meta(id); return [m?.season ?? 0, m?.episode ?? 0, pos.get(id)!]; };
    return g.ids.slice().sort((a, b) => { const x = rank(a), y = rank(b); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; });
  }

  /** The next program for this source that fits in `room`, advancing its place in line. */
  private pick(src: Source, room: number): string | null {
    if (this.rev.mix) return this.pickMix(src, room, this.rev.mix);
    const c = this.cursors.get(src.key) ?? { k: 0, i: 0, pending: [] };
    this.cursors.set(src.key, c);
    const fits = (id: string) => this.deps.length(id, src.slotMs) <= room;
    const p = c.pending.findIndex(fits);
    if (p >= 0) return c.pending.splice(p, 1)[0]!;
    const n = src.eligible.length;
    let k = c.k;
    let i = c.i;
    const passed: string[] = [];
    for (let look = 0; look < Math.min(LOOKAHEAD, n); look++) {
      const id = this.order(src, k)[i]!;
      i++;
      if (i >= n) (k++, (i = 0));
      if (fits(id)) {
        c.k = k;
        c.i = i;
        c.pending.push(...passed);
        if (c.pending.length > MAX_PENDING) c.pending.splice(0, c.pending.length - MAX_PENDING);
        return id;
      }
      passed.push(id);
    }
    return null;
  }
}

function lastStartingAtOrBefore(list: Planned[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid]!.startMs <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
