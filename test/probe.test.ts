import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMatroska, parseMp4, probe } from "../src/library/probe.ts";
import type { RangeReader } from "../src/library/probe.ts";

const fx = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function memoryReader(data: Uint8Array): { read: RangeReader; reads: [number, number][] } {
  const reads: [number, number][] = [];
  const read: RangeReader = async (start, length) => {
    reads.push([start, length]);
    return data.slice(start, start + length);
  };
  return { read, reads };
}

const TOL = 60;
const close = (actual: number | null, expected: number): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= TOL, `duration ${actual} not within ${TOL}ms of ${expected}`);
};

const FIXTURES: [file: string, container: "matroska" | "mp4", ms: number, video: string, audio: string][] = [
  ["fixture-h264-aac.mkv", "matroska", 7523, "h264", "aac"],
  ["fixture-h264-ac3.mkv", "matroska", 5200, "h264", "ac3"],
  ["fixture-hevc-eac3.mkv", "matroska", 5000, "hevc", "eac3"],
  ["fixture-vp9-opus.mkv", "matroska", 4408, "vp9", "opus"],
  ["fixture-h264-aac-moov-end.mp4", "mp4", 7500, "h264", "aac"],
  ["fixture-h264-aac-faststart.mp4", "mp4", 7500, "h264", "aac"],
];

for (const [file, container, ms, video, audio] of FIXTURES) {
  test(`probe: ${file}`, async () => {
    const data = fx(file);
    assert.ok(data.length <= 60 * 1024, "fixture stays tiny");
    const { read } = memoryReader(data);
    const r = await probe(read, data.length);
    assert.equal(r.container, container);
    close(r.durationMs, ms);
    assert.equal(r.video, video);
    assert.deepEqual(r.audio, [audio]);
    assert.ok(r.bytesRead <= data.length);
  });
}

test("parseMatroska: direct on fixture bytes", () => {
  const r = parseMatroska(fx("fixture-h264-aac.mkv"));
  close(r.durationMs, 7523);
  assert.equal(r.video, "h264");
  assert.deepEqual(r.audio, ["aac"]);
});

test("parseMp4: moov first reports its offset", () => {
  const r = parseMp4(fx("fixture-h264-aac-faststart.mp4"), 0);
  close(r.durationMs, 7500);
  assert.equal(r.moovAt, 32);
});

test("parseMp4: moov last reports its offset", () => {
  const r = parseMp4(fx("fixture-h264-aac-moov-end.mp4"), 0);
  close(r.durationMs, 7500);
  assert.equal(r.moovAt, 34864);
});

test("parseMp4: fileOffset is added to moovAt", () => {
  const data = fx("fixture-h264-aac-moov-end.mp4");
  const r = parseMp4(data.subarray(34864), 34864);
  close(r.durationMs, 7500);
  assert.equal(r.moovAt, 34864);
});

test("truncated matroska yields null duration without throwing", async () => {
  const data = fx("fixture-h264-aac.mkv");
  for (const n of [0, 1, 4, 20, 60, 120]) {
    const cut = data.subarray(0, n);
    assert.doesNotThrow(() => parseMatroska(cut));
    const { read } = memoryReader(cut);
    const r = await probe(read, data.length);
    assert.equal(r.durationMs, null, `cut at ${n}`);
  }
});

test("truncated mp4 yields null duration without throwing", async () => {
  const data = fx("fixture-h264-aac-faststart.mp4");
  for (const n of [0, 5, 12, 40, 52, 60]) {
    const cut = data.subarray(0, n);
    assert.doesNotThrow(() => parseMp4(cut, 0));
    const { read } = memoryReader(cut);
    const r = await probe(read, data.length);
    assert.equal(r.durationMs, null, `cut at ${n}`);
  }
});

test("mp4 with a partially read moov still yields the duration (mvhd is first)", async () => {
  const data = fx("fixture-h264-aac-faststart.mp4");
  const { read } = memoryReader(data.subarray(0, 100));
  const r = await probe(read, data.length);
  close(r.durationMs, 7500);
});

test("mp4 whose moov is cut off (moov-at-end, tail missing) gives null", async () => {
  const data = fx("fixture-h264-aac-moov-end.mp4");
  const cut = data.subarray(0, 34864 + 6);
  const { read } = memoryReader(cut);
  const r = await probe(read, cut.length);
  assert.equal(r.container, "mp4");
  assert.equal(r.durationMs, null);
});

test("garbage input is unknown, not an error", async () => {
  const junk = new Uint8Array(5000).map((_, i) => (i * 31) & 0xff);
  const { read } = memoryReader(junk);
  const r = await probe(read, junk.length);
  assert.equal(r.container, "unknown");
  assert.equal(r.durationMs, null);
  assert.equal(r.bytesRead, junk.length);
});

test("probe: reader returning fewer bytes than asked is tolerated", async () => {
  const data = fx("fixture-h264-aac.mkv");
  const read: RangeReader = async (start, length) => data.slice(start, start + Math.min(length, 100_000));
  const r = await probe(read, data.length);
  close(r.durationMs, 7523);
});

// --- synthetic big files -------------------------------------------------

function sparseReader(size: number, regions: [number, Uint8Array][]): { read: RangeReader; reads: [number, number][]; served: () => number } {
  const reads: [number, number][] = [];
  let served = 0;
  const read: RangeReader = async (start, length) => {
    reads.push([start, length]);
    const end = Math.min(size, start + length);
    const out = new Uint8Array(Math.max(0, end - start));
    for (const [at, bytes] of regions) {
      const lo = Math.max(start, at);
      const hi = Math.min(end, at + bytes.length);
      if (hi > lo) out.set(bytes.subarray(lo - at, hi - at), lo - start);
    }
    served += out.length;
    return out;
  };
  return { read, reads, served: () => served };
}

test("probe: 2 GB mp4 with moov at the end uses a few small reads", async () => {
  const src = fx("fixture-h264-aac-moov-end.mp4");
  const moov = src.subarray(34864);
  const ftyp = src.subarray(0, 32);
  const mdatSize = 2_000_000_000;
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, mdatSize);
  mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
  const moovAt = 32 + mdatSize;
  const total = moovAt + moov.length;
  const s = sparseReader(total, [[0, ftyp], [32, mdatHeader], [moovAt, moov]]);
  const r = await probe(s.read, total);
  assert.equal(r.container, "mp4");
  close(r.durationMs, 7500);
  assert.equal(r.video, "h264");
  assert.deepEqual(r.audio, ["aac"]);
  assert.equal(r.bytesRead, s.served());
  assert.ok(r.bytesRead <= 3 * 1024 * 1024);
  assert.ok(s.reads.length <= 5, `reads: ${JSON.stringify(s.reads)}`);
  assert.ok(s.reads.some(([start]) => start === moovAt), "moov fetched by offset");
});

test("probe: 64-bit mdat size (largesize) is skipped correctly", async () => {
  const src = fx("fixture-h264-aac-moov-end.mp4");
  const moov = src.subarray(34864);
  const ftyp = src.subarray(0, 32);
  const big = 6_000_000_000;
  const mdatHeader = new Uint8Array(16);
  const dv = new DataView(mdatHeader.buffer);
  dv.setUint32(0, 1);
  mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4);
  dv.setUint32(8, Math.floor(big / 4294967296));
  dv.setUint32(12, big % 4294967296);
  const moovAt = 32 + big;
  const s = sparseReader(moovAt + moov.length, [[0, ftyp], [32, mdatHeader], [moovAt, moov]]);
  const r = await probe(s.read, moovAt + moov.length);
  close(r.durationMs, 7500);
});

// --- EBML builders for edge cases ------------------------------------------

function ebmlSize(n: number): number[] {
  return [0x08, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; // 5-byte vint
}
function el(id: number[], body: number[]): number[] {
  return [...id, ...ebmlSize(body.length), ...body];
}
function f32(v: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v);
  return [...b];
}
function f64(v: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return [...b];
}
const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])); // DocType "webm"
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const DURATION = [0x44, 0x89];
const SCALE = [0x2a, 0xd7, 0xb1];
const INFO = [0x15, 0x49, 0xa9, 0x66];

test("matroska: default timecode scale, float32 duration, unknown-size segment", () => {
  const bytes = Uint8Array.from([...EBML_HEADER, ...SEGMENT_UNKNOWN, ...el(INFO, el(DURATION, f32(5000.5)))]);
  assert.equal(parseMatroska(bytes).durationMs, 5001);
});

test("matroska: custom timecode scale and float64 duration", () => {
  const info = [...el(SCALE, [0x0f, 0x42, 0x40]), ...el(DURATION, f64(123456))]; // scale 1_000_000
  const bytes = Uint8Array.from([...EBML_HEADER, ...SEGMENT_UNKNOWN, ...el(INFO, info)]);
  assert.equal(parseMatroska(bytes).durationMs, 123456);
  const info2 = [...el(SCALE, [0x03, 0xe8]), ...el(DURATION, f64(2_000_000))]; // scale 1000 ns/tick
  const bytes2 = Uint8Array.from([...EBML_HEADER, ...SEGMENT_UNKNOWN, ...el(INFO, info2)]);
  assert.equal(parseMatroska(bytes2).durationMs, 2000);
});

test("matroska: unknown codec id is returned raw", () => {
  const te = el([0xae], [...el([0x83], [1]), ...el([0x86], [...Buffer.from("V_MS/VFW/FOURCC")])]);
  const bytes = Uint8Array.from([...EBML_HEADER, ...SEGMENT_UNKNOWN, ...el([0x16, 0x54, 0xae, 0x6b], te)]);
  assert.equal(parseMatroska(bytes).video, "V_MS/VFW/FOURCC");
});

test("probe: huge leading Void in matroska is capped at exactly 3 MiB read", async () => {
  const void5mb = [0xec, ...ebmlSize(5_000_000)]; // Void element
  const head = Uint8Array.from([...EBML_HEADER, ...SEGMENT_UNKNOWN, ...void5mb]);
  const size = 8_000_000;
  const s = sparseReader(size, [[0, head]]);
  const r = await probe(s.read, size);
  assert.equal(r.container, "matroska");
  assert.equal(r.durationMs, null);
  assert.equal(r.bytesRead, 3 * 1024 * 1024);
  assert.equal(s.served(), r.bytesRead);
});

test("probe: reads counted and bounded for an ordinary mkv", async () => {
  const data = fx("fixture-h264-ac3.mkv");
  const { read, reads } = memoryReader(data);
  const r = await probe(read, data.length);
  assert.equal(reads.length, 1);
  assert.equal(reads[0][0], 0);
  assert.equal(r.bytesRead, data.length);
});

test("N-18a / N-22b: track list with languages and flags, and chapter starts (Matroska)", async () => {
  // fixture-tracks-chapters.mkv: h264, aac eng, aac spa "Español" (not default), srt eng forced, chapters at 0/2/5 s.
  const r = await probe(memoryReader(fx("fixture-tracks-chapters.mkv")).read, fx("fixture-tracks-chapters.mkv").byteLength);
  close(r.durationMs, 8023);
  assert.deepEqual(r.tracks?.map((t) => [t.kind, t.index, t.codec, t.lang]), [
    ["video", 0, "h264", "und"], ["audio", 0, "aac", "eng"], ["audio", 1, "aac", "spa"], ["subtitle", 0, "srt", "eng"],
  ]);
  assert.equal(r.tracks?.[2]?.name, "Español");
  assert.equal(r.tracks?.[3]?.forced, true);
  assert.deepEqual(r.chaptersMs, [0, 2000, 5000]);
  assert.deepEqual(r.audio, ["aac", "aac"], "the old summary fields are unchanged");
});

test("MP4 tracks carry their language from mdhd", async () => {
  const data = fx("fixture-h264-aac-faststart.mp4");
  const r = await probe(memoryReader(data).read, data.byteLength);
  assert.deepEqual(r.tracks?.map((t) => [t.kind, t.codec]), [["video", "h264"], ["audio", "aac"]]);
  assert.ok(r.tracks?.every((t) => /^[a-z]{3}$/.test(t.lang)));
});
