// Just enough of BitTorrent to name what the viewer is adding: the info hash and
// name of a magnet link or a .torrent file, and the files a .torrent lists. The
// file itself is always sent to the provider as it is, never rebuilt.

import { createHash } from "node:crypto";

export interface TorrentFacts {
  infoHash: string | null;
  name: string | null;
  files: Array<{ path: string; bytes: number }>;
}

/** 32-character base32 btih (some magnets use it) to 40-character hex. */
export function base32ToHex(s: string): string | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}

export function isMagnet(s: string): boolean {
  return /^magnet:\?/i.test(s.trim());
}

export function parseMagnet(magnet: string): TorrentFacts {
  const q = new URLSearchParams(magnet.trim().replace(/^magnet:\?/i, ""));
  let infoHash: string | null = null;
  for (const xt of q.getAll("xt")) {
    const m = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (!m) continue;
    infoHash = m[1]!.length === 40 && /^[0-9a-f]+$/i.test(m[1]!) ? m[1]!.toLowerCase() : m[1]!.length === 32 ? base32ToHex(m[1]!) : null;
    if (infoHash) break;
  }
  return { infoHash, name: q.get("dn"), files: [] };
}

/** A bare 40-hex info hash typed on its own becomes a magnet. */
export function hashToMagnet(text: string): string | null {
  const t = text.trim();
  if (/^[0-9a-f]{40}$/i.test(t)) return `magnet:?xt=urn:btih:${t.toLowerCase()}`;
  const h = /^[a-z2-7]{32}$/i.test(t) ? base32ToHex(t) : null;
  return h ? `magnet:?xt=urn:btih:${h}` : null;
}

// Minimal bencode reader: remembers where the "info" dictionary starts and ends,
// because the info hash is the SHA-1 of exactly those bytes.
type B = number | Uint8Array | B[] | Map<string, B>;

export function parseTorrent(bytes: Uint8Array): TorrentFacts {
  let pos = 0;
  let infoSpan: [number, number] | null = null;
  const dec = new TextDecoder();
  const readInt = (end: number) => {
    const n = Number(dec.decode(bytes.subarray(pos, end)));
    if (!Number.isFinite(n)) throw new Error("not a .torrent file");
    return n;
  };
  const next = (depth: number): B => {
    if (depth > 64 || pos >= bytes.length) throw new Error("not a .torrent file");
    const c = bytes[pos]!;
    if (c === 0x69 /* i */) {
      const end = bytes.indexOf(0x65, pos);
      pos++;
      const n = readInt(end);
      pos = end + 1;
      return n;
    }
    if (c === 0x6c /* l */) {
      pos++;
      const out: B[] = [];
      while (bytes[pos] !== 0x65) out.push(next(depth + 1));
      pos++;
      return out;
    }
    if (c === 0x64 /* d */) {
      pos++;
      const out = new Map<string, B>();
      while (bytes[pos] !== 0x65) {
        const k = dec.decode(next(depth + 1) as Uint8Array);
        const start = pos;
        out.set(k, next(depth + 1));
        if (depth === 0 && k === "info") infoSpan = [start, pos];
      }
      pos++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = bytes.indexOf(0x3a, pos);
      const len = readInt(colon);
      const start = colon + 1;
      pos = start + len;
      if (pos > bytes.length) throw new Error("not a .torrent file");
      return bytes.subarray(start, pos);
    }
    throw new Error("not a .torrent file");
  };
  const root = next(0);
  if (!(root instanceof Map)) throw new Error("not a .torrent file");
  const info = root.get("info");
  if (!(info instanceof Map) || !infoSpan) throw new Error("not a .torrent file");
  const [a, b] = infoSpan as [number, number];
  const text = (v: B | undefined) => (v instanceof Uint8Array ? dec.decode(v) : null);
  const name = text(info.get("name.utf-8")) ?? text(info.get("name"));
  const files: TorrentFacts["files"] = [];
  const list = info.get("files");
  if (Array.isArray(list)) {
    for (const f of list) {
      if (!(f instanceof Map)) continue;
      const parts = (f.get("path.utf-8") ?? f.get("path")) as B[] | undefined;
      files.push({ path: [name ?? "", ...(Array.isArray(parts) ? parts.map((p) => text(p) ?? "") : [])].filter(Boolean).join("/"), bytes: Number(f.get("length") ?? 0) });
    }
  } else if (typeof info.get("length") === "number") files.push({ path: name ?? "", bytes: info.get("length") as number });
  return { infoHash: createHash("sha1").update(bytes.subarray(a, b)).digest("hex"), name, files };
}
