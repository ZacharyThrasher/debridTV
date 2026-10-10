// The station clock: a pure function from (channel config, media durations, time)
// to "what is airing and where in it". It never touches a provider, so building or
// browsing a guide costs zero API calls and zero media bytes (gates B1, C1, C6).
//
// Model: each revision of a channel repeats "cycles". A cycle is one pass over the
// eligible items in an order derived from (seed, cycle index). Airing lengths are
// derived from exact file durations plus break layout, so the position at any
// instant is found with arithmetic and a binary search — no materialised log.

import { cycleOrder } from "./ordering.ts";
import type {
  Airing,
  Channel,
  ChannelRevision,
  MediaItem,
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
  reason: "not-in-library" | "duration-unknown";
}

export { cycleOrder };

export class StationClock {
  private readonly library: ReadonlyMap<string, MediaItem>;
  private readonly cycles = new Map<string, Cycle>();

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
    }
    return out;
  }

  /** The airing covering instant t, or null when the channel is off air. */
  airingAt(channel: Channel, t: number): Airing | null {
    const ri = revisionIndexAt(channel, t);
    if (ri < 0) return null;
    const rev = channel.revisions[ri]!;
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
        // Off air until the next revision (if any) begins.
        const next = channel.revisions.find((r) => r.effectiveFromMs > t);
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

  private eligible(rev: ChannelRevision): string[] {
    return rev.itemIds.filter((id) => {
      const d = this.library.get(id)?.durationMs;
      return d != null && d > 0;
    });
  }

  private airingLength(rev: ChannelRevision, itemId: string): number {
    const m = this.library.get(itemId)!;
    const bps = validBreakpoints(m);
    const raw = m.durationMs! + bps.length * (rev.midBreakMs ?? 0);
    if (!rev.slotMs) return raw;
    return Math.ceil(raw / rev.slotMs) * rev.slotMs;
  }

  private cycle(channel: Channel, ri: number, k: number, eligible: string[]): Cycle {
    const key = `${channel.id}#${ri}#${k}`;
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

  private buildAiring(channel: Channel, ri: number, itemId: string, startMs: number): Airing {
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
    const fullEnd = startMs + this.airingLength(rev, itemId);
    if (fullEnd > t) segments.push({ kind: "break", startMs: t, endMs: fullEnd, reason: "padding" });

    const nextRev = channel.revisions[ri + 1];
    const cap = nextRev ? nextRev.effectiveFromMs : Infinity;
    const truncated = fullEnd > cap;
    const endMs = Math.min(fullEnd, cap);
    const clipped = segments
      .filter((s) => s.startMs < endMs)
      .map((s) => (s.endMs > endMs ? { ...s, endMs } : s));
    return { channelId: channel.id, itemId, startMs, endMs, segments: clipped, truncated };
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
