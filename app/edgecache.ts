// Edge cache: the first 1 MiB and last 256 KiB of files people have actually tuned.
//
// A browser opening a video mid-program makes a few range requests in a row
// (header, index at the end, then the seek point), and each pays the media host's
// time to first byte. Keeping the two ends of a file lets the first two be answered
// here, and lets a read from the start begin at once while the rest comes from the
// host (ADR-0003, EXP-008).
//
// Guardrails (the "never retrieve unwatched media" goal):
//   - filled only from bytes already on their way to a viewer or the probe; this
//     module never asks a host for anything
//   - bounded (least recently used goes first), its size shown in Meters
//   - an entry is dropped when its file leaves the library, is refused, or its size changes
//   - bytes served from here are counted apart from bytes fetched upstream

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export const HEAD_BYTES = 1024 * 1024;
export const TAIL_BYTES = 256 * 1024;
export const DEFAULT_LIMIT = 256 * 1024 * 1024;

interface Entry {
  size: number;
  headLen: number;
  /** Absolute offset where the cached tail starts; equals size when there is no tail. */
  tailFrom: number;
  usedAt: number;
}

export class EdgeCache {
  private readonly dir: string;
  private index: Record<string, Entry> = {};
  private readonly limit: number;

  constructor(dir: string, limit = DEFAULT_LIMIT) {
    this.dir = dir;
    this.limit = limit;
    try {
      this.index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    } catch {
      this.index = {};
    }
  }

  /** Total bytes held. */
  bytes(): number {
    return Object.values(this.index).reduce((n, e) => n + e.headLen + (e.size - e.tailFrom), 0);
  }

  entries(): number {
    return Object.keys(this.index).length;
  }

  /** What is known for this file, if its size still matches. */
  get(id: string, size?: number): { size: number; headLen: number; tailFrom: number } | null {
    const e = this.index[id];
    if (!e) return null;
    if (size && size !== e.size) {
      this.drop(id);
      return null;
    }
    return { size: e.size, headLen: e.headLen, tailFrom: e.tailFrom };
  }

  /** Cached bytes [from, to] (inclusive) if wholly inside the head or the tail. */
  read(id: string, from: number, to: number): Buffer | null {
    const e = this.index[id];
    if (!e || from < 0 || to < from || to >= e.size) return null;
    try {
      if (to < e.headLen) {
        e.usedAt = Date.now();
        return readFileSync(this.file(id, "head")).subarray(from, to + 1);
      }
      if (from >= e.tailFrom) {
        e.usedAt = Date.now();
        return readFileSync(this.file(id, "tail")).subarray(from - e.tailFrom, to - e.tailFrom + 1);
      }
    } catch {
      this.drop(id);
    }
    return null;
  }

  /**
   * Watch bytes going by for one response: `start` is the response's first byte
   * in the file. Call `chunk` for each piece and `done(reachedEnd)` at the end;
   * only contiguous runs that extend the head, or a tail reaching the end of the
   * file, are kept.
   */
  observe(id: string, size: number, start: number): { chunk: (b: Uint8Array) => void; done: (reachedEnd: boolean) => void } {
    const cur = this.get(id, size);
    const headLen = cur?.headLen ?? 0;
    const tailFrom = cur?.tailFrom ?? size;
    const wantTail = Math.max(0, size - TAIL_BYTES);
    const head: Buffer[] = [];
    const tail: Buffer[] = [];
    let at = start;
    let headEnd = headLen;
    const tailStart = Math.max(start, wantTail);
    const collectTail = tailStart < tailFrom && start <= tailStart;
    return {
      chunk: (b) => {
        const from = at;
        const to = at + b.length;
        at = to;
        if (headEnd < HEAD_BYTES && from <= headEnd && to > headEnd) {
          const piece = b.subarray(headEnd - from, Math.min(b.length, HEAD_BYTES - from));
          head.push(Buffer.from(piece));
          headEnd += piece.length;
        }
        if (collectTail && to > tailStart) tail.push(Buffer.from(b.subarray(Math.max(0, tailStart - from))));
      },
      done: (reachedEnd) => {
        const gotTail = collectTail && reachedEnd && at === size;
        if (headEnd === headLen && !gotTail) return;
        try {
          mkdirSync(this.dir, { recursive: true });
          const prev = this.index[id];
          if (headEnd > headLen) {
            const before = headLen > 0 && existsSync(this.file(id, "head")) ? readFileSync(this.file(id, "head")).subarray(0, headLen) : Buffer.alloc(0);
            this.write(this.file(id, "head"), Buffer.concat([before, ...head]));
          }
          if (gotTail) this.write(this.file(id, "tail"), Buffer.concat(tail));
          this.index[id] = { size, headLen: headEnd > headLen ? headEnd : prev?.headLen ?? 0, tailFrom: gotTail ? tailStart : prev?.tailFrom ?? size, usedAt: Date.now() };
          this.evict();
          this.save();
        } catch {
          /* a cache that can't be written is just a slower tune */
        }
      },
    };
  }

  drop(id: string): void {
    if (!this.index[id]) return;
    delete this.index[id];
    for (const k of ["head", "tail"] as const) {
      try {
        unlinkSync(this.file(id, k));
      } catch {
        /* already gone */
      }
    }
    this.save();
  }

  /** Drop every entry whose file isn't wanted any more. */
  keepOnly(keep: (id: string) => boolean): void {
    for (const id of Object.keys(this.index)) if (!keep(id)) this.drop(id);
  }

  clear(): void {
    this.index = {};
    rmSync(this.dir, { recursive: true, force: true });
  }

  private evict(): void {
    let total = this.bytes();
    const oldest = Object.entries(this.index).sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [id, e] of oldest) {
      if (total <= this.limit) break;
      total -= e.headLen + (e.size - e.tailFrom);
      this.drop(id);
    }
  }

  private file(id: string, part: "head" | "tail"): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, "_")}.${part}`);
  }

  private write(path: string, data: Buffer): void {
    writeFileSync(`${path}.tmp`, data);
    renameSync(`${path}.tmp`, path);
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.write(join(this.dir, "index.json"), Buffer.from(JSON.stringify(this.index)));
    } catch {
      /* ignore */
    }
  }
}
