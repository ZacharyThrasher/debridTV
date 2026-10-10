// One playback grant per file, reused for the life of the grant. This is the
// defence against request amplification (handoff §5.5, gate E4): players read many
// ranges, but only the first read of a file should cost a provider API call.

import type { PlaybackGrant, ProviderClient } from "../providers/types.ts";

export interface GrantCacheOptions {
  /** Used when the provider states no expiry. Short on purpose; see handoff §5.2. */
  fallbackTtlMs?: number;
  now?: () => number;
}

export class GrantCache {
  private readonly entries = new Map<string, PlaybackGrant>();
  private readonly inflight = new Map<string, Promise<PlaybackGrant>>();
  private readonly ttl: number;
  private readonly now: () => number;
  hits = 0;
  misses = 0;

  constructor(opts: GrantCacheOptions = {}) {
    this.ttl = opts.fallbackTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async get(client: ProviderClient, ref: string, signal?: AbortSignal): Promise<PlaybackGrant> {
    const key = `${client.id}|${ref}`;
    const g = this.entries.get(key);
    if (g && this.now() < (g.expiresAtMs ?? g.obtainedAtMs + this.ttl)) {
      this.hits++;
      return g;
    }
    // Two tunes to the same file share one request. The shared request is not
    // tied to either caller's signal, so one caller leaving cannot fail the other.
    let p = this.inflight.get(key);
    if (!p) {
      this.misses++;
      p = client.resolve(ref).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    } else this.hits++;
    const grant = await abortable(p, signal);
    this.entries.set(key, grant);
    return grant;
  }

  /** Call when a grant URL is refused (expired/forbidden) so the next get re-resolves. */
  invalidate(client: ProviderClient, ref: string): void {
    this.entries.delete(`${client.id}|${ref}`);
  }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}
