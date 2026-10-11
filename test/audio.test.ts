// Local audio for the music channel (N-23a): running time and tags from the
// file's own header bytes, and names when the file has no tags.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { probeAudio, tagsFromPath } from "../src/library/audio.ts";

async function probeFile(name: string) {
  const b = new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  return probeAudio(async (start, len) => b.subarray(start, start + len), b.byteLength);
}
const near = (a: number | null, b: number, tol = 40) => assert.ok(a != null && Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("N-23a: MP3 with ID3v2.3, constant bitrate", async () => {
  const r = (await probeFile("audio-cbr.mp3"))!;
  assert.equal(r.codec, "mp3");
  near(r.durationMs, 3056, 80);
  assert.deepEqual(r.tags, { title: "Night Drive", artist: "The Tapes", album: "Cassette", track: 3, year: 1987, genre: "Synthpop" });
});

test("N-23a: MP3 with a Xing header and ID3v2.4 UTF-8", async () => {
  const r = (await probeFile("audio-vbr.mp3"))!;
  near(r.durationMs, 3056);
  assert.equal(r.tags.title, "Ünïcode Song");
  assert.equal(r.tags.artist, "The Tapes");
});

test("N-23a: FLAC, Ogg Vorbis, Opus and WAV", async () => {
  const flac = (await probeFile("audio.flac"))!;
  assert.equal(flac.codec, "flac");
  near(flac.durationMs, 3000, 2);
  assert.deepEqual(flac.tags, { title: "Night Drive", artist: "The Tapes", album: "Cassette", track: 3, year: 1987 });
  const ogg = (await probeFile("audio.ogg"))!;
  assert.equal(ogg.codec, "vorbis");
  near(ogg.durationMs, 3000, 2);
  assert.deepEqual(ogg.tags, { title: "Night Drive", artist: "The Tapes" });
  const opus = (await probeFile("audio.opus"))!;
  assert.equal(opus.codec, "opus");
  near(opus.durationMs, 3000, 10);
  assert.equal(opus.tags.title, "Night Drive");
  const wav = (await probeFile("audio.wav"))!;
  assert.equal(wav.codec, "pcm");
  near(wav.durationMs, 3000, 2);
});

test("N-23a: not audio is null; reads stay small", async () => {
  const r = await probeFile("fixture-h264-aac.mkv");
  assert.equal(r, null);
  assert.ok((await probeFile("audio-cbr.mp3"))!.bytesRead < 300 * 1024);
});

test("N-23a: names stand in for missing tags", () => {
  assert.deepEqual(tagsFromPath("The Tapes/Cassette (1987)/03 - Night Drive.mp3"), { title: "Night Drive", artist: "The Tapes", album: "Cassette", track: 3 });
  assert.deepEqual(tagsFromPath("Music/The Tapes - Night Drive.flac"), { title: "Night Drive", artist: "The Tapes" });
  assert.deepEqual(tagsFromPath("loose.ogg"), { title: "loose" });
});

test("N-23a: local songs make a Jukebox channel, back to back, served as audio", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "debridtv-music-home-"));
  process.env.DEBRIDTV_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "debridtv-music-"));
  const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url);
  const album = join(root, "The Tapes", "Cassette (1987)");
  mkdirSync(album, { recursive: true });
  mkdirSync(join(root, "Other Band"), { recursive: true });
  copyFileSync(fx("audio-cbr.mp3"), join(album, "03 - Night Drive.mp3"));
  copyFileSync(fx("audio.flac"), join(album, "04 - Neon.flac"));
  copyFileSync(fx("audio.ogg"), join(album, "05 - Static.ogg"));
  copyFileSync(fx("audio.wav"), join(root, "Other Band", "01 - Untagged Song.wav"));
  copyFileSync(fx("audio.opus"), join(root, "Other Band", "02 - Small Hours.opus"));
  writeFileSync(join(album, "cover.jpg"), Buffer.from("89504e470d0a1a0a", "hex"));
  const { createApp } = await import("../app/server.ts");
  const app = createApp({ port: 0, ffmpeg: false, timers: false });
  const base = `http://127.0.0.1:${await app.listen()}`;
  try {
    const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post("/api/sources", { provider: "local", dirs: [root] })).status, 200);
    await post("/api/scan/start", { perMinute: 600 });
    let ch: any;
    for (let t = 0; t < 100 && !ch; t++) {
      await new Promise((r) => setTimeout(r, 100));
      ch = ((await (await fetch(`${base}/api/bootstrap`)).json()) as any).channels.find((c: any) => c.kind === "music");
    }
    assert.ok(ch, "Jukebox on the air");
    assert.equal(ch.name, "Jukebox");
    assert.equal(ch.number, 90);
    const from = Date.now();
    const g = (await (await fetch(`${base}/api/guide?from=${from}&to=${from + 30_000}`)).json()) as any;
    const airings = g.rows.find((r: any) => r.channel.id === ch.id).airings;
    assert.ok(airings.length >= 5);
    for (let i = 1; i < airings.length; i++) assert.equal(airings[i].start, airings[i - 1].end, "back to back");
    const night = airings.find((a: any) => a.genre === "Synthpop"); // the MP3 (other fixtures share its title)
    assert.deepEqual([night.kind, night.artist, night.album, night.trackNo, night.year, night.genre], ["track", "The Tapes", "Cassette", 3, 1987, "Synthpop"], "tags from the file");
    assert.match(night.art.poster, /^\/api\/art\//, "the album cover");
    const untagged = airings.find((a: any) => a.title === "Untagged Song");
    assert.deepEqual([untagged.artist, untagged.album, untagged.trackNo], [null, "Other Band", 1], "names stand in for missing tags (one folder: the album)");
    const media = await fetch(`${base}/media/${night.itemId}`, { headers: { range: "bytes=0-99" } });
    assert.equal(media.status, 206);
    assert.equal(media.headers.get("content-type"), "audio/mpeg");
    await media.arrayBuffer();
    const od = (await (await fetch(`${base}/api/ondemand`)).json()) as any;
    assert.deepEqual([od.shows.length, od.movies.length], [0, 0], "songs aren't shows or films");
    assert.equal(((await (await fetch(`${base}/api/meters`)).json()) as any).apiTotal, 0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
