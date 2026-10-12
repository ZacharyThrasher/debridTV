// Next-show pre-load bookkeeping (ADR-0006). The player asks for the opening bytes
// of the program that follows the one on screen, late in that program; the server
// fills the edge cache with them. This ledger says what that cost and whether it
// paid off: a pre-load is "used" when its file is then played, and "wasted" when
// nobody plays it within the window (the viewer tuned away, paused or stopped).

export const WASTE_AFTER_MS = 15 * 60_000;

interface Open {
  at: number;
  bytes: number;
  apiCalls: number;
  cancelled: boolean;
  done: boolean;
}

export interface PreloadStats {
  started: number;
  /** Nothing to fetch: the edge cache already had both ends. */
  alreadyCached: number;
  cancelled: number;
  failed: number;
  used: number;
  wasted: number;
  bytes: number;
  usedBytes: number;
  wastedBytes: number;
  apiCalls: number;
  /** Fetched, not yet played or written off. */
  pendingBytes: number;
}

export class PreloadLedger {
  private readonly open = new Map<string, Open>();
  private readonly now: () => number;
  private readonly wasteAfter: number;
  readonly stats: Omit<PreloadStats, "pendingBytes"> = {
    started: 0, alreadyCached: 0, cancelled: 0, failed: 0, used: 0, wasted: 0, bytes: 0, usedBytes: 0, wastedBytes: 0, apiCalls: 0,
  };

  constructor(opts: { now?: () => number; wasteAfterMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.wasteAfter = opts.wasteAfterMs ?? WASTE_AFTER_MS;
  }

  begin(id: string): void {
    this.settle();
    // A second pre-load of a file still waiting keeps the first one's bytes on its tab.
    const prev = this.open.get(id);
    this.open.set(id, { at: this.now(), bytes: prev?.bytes ?? 0, apiCalls: prev?.apiCalls ?? 0, cancelled: false, done: false });
    this.stats.started++;
  }

  alreadyCached(): void {
    this.stats.alreadyCached++;
  }

  bytes(id: string, n: number): void {
    const o = this.open.get(id);
    if (o) o.bytes += n;
    this.stats.bytes += n;
  }

  apiCalls(id: string, n: number): void {
    const o = this.open.get(id);
    if (o) o.apiCalls += n;
    this.stats.apiCalls += n;
  }

  end(id: string, how: "done" | "cancelled" | "failed"): void {
    const o = this.open.get(id);
    if (o) {
      o.done = true;
      o.cancelled = how === "cancelled";
    }
    if (how === "cancelled") this.stats.cancelled++;
    if (how === "failed") this.stats.failed++;
  }

  /** The file is being played: whatever was pre-loaded for it paid off. */
  played(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    this.open.delete(id);
    this.stats.used++;
    this.stats.usedBytes += o.bytes;
  }

  /** Write off pre-loads nobody played in time. */
  settle(): void {
    const t = this.now();
    for (const [id, o] of this.open) {
      if (t - o.at < this.wasteAfter) continue;
      this.open.delete(id);
      this.stats.wasted++;
      this.stats.wastedBytes += o.bytes;
    }
  }

  snapshot(): PreloadStats {
    this.settle();
    let pendingBytes = 0;
    for (const o of this.open.values()) pendingBytes += o.bytes;
    return { ...this.stats, pendingBytes };
  }
}
