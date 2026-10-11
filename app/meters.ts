// What the app costs, measured where it happens (gate B6: playback, probing and
// inventory are counted separately). Bytes are counted as they arrive from the
// provider, so a cancelled stream still shows what it actually pulled.

import { CallCounter } from "../src/providers/clients.ts";

export type ByteKind = "playback" | "probe";

export interface MeterEvent {
  at: number;
  kind: "tune" | "stream-open" | "stream-close" | "cancel" | "api" | "error" | "probe";
  detail: string;
}

export class Meters {
  readonly api = new CallCounter();
  readonly bytes: Record<ByteKind, number> = { playback: 0, probe: 0 };
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
      bytes: { ...this.bytes },
      streamsOpened: this.streamsOpened,
      streamsCancelled: this.streamsCancelled,
      activeStreams: this.activeStreams,
      peakStreams: this.peakStreams,
      tunes: this.tunes,
      events: this.events.slice(-40),
    };
  }
}
