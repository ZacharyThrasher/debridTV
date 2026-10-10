// Viewing history is a separate fact from the station timeline and from the
// player's file position (handoff §6.4). A program counts as watched only from
// file time the viewer actually saw, so joining the last two minutes of an hour
// does not mark it watched (gate D8). Break time is never recorded here.

export interface WatchedPolicy {
  /** Fraction of the file's duration that must actually have been seen. */
  threshold: number;
}

export const DEFAULT_POLICY: WatchedPolicy = { threshold: 0.9 };

export class WatchLedger {
  private readonly spans = new Map<string, Array<[number, number]>>();

  /** Record that file time [fromMs, toMs) of an item was on screen. */
  record(itemId: string, fromMs: number, toMs: number): void {
    if (!(toMs > fromMs)) return;
    const list = this.spans.get(itemId) ?? [];
    list.push([fromMs, toMs]);
    this.spans.set(itemId, merge(list));
  }

  seenMs(itemId: string): number {
    return (this.spans.get(itemId) ?? []).reduce((n, [a, b]) => n + (b - a), 0);
  }

  isWatched(itemId: string, durationMs: number, policy: WatchedPolicy = DEFAULT_POLICY): boolean {
    return durationMs > 0 && this.seenMs(itemId) / durationMs >= policy.threshold;
  }
}

function merge(spans: Array<[number, number]>): Array<[number, number]> {
  const s = spans.slice().sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
