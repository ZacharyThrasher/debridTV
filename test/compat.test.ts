// Compatibility stream track choice (N-18a): audio pick, text subtitles beside the
// stream from the same ffmpeg process. Local file only; skipped without ffmpeg.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseVttBlock } from "../src/library/vtt.ts";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);

const home = mkdtempSync(join(tmpdir(), "debridtv-compat-"));
process.env.DEBRIDTV_HOME = home;
const media = join(home, "media");
mkdirSync(media);
// fixture-tracks-chapters.mkv: aac eng + aac spa, one forced English SRT cue "Hello" at 0.5–2.0 s.
copyFileSync(new URL("./fixtures/fixture-tracks-chapters.mkv", import.meta.url), join(media, "Track.Test.S01E01.mkv"));

const { createApp } = await import("../app/server.ts");
const app = createApp({ port: 0, timers: false, ffmpeg: hasFfmpeg });
let base = "";
let id = "";

before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
  await post("/api/sources", { provider: "local", dirs: [media] });
  await post("/api/scan/start", {});
  for (let i = 0; i < 100; i++) {
    const f = (await (await fetch(`${base}/api/library/files`)).json()).files.find((x: any) => x.name.startsWith("Track.Test"));
    if (f?.durationMs) {
      id = f.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function probeStreams(path: string): Promise<string[]> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:stream_tags=language", "-of", "csv=p=0", path]);
  return stdout.trim().split("\n");
}

test("WebVTT blocks: times, and only <i>/<b> survive", () => {
  assert.deepEqual(parseVttBlock("3\n00:01:02.500 --> 00:01:04.000 align:start\n<i>Hi</i> <font color=red>there</font> &amp; <b class=x>you</b>"),
    { startMs: 62_500, endMs: 64_000, text: "<i>Hi</i> there & <b>you</b>" });
  assert.deepEqual(parseVttBlock("01:00:00.000 --> 01:00:01.000\nx"), { startMs: 3_600_000, endMs: 3_601_000, text: "x" });
  assert.equal(parseVttBlock("WEBVTT"), null);
  assert.equal(parseVttBlock("00:00:02.000 --> 00:00:01.000\nbackwards"), null);
});

test("N-18a: the compatibility stream plays the chosen audio track and sends text subtitles beside it", { skip: !hasFfmpeg }, async () => {
  assert.ok(id, "file scanned");
  const res = await fetch(`${base}/media/${id}/live?start=1.2&a=1&s=0&tok=sub1`);
  assert.equal(res.status, 200);
  const out = join(home, "out.mp4");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(await probeStreams(out), ["video,und", "audio,spa"], "Spanish audio, nothing else in the stream");
  const zero = (await (await fetch(`${base}/api/livestart?tok=sub1`)).json()).startMs;
  assert.ok(zero <= 1200);
  let subs: any;
  for (let i = 0; i < 50 && !subs?.done; i++) {
    subs = await (await fetch(`${base}/api/livesubs?tok=sub1&since=0`)).json();
    if (!subs.done) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(subs.done, true);
  assert.equal(subs.cues.length, 1);
  const c = subs.cues[0];
  assert.equal(c.text, "Hello");
  // File time 0.5–2.0 s, measured from the stream's own start.
  assert.ok(Math.abs(c.startMs - (500 - zero)) < 60 && Math.abs(c.endMs - (2000 - zero)) < 60, JSON.stringify({ c, zero }));
  assert.deepEqual((await (await fetch(`${base}/api/livesubs?tok=sub1&since=${c.n}`)).json()).cues, []);
  assert.equal((await fetch(`${base}/media/${id}/live?a=7`)).status, 400, "an audio track the file doesn't have");
  assert.equal((await fetch(`${base}/api/livesubs?tok=nope`)).status, 404);
});

test("N-18a: ac=opus gives Opus audio for browsers without AAC; other codecs are refused", { skip: !hasFfmpeg }, async () => {
  assert.ok(id, "file scanned");
  const res = await fetch(`${base}/media/${id}/live?start=0&ac=opus`);
  assert.equal(res.status, 200);
  const out = join(home, "opus.mp4");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out]);
  assert.equal(stdout.trim(), "opus");
  assert.equal((await fetch(`${base}/media/${id}/live?ac=mp3`)).status, 400);
});
