// Silence-detected break points (parity N-22c), for local files only.
//
// Finding silences means decoding a file's whole soundtrack. For a file on this
// PC that costs only CPU and disk reads; for a debrid file it would mean
// downloading media nobody is watching, so debrid files are never analysed (and
// breakpoints() ignores silence on anything that isn't local). The job is off
// until the viewer starts it, runs one file at a time, and can be stopped.
//
// A break point is the middle of a silence of at least half a second, at least
// 3 minutes from either end and 5 minutes from the next, longest silences first,
// at most three per file: the same limits as chapter breaks.

import { spawn, type ChildProcess } from "node:child_process";

export interface Silence {
  startMs: number;
  endMs: number;
}

/** Silences from ffmpeg's silencedetect log lines. */
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]) * 1000);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start != null) {
      out.push({ startMs: Math.round(start), endMs: Math.round(Number(e[1]) * 1000) });
      start = null;
    }
  }
  return out;
}

const MIN3 = 3 * 60_000;
const APART = 5 * 60_000;

/** Up to three break points (file time) from a file's silences. */
export function breaksFromSilences(silences: Silence[], durationMs: number): number[] {
  const picks: number[] = [];
  const cands = silences
    .filter((s) => s.endMs - s.startMs >= 500 && s.endMs - s.startMs <= 15_000)
    .map((s) => ({ at: Math.round((s.startMs + s.endMs) / 2), len: s.endMs - s.startMs }))
    .filter((c) => c.at >= MIN3 && c.at <= durationMs - MIN3)
    .sort((a, b) => b.len - a.len || a.at - b.at);
  for (const c of cands) {
    if (picks.some((p) => Math.abs(p - c.at) < APART)) continue;
    picks.push(c.at);
    if (picks.length === 3) break;
  }
  return picks.sort((a, b) => a - b);
}

export interface SilenceTarget {
  id: string;
  path: string;
  durationMs: number;
  label: string;
}

export interface SilenceState {
  running: boolean;
  done: number;
  total: number;
  found: number;
  current?: string;
  stoppedReason?: string;
}

/** One file at a time through ffmpeg's silencedetect; audio only, video never decoded. */
export class SilenceJob {
  state: SilenceState = { running: false, done: 0, total: 0, found: 0 };
  private child: ChildProcess | null = null;
  private stop = false;
  private readonly ffmpeg: string | null;

  constructor(ffmpeg: string | null) {
    this.ffmpeg = ffmpeg;
  }

  async run(targets: SilenceTarget[], save: (id: string, r: { breaksMs: number[]; silences: number } | { error: string }, ms: number) => void): Promise<void> {
    if (this.state.running || !this.ffmpeg) return;
    this.stop = false;
    this.state = { running: true, done: 0, total: targets.length, found: 0 };
    for (const t of targets) {
      if (this.stop) break;
      this.state.current = t.label;
      const t0 = Date.now();
      try {
        const log = await this.detect(t.path);
        if (this.stop) break;
        const sil = parseSilences(log);
        const breaksMs = breaksFromSilences(sil, t.durationMs);
        if (breaksMs.length) this.state.found++;
        save(t.id, { breaksMs, silences: sil.length }, Date.now() - t0);
      } catch (e) {
        if (this.stop) break;
        save(t.id, { error: e instanceof Error ? e.message : String(e) }, Date.now() - t0);
      }
      this.state.done++;
    }
    this.state = { ...this.state, running: false, current: undefined, ...(this.stop ? { stoppedReason: "Stopped" } : {}) };
  }

  halt(): void {
    this.stop = true;
    this.child?.kill("SIGKILL");
  }

  private detect(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-nostdin", "-nostats", "-vn", "-sn", "-dn", "-i", path, "-map", "0:a:0", "-af", "silencedetect=noise=-45dB:duration=0.5", "-f", "null", "-"];
      const child = spawn(this.ffmpeg!, args, { stdio: ["ignore", "ignore", "pipe"] });
      this.child = child;
      let log = "";
      child.stderr!.on("data", (d: Buffer) => {
        // Keep only the lines we read; a long file's log is otherwise mostly noise.
        for (const line of d.toString().split("\n")) if (line.includes("silence_")) log += line + "\n";
      });
      child.on("error", reject);
      child.on("close", (code) => {
        this.child = null;
        code === 0 ? resolve(log) : reject(new Error(`ffmpeg exited ${code}`));
      });
    });
  }
}
