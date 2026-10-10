// Turns "the viewer selected channel N" into at most one live media fetch.
// Strategies are explicit so experiments can compare them (EXP-002):
//   naive  — every selection starts a fetch; nothing is stopped (models a leaky player)
//   cancel — a new selection aborts the previous resolve and media fetch
//   dwell  — cancel, and wait `dwellMs` on a channel before contacting a provider
//   adaptive — like dwell, but the wait follows the viewer's own press rhythm:
//              1.3 × the last gap between selections, clamped to [min, max]

import type { ProviderClient } from "../providers/types.ts";
import { GrantCache } from "./grants.ts";

export type Strategy = "naive" | "cancel" | "dwell" | "adaptive";

export interface TuneRequest {
  channelId: string;
  client: ProviderClient;
  ref: string;
  byteOffset: number;
}

export interface TunerOptions {
  strategy: Strategy;
  dwellMs?: number;
  /** Bounds for the adaptive wait. */
  adaptiveMinMs?: number;
  adaptiveMaxMs?: number;
  /** Bytes a player buffers before it stops reading and holds the connection. */
  bufferTargetBytes: number;
  grants?: GrantCache | null;
}

export interface TuneOutcome {
  channelId: string;
  status: "playing" | "superseded" | "error";
  firstByteMs?: number;
  error?: string;
}

interface Session {
  ctl: AbortController;
  done: Promise<TuneOutcome>;
  /** Settles once this session holds no connection any more. */
  released: Promise<void>;
}

export class Tuner {
  private readonly opts: TunerOptions;
  private current: Session | null = null;
  private readonly all: Session[] = [];
  private lastTuneAt = -Infinity;

  constructor(opts: TunerOptions) {
    this.opts = opts;
  }

  tune(req: TuneRequest): Promise<TuneOutcome> {
    const prev = this.opts.strategy !== "naive" ? this.current : null;
    prev?.ctl.abort(new Error("superseded"));
    const now = performance.now();
    const wait = this.waitFor(now - this.lastTuneAt);
    this.lastTuneAt = now;
    const ctl = new AbortController();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const done = this.run(req, ctl.signal, wait, release, prev?.released);
    const s = { ctl, done, released };
    this.current = s;
    this.all.push(s);
    return done;
  }

  /** Stop everything: sleep, sign-off, app close (gate B4). */
  stopAll(): void {
    for (const s of this.all) s.ctl.abort(new Error("stopped"));
    this.current = null;
  }

  private waitFor(gapMs: number): number {
    const { strategy, dwellMs = 0, adaptiveMinMs = 150, adaptiveMaxMs = 1200 } = this.opts;
    if (strategy === "dwell") return dwellMs;
    if (strategy !== "adaptive") return 0;
    // A long pause before this press means a deliberate pick, not surfing.
    if (gapMs > 2 * adaptiveMaxMs) return adaptiveMinMs;
    return Math.min(adaptiveMaxMs, Math.max(adaptiveMinMs, 1.3 * gapMs));
  }

  private async run(
    req: TuneRequest,
    signal: AbortSignal,
    waitMs: number,
    release: () => void,
    prev?: Promise<void>,
  ): Promise<TuneOutcome> {
    let holding = false;
    const t0 = performance.now();
    try {
      if (waitMs > 0) await delay(waitMs, signal);
      const grant = this.opts.grants
        ? await this.opts.grants.get(req.client, req.ref, signal)
        : await req.client.resolve(req.ref, signal);
      // Let the superseded session finish tearing down first, so two media
      // streams never overlap (EXP-002 saw a peak of 2 without this).
      await prev;
      signal.throwIfAborted();
      const res = await fetch(grant.url, { headers: { range: `bytes=${req.byteOffset}-` }, signal });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        if (res.status === 403 || res.status === 404) this.opts.grants?.invalidate(req.client, req.ref);
        return { channelId: req.channelId, status: "error", error: `media ${res.status}` };
      }
      const reader = res.body.getReader();
      let got = 0;
      let firstByteMs: number | undefined;
      while (got < this.opts.bufferTargetBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        firstByteMs ??= performance.now() - t0;
        got += value.byteLength;
      }
      // Buffer full: hold the connection open without reading, like a paused
      // player. Aborting the signal later tears it down.
      holding = true;
      signal.addEventListener("abort", () => void reader.cancel().catch(() => {}).finally(release), { once: true });
      return { channelId: req.channelId, status: "playing", firstByteMs };
    } catch (e) {
      if (signal.aborted) return { channelId: req.channelId, status: "superseded" };
      return { channelId: req.channelId, status: "error", error: String(e) };
    } finally {
      if (!holding) release();
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
