// Read-ahead for the show being watched (EXP-012). The player reads a file at its own
// pace and the browser only holds so much ahead of the picture, so a provider that
// goes quiet mid-show soon freezes it. Here the server keeps reading from the host
// up to a cap past what the player has taken, and hands those bytes over as the
// player asks. A stall then drains this reserve first.
//
// Only for the stream already being watched, once it has stayed open 10 s: nothing
// here opens a request, and surfing past a channel reads no further. When the
// player drops the stream (channel change, seek, stop), the reserve is discarded and
// counted as wasted in Meters.

import type { Readable } from "node:stream";
import type http from "node:http";

/** Seconds of the file to hold past what the player has taken. */
export const READ_AHEAD_S = 60;
export const READ_AHEAD_MIN = 8 * 1024 * 1024;
export const READ_AHEAD_MAX = 128 * 1024 * 1024;
/**
 * A stream has to stay open this long before it reads ahead, so surfing past a
 * channel costs what it did before (EXP-002's cancel-and-dwell numbers still hold).
 */
export const READ_AHEAD_AFTER_MS = 10_000;

/** Bytes to hold for a file of this size and length: about READ_AHEAD_S of it, within bounds. */
export function readAheadBytes(bytes: number | null | undefined, durationMs: number | null | undefined): number {
  if (!bytes || !durationMs) return 32 * 1024 * 1024;
  return Math.round(Math.min(READ_AHEAD_MAX, Math.max(READ_AHEAD_MIN, (bytes / (durationMs / 1000)) * READ_AHEAD_S)));
}

export interface ReadAheadResult {
  /** Bytes read from the host but never sent, because the player left first. */
  unsent: number;
  /** Most bytes held at once. */
  peak: number;
}

/**
 * Like body.pipe(res), but once the response has been open `after` ms, reading up
 * to `cap` bytes ahead of it. `done` is called once, when the response ends or closes.
 */
export function pipeWithReadAhead(body: Readable, res: http.ServerResponse, cap: number, done: (r: ReadAheadResult) => void,
  after = READ_AHEAD_AFTER_MS, onPeak?: (bytes: number) => void): void {
  const openedAt = Date.now();
  const limit = () => (Date.now() - openedAt >= after ? cap : 0);
  const queue: Buffer[] = [];
  let queued = 0;
  let peak = 0;
  let draining = false;
  let upstreamEnded = false;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    done({ unsent: queued, peak });
    queue.length = 0;
    queued = 0;
  };
  const flush = () => {
    while (queue.length && !draining && !res.destroyed) {
      const c = queue.shift()!;
      queued -= c.length;
      if (!res.write(c)) {
        draining = true;
        res.once("drain", () => {
          draining = false;
          flush();
        });
      }
    }
    // Before the stream has settled this is a plain pipe: read only as the player takes.
    // After, keep reading up to the cap even while the player holds back.
    const cap = limit();
    if (body.isPaused() && !upstreamEnded && (cap > 0 ? queued < cap : !draining && !queued)) body.resume();
    if (upstreamEnded && !queue.length && !res.writableEnded) res.end();
  };

  body.on("data", (chunk: Buffer) => {
    queue.push(chunk);
    queued += chunk.length;
    if (queued > peak) {
      peak = queued;
      onPeak?.(peak);
    }
    if (queued >= limit()) body.pause();
    flush();
  });
  body.on("end", () => {
    upstreamEnded = true;
    flush();
  });
  body.on("error", () => res.destroy());
  res.on("close", () => {
    clearTimeout(wake);
    if (!body.destroyed) body.destroy();
    finish();
  });
  // When the wait is over, start reading ahead even if the player is holding back.
  const wake = setTimeout(() => !finished && flush(), after);
}
