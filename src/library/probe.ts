// Exact duration + codecs from a few header bytes (Matroska / MP4). No dependencies.

export interface ProbeResult {
  container: "matroska" | "mp4" | "unknown";
  durationMs: number | null;
  video?: string;
  audio?: string[];
  /** Every track in file order. `index` counts within its kind (ffmpeg's 0:a:N / 0:s:N). */
  tracks?: Track[];
  /** Chapter start times in file time (Matroska Chapters; MP4 Nero "chpl" or a QuickTime chapter track). */
  chaptersMs?: number[];
  bytesRead: number;
}

export interface Track {
  kind: "video" | "audio" | "subtitle";
  index: number;
  codec: string;
  /** ISO 639-2 or BCP 47 as stored in the file; "und" when the file doesn't say. */
  lang: string;
  name?: string;
  default?: boolean;
  forced?: boolean;
}
export type RangeReader = (start: number, length: number) => Promise<Uint8Array>; // may return fewer bytes

export const HEAD_BYTES = 256 * 1024;
export const MAX_PROBE_BYTES = 3 * 1024 * 1024;

type Info = { durationMs: number | null; video?: string; audio?: string[]; tracks?: Track[]; chaptersMs?: number[] };

function finish(durationMs: number | null, video: string | undefined, audio: string[], tracks: Track[] = [], chapters: number[] = []): Info {
  const out: Info = { durationMs };
  if (video !== undefined) out.video = video;
  if (audio.length > 0) out.audio = audio;
  if (tracks.length > 0) out.tracks = tracks;
  if (chapters.length > 0) out.chaptersMs = [...new Set(chapters)].sort((a, b) => a - b);
  return out;
}

function addTrack(list: Track[], kind: Track["kind"], t: Omit<Track, "kind" | "index">): void {
  const index = list.filter((x) => x.kind === kind).length;
  list.push({ kind, index, ...t });
}

// ---------------------------------------------------------------------------
// Matroska / EBML

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CLUSTER = 0x1f43b675;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_NAME = 0x536e;
const ID_FLAG_DEFAULT = 0x88;
const ID_FLAG_FORCED = 0x55aa;
const ID_CHAPTERS = 0x1043a770;
const ID_EDITION = 0x45b9;
const ID_CHAPTER_ATOM = 0xb6;
const ID_CHAPTER_START = 0x91;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;

const MKV_CODECS: [RegExp, string][] = [
  [/^V_MPEG4\/ISO\/AVC/, "h264"],
  [/^V_MPEGH\/ISO\/HEVC/, "hevc"],
  [/^V_AV1/, "av1"],
  [/^V_VP9/, "vp9"],
  [/^V_VP8/, "vp8"],
  [/^A_AAC/, "aac"],
  [/^A_EAC3/, "eac3"],
  [/^A_AC3/, "ac3"],
  [/^A_DTS/, "dts"],
  [/^A_OPUS/, "opus"],
  [/^A_TRUEHD/, "truehd"],
  [/^A_FLAC/, "flac"],
  [/^A_MPEG\/L3/, "mp3"],
  [/^S_TEXT\/UTF8/, "srt"],
  [/^S_TEXT\/(ASS|SSA)/, "ass"],
  [/^S_TEXT\/WEBVTT/, "webvtt"],
  [/^S_HDMV\/PGS/, "pgs"],
  [/^S_VOBSUB/, "vobsub"],
];

function mkvCodecName(id: string): string {
  for (const [re, name] of MKV_CODECS) if (re.test(id)) return name;
  return id;
}

/** EBML element ID (marker bits kept). Returns null on truncation/invalid. */
function readId(b: Uint8Array, pos: number): { id: number; len: number } | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  if (first === 0) return null;
  const len = Math.clz32(first) - 24 + 1;
  if (len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}

/** EBML data size; size -1 means "unknown". */
function readSize(b: Uint8Array, pos: number): { size: number; len: number } | null {
  if (pos >= b.length) return null;
  const first = b[pos];
  if (first === 0) return null;
  const len = Math.clz32(first) - 24 + 1;
  if (pos + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const byte = b[pos + i];
    if (byte !== 0xff) allOnes = false;
    v = v * 256 + byte;
  }
  return { size: allOnes ? -1 : v, len };
}

function readUint(b: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + b[i];
  return v;
}

interface MkvState {
  scale: number;
  duration: number | null;
  sawInfo: boolean;
  sawTracks: boolean;
  sawCluster: boolean;
  video?: string;
  audio: string[];
  tracks: Track[];
  chapters: number[];
  /** Where the Segment's payload starts (SeekHead positions count from here). */
  segStart?: number;
  /** Chapters' position per the SeekHead, relative to segStart. */
  chaptersAt?: number;
  seek?: { id?: number; pos?: number };
  cur?: { type?: number; codec?: string; lang?: string; bcp47?: string; name?: string; def?: boolean; forced?: boolean };
  done: boolean;
}

function mkvWalk(b: Uint8Array, start: number, end: number, st: MkvState): void {
  let pos = start;
  while (pos < end && !st.done) {
    const idr = readId(b, pos);
    if (!idr) return;
    const szr = readSize(b, pos + idr.len);
    if (!szr) return;
    const dataStart = pos + idr.len + szr.len;
    const dataEnd = szr.size < 0 ? end : dataStart + szr.size;
    const clipped = Math.min(dataEnd, end, b.length);
    switch (idr.id) {
      case ID_SEEK_HEAD:
        mkvWalk(b, dataStart, clipped, st);
        break;
      case ID_SEEK:
        st.seek = {};
        mkvWalk(b, dataStart, clipped, st);
        if (st.seek.id === ID_CHAPTERS && st.seek.pos !== undefined) st.chaptersAt ??= st.seek.pos;
        st.seek = undefined;
        break;
      case ID_SEEK_ID:
      case ID_SEEK_POSITION:
        if (st.seek && dataEnd <= b.length && szr.size > 0 && szr.size <= 8) st.seek[idr.id === ID_SEEK_ID ? "id" : "pos"] = readUint(b, dataStart, dataEnd);
        break;
      case ID_SEGMENT:
        st.segStart ??= dataStart;
        mkvWalk(b, dataStart, clipped, st);
        break;
      case ID_INFO:
      case ID_TRACKS:
      case ID_CHAPTERS:
      case ID_EDITION:
        // Keep walking past Info and Tracks to the first Cluster: Chapters usually sit between.
        mkvWalk(b, dataStart, clipped, st);
        if (idr.id === ID_INFO) st.sawInfo = true;
        if (idr.id === ID_TRACKS) st.sawTracks = true;
        break;
      case ID_CHAPTER_ATOM: {
        // Only top-level atoms of each edition; nested atoms are sub-chapters.
        const inner = { ...st, chapters: [] as number[], done: false };
        mkvWalk(b, dataStart, clipped, inner);
        if (inner.chapters.length) st.chapters.push(inner.chapters[0]!);
        break;
      }
      case ID_CHAPTER_START:
        if (dataEnd <= b.length && szr.size > 0 && szr.size <= 8) st.chapters.push(Math.round(readUint(b, dataStart, dataEnd) / 1_000_000));
        break;
      case ID_TRACK_ENTRY: {
        st.cur = {};
        mkvWalk(b, dataStart, clipped, st);
        const cur = st.cur;
        st.cur = undefined;
        if (cur.codec !== undefined) {
          const name = mkvCodecName(cur.codec);
          const kind = cur.type === 1 ? "video" : cur.type === 2 ? "audio" : cur.type === 0x11 ? "subtitle" : null;
          if (cur.type === 1) st.video ??= name;
          else if (cur.type === 2) st.audio.push(name);
          // Matroska's defaults: language "eng" when absent, FlagDefault 1, FlagForced 0.
          if (kind) addTrack(st.tracks, kind, { codec: name, lang: cur.bcp47 ?? cur.lang ?? "eng", ...(cur.name ? { name: cur.name } : {}),
            default: cur.def ?? true, forced: cur.forced ?? false });
        }
        break;
      }
      case ID_LANGUAGE:
      case ID_LANGUAGE_BCP47:
      case ID_NAME:
        if (st.cur && dataEnd <= b.length && szr.size > 0 && szr.size < 512) {
          let e = dataEnd;
          while (e > dataStart && b[e - 1] === 0) e--;
          const text = new TextDecoder(idr.id === ID_NAME ? "utf-8" : "latin1").decode(b.subarray(dataStart, e));
          if (idr.id === ID_LANGUAGE) st.cur.lang = text;
          else if (idr.id === ID_LANGUAGE_BCP47) st.cur.bcp47 = text;
          else st.cur.name = text;
        }
        break;
      case ID_FLAG_DEFAULT:
      case ID_FLAG_FORCED:
        if (st.cur && dataEnd <= b.length && szr.size > 0 && szr.size <= 8) {
          const v = readUint(b, dataStart, dataEnd) === 1;
          if (idr.id === ID_FLAG_DEFAULT) st.cur.def = v;
          else st.cur.forced = v;
        }
        break;
      case ID_CLUSTER:
        st.sawCluster = true;
        st.done = true;
        return;
      case ID_TIMECODE_SCALE:
        if (dataEnd <= b.length && szr.size > 0 && szr.size <= 8) st.scale = readUint(b, dataStart, dataEnd);
        break;
      case ID_DURATION:
        if (dataEnd <= b.length && (szr.size === 4 || szr.size === 8)) {
          const dv = new DataView(b.buffer, b.byteOffset + dataStart, szr.size);
          st.duration = szr.size === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
        }
        break;
      case ID_TRACK_TYPE:
        if (st.cur && dataEnd <= b.length && szr.size > 0 && szr.size <= 8) st.cur.type = readUint(b, dataStart, dataEnd);
        break;
      case ID_CODEC_ID:
        if (st.cur && dataEnd <= b.length && szr.size > 0) {
          let e = dataEnd;
          while (e > dataStart && b[e - 1] === 0) e--;
          st.cur.codec = new TextDecoder("latin1").decode(b.subarray(dataStart, e));
        }
        break;
      default:
        break;
    }
    if (szr.size < 0) return; // unknown-size non-container: cannot skip
    pos = dataEnd;
  }
}

function mkvParse(head: Uint8Array): Info & { sawCluster: boolean; lateChaptersAt?: number } {
  const st: MkvState = { scale: 1_000_000, duration: null, sawInfo: false, sawTracks: false, sawCluster: false, audio: [], tracks: [], chapters: [], done: false };
  try {
    mkvWalk(head, 0, head.length, st);
  } catch {
    /* truncated or corrupt: return whatever was gathered */
  }
  let ms: number | null = null;
  if (st.duration !== null && Number.isFinite(st.duration) && st.duration >= 0) {
    ms = Math.round((st.duration * st.scale) / 1_000_000);
  }
  // Without a Cluster in the buffer, Info and Tracks are still enough to stop reading.
  // Chapters that sit after the media (written last by some muxers) are found through the SeekHead.
  const late = st.chapters.length === 0 && st.segStart !== undefined && st.chaptersAt !== undefined ? st.segStart + st.chaptersAt : undefined;
  return { ...finish(ms, st.video, st.audio, st.tracks, st.chapters), sawCluster: st.sawCluster || (st.sawInfo && st.sawTracks),
    ...(late !== undefined && late >= head.length ? { lateChaptersAt: late } : {}) };
}

/** Chapter starts from a lone Chapters element. */
function mkvChapters(b: Uint8Array): number[] {
  const st: MkvState = { scale: 1_000_000, duration: null, sawInfo: false, sawTracks: false, sawCluster: false, audio: [], tracks: [], chapters: [], done: false };
  try {
    mkvWalk(b, 0, b.length, st);
  } catch {
    /* tolerate */
  }
  return [...new Set(st.chapters)].sort((a, c) => a - c);
}

export function parseMatroska(head: Uint8Array): { durationMs: number | null; video?: string; audio?: string[] } {
  const { sawCluster: _s, ...info } = mkvParse(head);
  return info;
}

// ---------------------------------------------------------------------------
// MP4 / ISO BMFF

const fourcc = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u32 = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u64 = (b: Uint8Array, p: number): number => u32(b, p) * 4294967296 + u32(b, p + 4);

interface Box {
  type: string;
  at: number; // index in buffer
  size: number; // total incl. header; Infinity when "to end of file"
  header: number;
}

function boxAt(b: Uint8Array, p: number): Box | null {
  if (p + 8 > b.length) return null;
  let size = u32(b, p);
  const type = fourcc(b, p + 4);
  let header = 8;
  if (size === 1) {
    if (p + 16 > b.length) return null;
    size = u64(b, p + 8);
    header = 16;
  } else if (size === 0) {
    size = Infinity;
  }
  if (size < header) return null;
  return { type, at: p, size, header };
}

function* children(b: Uint8Array, start: number, end: number): Generator<Box> {
  let p = start;
  while (p < end) {
    const box = boxAt(b, p);
    if (!box) return;
    yield box;
    if (box.size === Infinity) return;
    p += box.size;
  }
}

const MP4_CODECS: Record<string, string> = {
  avc1: "h264", avc3: "h264", hvc1: "hevc", hev1: "hevc", av01: "av1", vp09: "vp9",
  mp4a: "aac", "ac-3": "ac3", "ec-3": "eac3", Opus: "opus", fLaC: "flac", ".mp3": "mp3",
  tx3g: "mov_text", wvtt: "webvtt", stpp: "ttml",
};

interface Mp4State {
  timescale: number;
  duration: number | null; // movie timescale units
  fragDuration: number | null;
  video?: string;
  audio: string[];
  tracks: Track[];
  traks: Trak[];
  /** Nero chapter list (moov/udta/chpl), in ms. */
  chpl: number[];
}

interface Trak {
  id: number;
  handler: string;
  codec: string;
  lang: string;
  timescale: number;
  /** Sample time-to-sample table: [sample count, sample duration] runs. */
  stts: Array<[number, number]>;
  /** Track ids this track names as its chapter track (tref/chap). */
  chap: number[];
}

function parseTrak(b: Uint8Array, box: Box, end: number, st: Mp4State): void {
  const trakEnd = Math.min(end, box.at + box.size);
  let handler = "";
  let codec = "";
  let lang = "und";
  let id = 0;
  let timescale = 0;
  const stts: Array<[number, number]> = [];
  const chap: number[] = [];
  const walk = (start: number, stop: number, path: string[]): void => {
    for (const c of children(b, start, stop)) {
      const cend = Math.min(stop, c.at + c.size);
      const bodyStart = c.at + c.header;
      if (c.type === "mdia" || c.type === "minf" || c.type === "stbl" || c.type === "tref") {
        walk(bodyStart, cend, [...path, c.type]);
      } else if (c.type === "tkhd" && bodyStart + 24 <= cend) {
        id = u32(b, bodyStart + (b[bodyStart] === 1 ? 20 : 12));
      } else if (c.type === "chap" && path[path.length - 1] === "tref") {
        for (let p = bodyStart; p + 4 <= cend; p += 4) chap.push(u32(b, p));
      } else if (c.type === "stts" && bodyStart + 8 <= cend) {
        const n = Math.min(u32(b, bodyStart + 4), 10_000);
        for (let i = 0, p = bodyStart + 8; i < n && p + 8 <= cend; i++, p += 8) stts.push([u32(b, p), u32(b, p + 4)]);
      } else if (c.type === "mdhd" && bodyStart + 24 <= cend) {
        timescale = u32(b, bodyStart + (b[bodyStart] === 1 ? 20 : 12));
        // Packed ISO 639-2: three 5-bit letters after the times (version 0: +20, version 1: +32).
        const at = bodyStart + (b[bodyStart] === 1 ? 32 : 20);
        if (at + 2 <= cend) {
          const v = (b[at]! << 8) | b[at + 1]!;
          const l = String.fromCharCode(((v >> 10) & 31) + 96, ((v >> 5) & 31) + 96, (v & 31) + 96);
          if (/^[a-z]{3}$/.test(l)) lang = l;
        }
      } else if (c.type === "hdlr" && bodyStart + 12 <= cend) {
        handler = fourcc(b, bodyStart + 8);
      } else if (c.type === "stsd" && bodyStart + 16 <= cend && u32(b, bodyStart + 4) > 0) {
        const f = fourcc(b, bodyStart + 12);
        codec = MP4_CODECS[f] ?? f;
      }
    }
  };
  walk(box.at + box.header, trakEnd, []);
  st.traks.push({ id, handler, codec, lang, timescale, stts, chap });
}

/** Tracks become the track list; a track another one names as its chapters becomes chapter times instead. */
function finishTraks(st: Mp4State): number[] {
  const chapterIds = new Set(st.traks.flatMap((t) => t.chap));
  for (const t of st.traks) {
    if (t.codec === "" || chapterIds.has(t.id)) continue;
    if (t.handler === "vide") st.video ??= t.codec;
    else if (t.handler === "soun") st.audio.push(t.codec);
    const kind = t.handler === "vide" ? "video" : t.handler === "soun" ? "audio" : ["sbtl", "subt", "text"].includes(t.handler) ? "subtitle" : null;
    if (kind) addTrack(st.tracks, kind, { codec: t.codec, lang: t.lang });
  }
  if (st.chpl.length) return st.chpl;
  const ct = st.traks.find((t) => chapterIds.has(t.id) && t.timescale > 0);
  if (!ct) return [];
  // Each sample is one chapter; its start is the sum of the durations before it.
  const out: number[] = [];
  let at = 0;
  for (const [count, delta] of ct.stts)
    for (let i = 0; i < count && out.length < 500; i++) {
      out.push(Math.round((at * 1000) / ct.timescale));
      at += delta;
    }
  return out;
}

/** Nero chapters: version, flags, [4 reserved if v1], count, then (start in 100 ns, title length, title)… */
function parseChpl(b: Uint8Array, body: number, end: number): number[] {
  let p = body + 4 + (b[body] === 1 ? 4 : 0);
  if (p >= end) return [];
  const n = b[p++]!;
  const out: number[] = [];
  for (let i = 0; i < n && p + 9 <= end; i++) {
    out.push(Math.round(u64(b, p) / 10_000));
    p += 9 + b[p + 8]!;
  }
  return out;
}

function parseMoov(b: Uint8Array, box: Box, st: Mp4State): void {
  const end = Math.min(b.length, box.at + box.size);
  for (const c of children(b, box.at + box.header, end)) {
    const body = c.at + c.header;
    const cend = Math.min(end, c.at + c.size);
    if (c.type === "mvhd" && body + 4 <= cend) {
      const v = b[body];
      if (v === 1 && body + 32 <= cend) {
        st.timescale = u32(b, body + 20);
        st.duration = u64(b, body + 24);
      } else if (v === 0 && body + 20 <= cend) {
        st.timescale = u32(b, body + 12);
        const d = u32(b, body + 16);
        st.duration = d === 0xffffffff ? null : d;
      }
    } else if (c.type === "mvex") {
      for (const m of children(b, c.at + c.header, cend)) {
        const mb = m.at + m.header;
        if (m.type === "mehd" && mb + 4 <= cend) {
          if (b[mb] === 1 && mb + 12 <= cend) st.fragDuration = u64(b, mb + 4);
          else if (mb + 8 <= cend) st.fragDuration = u32(b, mb + 4);
        }
      }
    } else if (c.type === "trak") {
      parseTrak(b, c, cend, st);
    } else if (c.type === "udta") {
      for (const u of children(b, c.at + c.header, cend)) if (u.type === "chpl") st.chpl = parseChpl(b, u.at + u.header, Math.min(cend, u.at + u.size));
    }
  }
}

function mp4Info(st: Mp4State): Info {
  const chapters = finishTraks(st);
  let units = st.duration;
  if ((units === null || units === 0) && st.fragDuration) units = st.fragDuration;
  const ms = units !== null && st.timescale > 0 && (units > 0 || st.duration === 0) ? Math.round((units * 1000) / st.timescale) : null;
  return finish(ms, st.video, st.audio, st.tracks, chapters);
}

/** `boxes` starts at a top-level box boundary located at `fileOffset` in the file. */
export function parseMp4(boxes: Uint8Array, fileOffset: number): Info & { moovAt?: number } {
  const st: Mp4State = { timescale: 0, duration: null, fragDuration: null, audio: [], tracks: [], traks: [], chpl: [] };
  let moovAt: number | undefined;
  try {
    for (const box of children(boxes, 0, boxes.length)) {
      if (box.type === "moov") {
        moovAt = fileOffset + box.at;
        parseMoov(boxes, box, st);
        break;
      }
    }
  } catch {
    /* tolerate corrupt input */
  }
  const out: Info & { moovAt?: number } = mp4Info(st);
  if (moovAt !== undefined) out.moovAt = moovAt;
  return out;
}

// ---------------------------------------------------------------------------
// Driver

export async function probe(read: RangeReader, fileSize: number): Promise<ProbeResult> {
  let bytesRead = 0;
  const get = async (start: number, length: number): Promise<Uint8Array> => {
    const len = Math.min(length, MAX_PROBE_BYTES - bytesRead, fileSize - start);
    if (len <= 0 || start < 0) return new Uint8Array(0);
    const got = await read(start, len);
    const out = got.length > len ? got.subarray(0, len) : got;
    bytesRead += out.length;
    return out;
  };

  const head = await get(0, HEAD_BYTES);
  const unknown = (): ProbeResult => ({ container: "unknown", durationMs: null, bytesRead });

  if (head.length >= 4 && u32(head, 0) === 0x1a45dfa3) {
    let data = head;
    let r = mkvParse(data);
    if (r.durationMs === null && !r.sawCluster && head.length === HEAD_BYTES && fileSize > head.length) {
      const more = await get(head.length, MAX_PROBE_BYTES - bytesRead);
      if (more.length > 0) {
        const joined = new Uint8Array(head.length + more.length);
        joined.set(head, 0);
        joined.set(more, head.length);
        data = joined;
        r = mkvParse(data);
      }
    }
    const { sawCluster: _s, lateChaptersAt, ...info } = r;
    if (lateChaptersAt !== undefined && lateChaptersAt + 12 <= fileSize) {
      // One small read for the element header, one for the chapters themselves (budget permitting).
      const hdr = await get(lateChaptersAt, 12);
      const idr = readId(hdr, 0);
      const szr = idr ? readSize(hdr, idr.len) : null;
      if (idr?.id === ID_CHAPTERS && szr && szr.size > 0 && szr.size <= 256 * 1024) {
        const el = await get(lateChaptersAt, idr.len + szr.len + szr.size);
        const ch = mkvChapters(el);
        if (ch.length) info.chaptersMs = ch;
      }
    }
    return { container: "matroska", ...info, bytesRead };
  }

  if (head.length >= 8 && (fourcc(head, 4) === "ftyp" || ["moov", "mdat", "free", "skip", "wide"].includes(fourcc(head, 4)))) {
    // locate moov: walk top-level headers, reading only 16 bytes per hop beyond the head
    let moov: { at: number; size: number } | null = null;
    let pos = 0;
    let buf = head;
    let bufAt = 0;
    for (let hops = 0; hops < 256 && pos < fileSize; hops++) {
      if (pos < bufAt || pos + 16 > bufAt + buf.length) {
        buf = await get(pos, 16);
        bufAt = pos;
      }
      const box = boxAt(buf, pos - bufAt);
      if (!box) break;
      if (box.type === "moov") {
        moov = { at: pos, size: box.size === Infinity ? fileSize - pos : box.size };
        break;
      }
      if (box.size === Infinity) break;
      pos += box.size;
    }
    if (!moov) return { container: "mp4", durationMs: null, bytesRead };
    let data: Uint8Array;
    let dataAt: number;
    if (moov.at + moov.size <= bufAt + buf.length && moov.at >= bufAt && buf === head) {
      data = head;
      dataAt = 0;
    } else {
      // mvhd sits at the front of moov, so a partial read still yields the duration
      data = await get(moov.at, moov.size);
      dataAt = moov.at;
    }
    const start = moov.at - dataAt;
    const r = parseMp4(data.subarray(start), moov.at);
    const { moovAt: _m, ...info } = r;
    return { container: "mp4", ...info, bytesRead };
  }

  return unknown();
}
