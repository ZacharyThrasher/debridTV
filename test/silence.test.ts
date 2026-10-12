// Silence-detected breaks (N-22c): local files only, viewer-started, and only
// where a file has no chapters.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);
const home = mkdtempSync(join(tmpdir(), "debridtv-silence-home-"));
process.env.DEBRIDTV_HOME = home;
const { parseSilences, breaksFromSilences } = await import("../app/silence.ts");
const { breakpoints } = await import("../app/library.ts");
const { createApp } = await import("../app/server.ts");
const root = mkdtempSync(join(tmpdir(), "debridtv-silence-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const MIN = 60_000;

test("N-22c: silencedetect lines become silences", () => {
  const log = `[silencedetect @ 0x1] silence_start: -0.002\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.502\n` +
    `[silencedetect @ 0x1] silence_start: 239.01\nframe=1\n[silencedetect @ 0x1] silence_end: 241.02 | silence_duration: 2.01\n[silencedetect @ 0x1] silence_start: 470`;
  assert.deepEqual(parseSilences(log), [{ startMs: 0, endMs: 500 }, { startMs: 239_010, endMs: 241_020 }], "an unfinished silence at the end is dropped");
});

test("N-22c: break points: longest silences first, 3 min from the ends, 5 min apart, at most 3", () => {
  const s = (atMin: number, lenS: number) => ({ startMs: atMin * MIN, endMs: atMin * MIN + lenS * 1000 });
  const sil = [s(1, 3), s(8, 1), s(9, 2.5), s(20, 0.6), s(21, 0.8), s(30, 1), s(40, 1), s(43, 4), s(43.5, 30), s(10, 0.3)];
  // 44-min file: 1 min is too early, 43 too late, 43.5 too long (a quiet scene, not a break).
  assert.deepEqual(breaksFromSilences(sil, 44 * MIN).map((x) => Math.round(x / 1000)), [541, 1801, 2401]);
  assert.deepEqual(breaksFromSilences([], 44 * MIN), []);
});

test("N-22c: silences count only for local files without chapters", () => {
  const base = { durationMs: 44 * MIN, silence: { at: 1, breaksMs: [10 * MIN, 20 * MIN] } };
  assert.deepEqual(breakpoints({ ...base, provider: "local" }), [10 * MIN, 20 * MIN]);
  assert.deepEqual(breakpoints({ ...base, provider: "torbox" }), [], "never for debrid files");
  assert.deepEqual(breakpoints({ ...base, provider: "local", chaptersMs: [0, 15 * MIN] }), [15 * MIN], "chapters win");
});

test("N-22c: the job finds the silence in local episodes and the channel gets a mid-program break there", { skip: !hasFfmpeg }, async () => {
  const show = join(root, "Quiet Show");
  mkdirSync(show, { recursive: true });
  const src = join(root, "src.mkv");
  // 8 minutes, tiny picture, a 2-second silence at 4:00.
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:d=480",
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=8000:duration=480", "-af", "volume=enable='between(t,239,241)':volume=0",
    "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-b:a", "16k", "-ac", "1", "-shortest", src]);
  for (let i = 1; i <= 6; i++) copyFileSync(src, join(show, `Quiet.Show.S01E0${i}.mkv`));
  const app = createApp({ port: 0, timers: false });
  const base = `http://127.0.0.1:${await app.listen()}`;
  const post = (p: string, b: unknown = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  try {
    await post("/api/sources", { provider: "local", dirs: [root] });
    await post("/api/station", { breaks: true }); // breaks are opt-in (ADR-0006)
    await post("/api/scan/start", { perMinute: 600 });
    let ch: any;
    for (let t = 0; t < 100 && !ch; t++) {
      await new Promise((r) => setTimeout(r, 100));
      ch = (await get("/api/bootstrap")).channels.find((c: any) => c.name === "Quiet Show");
    }
    assert.ok(ch);
    const before = await get("/api/silence");
    assert.deepEqual([before.ffmpeg, before.eligible, before.pending, before.withBreaks], [true, 6, 6, 0]);
    const t0 = Date.now();
    assert.equal((await post("/api/silence/start")).status, 200);
    let st: any;
    for (let t = 0; t < 300; t++) {
      await new Promise((r) => setTimeout(r, 100));
      st = await get("/api/silence");
      if (!st.running && st.done === 6) break;
    }
    assert.deepEqual([st.done, st.found, st.pending, st.withBreaks], [6, 6, 0, 6]);
    const perFile = (Date.now() - t0) / 6;
    console.log(`# silence job: ${Math.round(perFile)} ms per 8-minute file`);
    await new Promise((r) => setTimeout(r, 500));
    const g = await get(`/api/guide?from=${Date.now()}&to=${Date.now() + 2 * 3600_000}`);
    const airing = g.rows.find((r: any) => r.channel.id === ch.id).airings.find((a: any) => a.segments.some((s: any) => s.reason === "mid"));
    assert.ok(airing, "a mid-program break");
    const first = airing.segments[0];
    assert.ok(Math.abs(first.end - first.start - 240_000) < 1000, `first part ends at the silence: ${first.end - first.start}`);
    const m = await get("/api/meters");
    assert.equal(m.apiTotal, 0, "no provider calls");
  } finally {
    await app.close();
  }
});
