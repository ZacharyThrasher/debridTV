// What the app costs, measured where it happens (gate B6: playback, probing and
// inventory are counted separately). Bytes are counted as they arrive from the
// provider, so a cancelled stream still shows what it actually pulled.

import { CallCounter } from "../src/providers/clients.ts";

/** playback and probe are fetched from a host; cached was answered from the edge cache, no host involved. */
export type ByteKind = "playback" | "probe" | "cached";

export interface MeterEvent {
  at: number;
  kind: "tune" | "stream-open" | "stream-close" | "cancel" | "api" | "error" | "probe" | "backup" | "cache" | "lock" | "silence";
  detail: string;
}

/** Published request limits (handoff §5.1, §5.3). Changeable, so shown as context, not as a target. */
export const LIMITS = {
  realdebrid: { perMinute: 250, scope: "all requests together" },
  torbox: { perMinute: 300, scope: "per endpoint" },
} as const;

/** Counts calls and remembers when they happened, so the busiest minute can be shown. */
class RateCounter extends CallCounter {
  private readonly times: Array<[number, string]> = [];
  readonly peak: Record<string, number> = {};

  override add(name: string): void {
    super.add(name);
    const now = Date.now();
    this.times.push([now, name]);
    while (this.times.length && now - this.times[0]![0] > 60_000) this.times.shift();
    // RD's limit counts every endpoint together; TorBox's counts each endpoint.
    const bucket = name.startsWith("rd.") ? "realdebrid" : name;
    const inWindow = this.times.filter(([, n]) => (bucket === "realdebrid" ? n.startsWith("rd.") : n === name)).length;
    this.peak[bucket] = Math.max(this.peak[bucket] ?? 0, inWindow);
  }

  lastMinute(): Record<string, number> {
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [t, n] of this.times) if (now - t <= 60_000) out[n] = (out[n] ?? 0) + 1;
    return out;
  }
}

export class Meters {
  readonly api = new RateCounter();
  readonly bytes: Record<ByteKind, number> = { playback: 0, probe: 0, cached: 0 };
  /** Edge cache size on disk, set by the server. */
  cache = { bytes: 0, files: 0 };
  streamsOpened = 0;
  streamsCancelled = 0;
  activeStreams = 0;
  peakStreams = 0;
  tunes = 0;
  readonly since = Date.now();
  private readonly events: MeterEvent[] = [];

  add(kind: ByteKind, n: number): void {
    this.bytes[kind] += n;
  }

  open(detail: string): void {
    this.streamsOpened++;
    this.activeStreams++;
    this.peakStreams = Math.max(this.peakStreams, this.activeStreams);
    this.log("stream-open", detail);
  }

  close(detail: string, cancelled: boolean): void {
    this.activeStreams = Math.max(0, this.activeStreams - 1);
    if (cancelled) this.streamsCancelled++;
    this.log(cancelled ? "cancel" : "stream-close", detail);
  }

  log(kind: MeterEvent["kind"], detail: string): void {
    this.events.push({ at: Date.now(), kind, detail });
    if (this.events.length > 200) this.events.shift();
  }

  snapshot() {
    return {
      since: this.since,
      api: { ...this.api.calls },
      apiTotal: this.api.total,
      apiLastMinute: this.api.lastMinute(),
      // Busiest minute so far, against each provider's published limit.
      apiPeak: Object.entries(this.api.peak).map(([bucket, peak]) => {
        const provider = bucket === "realdebrid" || bucket.startsWith("rd.") ? "realdebrid" : "torbox";
        return { bucket, peak, limit: LIMITS[provider].perMinute, scope: LIMITS[provider].scope };
      }),
      bytes: { ...this.bytes },
      cache: { ...this.cache },
      streamsOpened: this.streamsOpened,
      streamsCancelled: this.streamsCancelled,
      activeStreams: this.activeStreams,
      peakStreams: this.peakStreams,
      tunes: this.tunes,
      events: this.events.slice(-40),
    };
  }
}
