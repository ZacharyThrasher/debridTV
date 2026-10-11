// Exact running time and tags of local audio files (music channel, parity N-23a),
// from the file's own header bytes: MP3 (ID3v2 + Xing/VBRI/CBR), FLAC
// (STREAMINFO + Vorbis comments), Ogg Vorbis/Opus (first and last pages), WAV.
// MP4 audio (.m4a) goes through probe.ts like any MP4. No dependencies, no network.

import type { RangeReader } from "./probe.ts";

export const AUDIO_EXT = new Set([".mp3", ".flac", ".ogg", ".oga", ".opus", ".wav", ".m4a"]);

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  track?: number;
  year?: number;
  genre?: string;
}

export interface AudioProbe {
  codec: "mp3" | "flac" | "vorbis" | "opus" | "pcm";
  durationMs: number | null;
  channels?: number;
  tags: AudioTags;
  bytesRead: number;
}

const HEAD = 256 * 1024;
const TAIL = 64 * 1024;

export async function probeAudio(read: RangeReader, size: number): Promise<AudioProbe | null> {
  let bytesRead = 0;
  const get = async (start: number, len: number) => {
    const b = await read(start, Math.max(0, Math.min(len, size - start)));
    bytesRead += b.byteLength;
    return b;
  };
  let head = await get(0, HEAD);
  const tag = ascii(head, 0, 4);
  if (tag === "fLaC") {
    const r = parseFlac(head);
    return r && { ...r, bytesRead };
  }
  if (tag === "OggS") {
    const first = parseOggHead(head);
    if (!first) return null;
    const tail = await get(Math.max(0, size - TAIL), TAIL);
    const granule = lastGranule(tail);
    const rate = first.codec === "opus" ? 48_000 : first.rate;
    const samples = granule == null ? null : granule - (first.preSkip ?? 0);
    return { codec: first.codec, channels: first.channels, durationMs: samples != null && rate ? Math.round((samples / rate) * 1000) : null, tags: first.tags, bytesRead };
  }
  if (tag === "RIFF" && ascii(head, 8, 4) === "WAVE") {
    const r = parseWav(head);
    return r && { ...r, bytesRead };
  }
  // MP3: optional ID3v2 (pictures can make it large), then frames.
  let tags: AudioTags = {};
  let start = 0;
  if (ascii(head, 0, 3) === "ID3") {
    start = syncsafe(head, 6) + 10 + (head[5]! & 0x10 ? 10 : 0);
    const tagBytes = start <= head.byteLength ? head : await get(0, Math.min(start, 8 * 1024 * 1024));
    tags = parseId3v2(tagBytes.subarray(0, Math.min(start, tagBytes.byteLength)));
  }
  const frames = start === 0 ? head : await get(start, 64 * 1024);
  const tail = await get(Math.max(0, size - 128), 128);
  const v1 = ascii(tail, 0, 3) === "TAG" ? 128 : 0;
  if (v1 && !Object.keys(tags).length) tags = parseId3v1(tail);
  const r = parseMp3Frames(frames, 0, size - start - v1, tags);
  return r && { ...r, bytesRead };
}

// ---------------------------------------------------------------- MP3

const BITRATES: Record<string, number[]> = {
  // [version][layer] kbps by index
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

interface Mp3Frame {
  version: 1 | 2 | 25;
  layer: 1 | 2 | 3;
  bitrate: number;
  rate: number;
  channels: number;
  length: number;
  samples: number;
}

function mp3Header(b: Uint8Array, i: number): Mp3Frame | null {
  if (i + 4 > b.byteLength || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const v = (b[i + 1]! >> 3) & 3;
  const l = (b[i + 1]! >> 1) & 3;
  const br = (b[i + 2]! >> 4) & 15;
  const sr = (b[i + 2]! >> 2) & 3;
  if (v === 1 || l === 0 || br === 0 || br === 15 || sr === 3) return null;
  const version = v === 3 ? 1 : v === 2 ? 2 : 25;
  const layer = (4 - l) as 1 | 2 | 3;
  const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`]![br]! * 1000;
  const rate = RATES[version]![sr]!;
  const pad = (b[i + 2]! >> 1) & 1;
  const channels = ((b[i + 3]! >> 6) & 3) === 3 ? 1 : 2;
  const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / rate) + pad) * 4 : Math.floor(((samples / 8) * bitrate) / rate) + pad;
  return { version, layer, bitrate, rate, channels, length, samples };
}

/** First real frame (two consecutive valid headers), then Xing/Info or VBRI frame counts, else constant bitrate. */
function parseMp3Frames(b: Uint8Array, from: number, audioBytes: number, tags: AudioTags): Omit<AudioProbe, "bytesRead"> | null {
  // Frames start at once (after any tag); a short run of junk is tolerated, but three
  // headers in a row must agree, so a video file's stray 0xFFEx bytes don't pass.
  for (let i = from; i + 4 < b.byteLength && i < from + 4096; i++) {
    const f = mp3Header(b, i);
    if (!f || f.length < 21) continue;
    const n1 = mp3Header(b, i + f.length);
    const n2 = n1 && mp3Header(b, i + f.length + n1.length);
    if (!n1 || !n2 || n1.rate !== f.rate || n2.rate !== f.rate || n1.layer !== f.layer) continue;
    const side = f.version === 1 ? (f.channels === 1 ? 17 : 32) : f.channels === 1 ? 9 : 17;
    const x = i + 4 + side;
    let frames: number | null = null;
    const xing = ascii(b, x, 4);
    if ((xing === "Xing" || xing === "Info") && b[x + 7]! & 1) frames = u32be(b, x + 8);
    else if (ascii(b, i + 36, 4) === "VBRI") frames = u32be(b, i + 36 + 14);
    const durationMs = frames ? Math.round(((frames * f.samples) / f.rate) * 1000) : Math.round(((audioBytes - (i - from)) * 8 * 1000) / f.bitrate);
    return { codec: "mp3", channels: f.channels, durationMs: durationMs > 0 ? durationMs : null, tags };
  }
  return null;
}

function parseId3v2(b: Uint8Array): AudioTags {
  const major = b[3]!;
  const out: AudioTags = {};
  let i = 10;
  if (b[5]! & 0x40) i += major === 4 ? syncsafe(b, 10) : u32be(b, 10) + 4; // extended header
  const idLen = major === 2 ? 3 : 4;
  while (i + idLen * 2 < b.byteLength) {
    const id = ascii(b, i, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const size = major === 2 ? (b[i + 3]! << 16) | (b[i + 4]! << 8) | b[i + 5]! : major === 4 ? syncsafe(b, i + 4) : u32be(b, i + 4);
    const start = i + (major === 2 ? 6 : 10);
    if (size <= 0 || start + size > b.byteLength) break;
    const text = () => id3Text(b.subarray(start, start + size));
    switch (id) {
      case "TIT2": case "TT2": out.title = text(); break;
      case "TPE1": case "TP1": out.artist = text(); break;
      case "TALB": case "TAL": out.album = text(); break;
      case "TRCK": case "TRK": out.track = int(text()); break;
      case "TYER": case "TDRC": case "TYE": out.year = int(text().slice(0, 4)); break;
      case "TCON": case "TCO": out.genre = text().replace(/^\((\d+)\)$/, "").replace(/^\(\d+\)/, "") || undefined; break;
    }
    i = start + size;
  }
  return clean(out);
}

function id3Text(b: Uint8Array): string {
  const enc = b[0];
  const body = b.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    let le = enc === 1;
    let at = 0;
    if (body[0] === 0xff && body[1] === 0xfe) (le = true), (at = 2);
    else if (body[0] === 0xfe && body[1] === 0xff) (le = false), (at = 2);
    s = "";
    for (let i = at; i + 1 < body.byteLength; i += 2) {
      const c = le ? body[i]! | (body[i + 1]! << 8) : (body[i]! << 8) | body[i + 1]!;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
  } else s = new TextDecoder(enc === 3 ? "utf-8" : "latin1").decode(body).split("\0")[0]!;
  return s.trim();
}

function parseId3v1(b: Uint8Array): AudioTags {
  const t = (a: number, n: number) => new TextDecoder("latin1").decode(b.subarray(a, a + n)).replace(/\0.*$/s, "").trim();
  const track = b[125] === 0 && b[126] ? b[126] : undefined;
  return clean({ title: t(3, 30), artist: t(33, 30), album: t(63, 30), year: int(t(93, 4)), track });
}

// ---------------------------------------------------------------- FLAC / Vorbis comments

function parseFlac(b: Uint8Array): Omit<AudioProbe, "bytesRead"> | null {
  let i = 4;
  let durationMs: number | null = null;
  let channels: number | undefined;
  let tags: AudioTags = {};
  for (let guard = 0; guard < 64 && i + 4 <= b.byteLength; guard++) {
    const last = b[i]! & 0x80;
    const type = b[i]! & 0x7f;
    const len = (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!;
    const body = b.subarray(i + 4, i + 4 + len);
    if (type === 0 && body.byteLength >= 18) {
      const rate = (body[10]! << 12) | (body[11]! << 4) | (body[12]! >> 4);
      channels = ((body[12]! >> 1) & 7) + 1;
      const total = (body[13]! & 0x0f) * 2 ** 32 + u32be(body, 14);
      durationMs = rate && total ? Math.round((total / rate) * 1000) : null;
    } else if (type === 4 && body.byteLength === len) tags = vorbisComments(body, 0);
    if (last) break;
    i += 4 + len;
  }
  return { codec: "flac", durationMs, channels, tags };
}

function vorbisComments(b: Uint8Array, at: number): AudioTags {
  const out: AudioTags = {};
  let i = at;
  const vendor = u32le(b, i);
  i += 4 + vendor;
  const n = u32le(b, i);
  i += 4;
  const dec = new TextDecoder("utf-8");
  for (let k = 0; k < n && k < 500 && i + 4 <= b.byteLength; k++) {
    const len = u32le(b, i);
    if (i + 4 + len > b.byteLength) break;
    const s = dec.decode(b.subarray(i + 4, i + 4 + len));
    i += 4 + len;
    const eq = s.indexOf("=");
    const key = s.slice(0, eq).toUpperCase();
    const v = s.slice(eq + 1).trim();
    if (key === "TITLE") out.title ??= v;
    else if (key === "ARTIST") out.artist ??= v;
    else if (key === "ALBUM") out.album ??= v;
    else if (key === "TRACKNUMBER") out.track ??= int(v);
    else if (key === "DATE" || key === "YEAR") out.year ??= int(v.slice(0, 4));
    else if (key === "GENRE") out.genre ??= v;
  }
  return clean(out);
}

// ---------------------------------------------------------------- Ogg

function parseOggHead(b: Uint8Array): { codec: "vorbis" | "opus"; rate: number; channels: number; preSkip?: number; tags: AudioTags } | null {
  const packets = oggPackets(b, 3);
  const id = packets[0];
  if (!id) return null;
  if (ascii(id, 0, 8) === "OpusHead") {
    const tags = packets[1] && ascii(packets[1], 0, 8) === "OpusTags" ? vorbisComments(packets[1], 8) : {};
    return { codec: "opus", rate: 48_000, channels: id[9]!, preSkip: id[10]! | (id[11]! << 8), tags };
  }
  if (id[0] === 1 && ascii(id, 1, 6) === "vorbis") {
    const tags = packets[1] && packets[1][0] === 3 && ascii(packets[1], 1, 6) === "vorbis" ? vorbisComments(packets[1], 7) : {};
    return { codec: "vorbis", rate: u32le(id, 12), channels: id[11]!, tags };
  }
  return null;
}

/** The first few packets of an Ogg stream (enough for codec headers), joined across pages. */
function oggPackets(b: Uint8Array, want: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cur: Uint8Array[] = [];
  let i = 0;
  while (i + 27 <= b.byteLength && out.length < want) {
    if (ascii(b, i, 4) !== "OggS") break;
    const nseg = b[i + 26]!;
    const segs = b.subarray(i + 27, i + 27 + nseg);
    let p = i + 27 + nseg;
    for (const len of segs) {
      cur.push(b.subarray(p, p + len));
      p += len;
      if (len < 255) {
        out.push(concat(...cur));
        cur = [];
      }
    }
    i = p;
  }
  return out;
}

function lastGranule(b: Uint8Array): number | null {
  for (let i = b.byteLength - 27; i >= 0; i--)
    if (b[i] === 0x4f && ascii(b, i, 4) === "OggS") {
      const lo = u32le(b, i + 6);
      const hi = u32le(b, i + 10);
      if (hi === 0xffffffff) continue;
      return hi * 2 ** 32 + lo;
    }
  return null;
}

// ---------------------------------------------------------------- WAV

function parseWav(b: Uint8Array): Omit<AudioProbe, "bytesRead"> | null {
  let i = 12;
  let byteRate = 0;
  let channels: number | undefined;
  while (i + 8 <= b.byteLength) {
    const id = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    if (id === "fmt ") {
      channels = b[i + 10]! | (b[i + 11]! << 8);
      byteRate = u32le(b, i + 16);
    } else if (id === "data") return { codec: "pcm", channels, durationMs: byteRate ? Math.round((len / byteRate) * 1000) : null, tags: {} };
    i += 8 + len + (len & 1);
  }
  return null;
}

// ---------------------------------------------------------------- names

/**
 * What a file's place says when it has no tags: "Artist/Album/01 - Title.mp3",
 * "Artist - Title.mp3". Tags from the file win over this.
 */
export function tagsFromPath(rel: string): AudioTags {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  const file = segs[segs.length - 1] ?? "";
  const stem = file.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const m = /^(?:(?:disc|cd)\s*\d+\s*[-.]\s*)?(\d{1,3})\s*[-.)]?\s+(.*)$/i.exec(stem);
  const track = m ? Number(m[1]) : undefined;
  let title = (m ? m[2]! : stem).trim();
  let artist: string | undefined;
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(title);
  if (dash) (artist = dash[1]), (title = dash[2]!);
  const album = segs.length >= 2 ? segs[segs.length - 2] : undefined;
  artist ??= segs.length >= 3 ? segs[segs.length - 3] : undefined;
  return clean({ title, artist, album: album && !/^(?:music|songs|audio|mp3|flac)$/i.test(album) ? album.replace(/\s*[([]\d{4}[)\]]\s*$/, "") : undefined, track });
}

// ---------------------------------------------------------------- bytes

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n && i < b.byteLength; i++) s += String.fromCharCode(b[i]!);
  return s;
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
}
function u32le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + ((b[i + 3]! << 24) >>> 0);
}
function syncsafe(b: Uint8Array, i: number): number {
  return ((b[i]! & 0x7f) << 21) | ((b[i + 1]! & 0x7f) << 14) | ((b[i + 2]! & 0x7f) << 7) | (b[i + 3]! & 0x7f);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.byteLength);
  return out;
}
function int(s: string | undefined): number | undefined {
  const n = parseInt(s ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function clean(t: AudioTags): AudioTags {
  const out: AudioTags = {};
  for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== "" && !(typeof v === "number" && !Number.isFinite(v))) (out as Record<string, unknown>)[k] = typeof v === "string" ? v.slice(0, 200) : v;
  return out;
}
