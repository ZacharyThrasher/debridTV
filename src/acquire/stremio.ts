// Search a Stremio addon the viewer added themselves, for torrents to add.
//
// A Stremio "stream" addon answers GET {base}/stream/{movie|series}/{imdb id}.json
// with a list of streams (protocol: github.com/Stremio/stremio-addon-sdk,
// docs/protocol.md and docs/api/responses/stream.md). DebridTV reads that list
// and keeps only what names a torrent: an `infoHash`, or a play link whose path
// carries a 40-character info hash (debrid-backed addons put one there). Those
// become ordinary search results that go through the normal Add button.
//
// DebridTV never opens an addon's play links. Opening one makes the addon add
// the torrent to the account whose key is in the addon's address, unseen and
// outside the "Allow adding" switch, so nothing here ever requests one.
//
// Addon addresses usually hold the viewer's settings, often a debrid key too, in
// the path. The address is kept on the PC like an indexer key: errors never
// carry it and the browser only sees the host.

import { doFetch, type FetchOpts, type Indexer, type SearchResult } from "./search.ts";

export type StremioType = "movie" | "series";

export interface StremioTarget {
  type: StremioType;
  /** "tt" and digits. */
  imdbId: string;
  season?: number;
  episode?: number;
}

/** The address up to (not including) /manifest.json; stremio:// becomes https://. */
export function addonBase(url: string): string {
  let u = url.trim().replace(/^stremio:\/\//i, "https://");
  u = u.replace(/[?#].*$/, "").replace(/\/manifest\.json$/i, "").replace(/\/+$/, "");
  return u;
}

/** What the browser may see of an addon address: scheme and host only. */
export function addonHost(url: string): string {
  try {
    const u = new URL(addonBase(url));
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "(address hidden)";
  }
}

/** Read the addon's manifest to check it serves streams for films or shows. */
export async function addonManifest(
  ix: Indexer,
  o: FetchOpts = {},
): Promise<{ ok: true; title?: string; searchTypes: string[] } | { ok: false; error: string }> {
  try {
    const m = (await getJson(ix, "/manifest.json", o)) as {
      name?: unknown;
      types?: unknown;
      resources?: Array<string | { name?: string; types?: string[] }>;
    } | null;
    if (!m || typeof m !== "object" || !Array.isArray(m.resources))
      return { ok: false, error: "That address doesn't answer with a Stremio addon manifest." };
    const stream = m.resources.find((r) => (typeof r === "string" ? r : r?.name) === "stream");
    if (!stream) return { ok: false, error: "That addon doesn't list streams, so there's nothing in it to add." };
    const types = (typeof stream === "object" && Array.isArray(stream.types) ? stream.types : Array.isArray(m.types) ? m.types : [])
      .filter((t): t is string => t === "movie" || t === "series");
    if (!types.length) return { ok: false, error: "That addon doesn't serve films or shows." };
    return { ok: true, ...(typeof m.name === "string" && m.name ? { title: m.name.slice(0, 60) } : {}), searchTypes: types };
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message, ix.url) };
  }
}

/**
 * Ask one addon for the torrents it knows for a film or an episode. Returns the
 * results plus how many streams were left out because they name no torrent.
 */
export async function searchAddon(ix: Indexer, t: StremioTarget, o: FetchOpts = {}): Promise<{ results: SearchResult[]; skipped: number }> {
  if (!/^tt\d{5,10}$/.test(t.imdbId)) throw new Error("Needs an IMDb id (tt and digits)");
  const id = t.type === "series" ? `${t.imdbId}:${t.season ?? 1}:${t.episode ?? 1}` : t.imdbId;
  let body: unknown;
  try {
    body = await getJson(ix, `/stream/${t.type}/${id}.json`, o);
  } catch (e) {
    throw new Error(scrub((e as Error).message, ix.url));
  }
  const streams = (body as { streams?: unknown } | null)?.streams;
  if (!Array.isArray(streams)) throw new Error("The addon's answer has no stream list");
  const results: SearchResult[] = [];
  let skipped = 0;
  for (const s of streams) {
    const r = s && typeof s === "object" ? streamToResult(ix, s as StremioStream) : null;
    if (r) results.push(r);
    else skipped++;
  }
  return { results, skipped };
}

export interface StremioStream {
  name?: string;
  title?: string;
  description?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  behaviorHints?: { filename?: string; videoSize?: number; bingeGroup?: string };
}

/** One stream as a search result, or null when it names no torrent. Never keeps the play link. */
export function streamToResult(ix: Indexer, s: StremioStream): SearchResult | null {
  const hash = normHash(s.infoHash) ?? hashInLink(s.url);
  if (!hash) return null;
  const text = [s.title, s.description].filter((x): x is string => typeof x === "string").join("\n");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const filename = typeof s.behaviorHints?.filename === "string" ? s.behaviorHints.filename.trim() : "";
  // Addons put the release name on the first line and sizes, seeders and sources (with emoji) after it.
  const title = (filename || lines.find((l) => !/^[^\p{L}\p{N}]/u.test(l)) || lines[0] || hash).slice(0, 300);
  const trackers = (Array.isArray(s.sources) ? s.sources : [])
    .filter((x): x is string => typeof x === "string" && /^tracker:(udp|https?):\/\//i.test(x))
    .slice(0, 20)
    .map((x) => `&tr=${encodeURIComponent(x.slice("tracker:".length))}`)
    .join("");
  const r: SearchResult = {
    id: `${ix.id}:${hash}`,
    source: ix.name,
    sourceId: ix.id,
    kind: "torrent",
    title,
    size: num(s.behaviorHints?.videoSize) ?? sizeIn(text),
    seeders: seedersIn(text),
    peers: null,
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`,
  };
  const label = typeof s.name === "string" ? s.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  if (label) r.category = label;
  return r;
}

/**
 * The words a search box holds, read for a Stremio lookup: an IMDb id if one was
 * typed, a season and episode ("S02E05", "2x05", "season 2"), and the title left over.
 */
export function readQuery(q: string): { title: string; imdbId?: string; season?: number; episode?: number } {
  let rest = q;
  const out: { title: string; imdbId?: string; season?: number; episode?: number } = { title: "" };
  const tt = /\b(tt\d{5,10})\b/i.exec(rest);
  if (tt) {
    out.imdbId = tt[1]!.toLowerCase();
    rest = rest.replace(tt[0], " ");
  }
  const se = /\bs(\d{1,2})\s*e(\d{1,3})\b/i.exec(rest) ?? /\b(\d{1,2})x(\d{1,3})\b/i.exec(rest);
  if (se) {
    out.season = Number(se[1]);
    out.episode = Number(se[2]);
    rest = rest.replace(se[0], " ");
  } else {
    const s = /\b(?:s|season\s*)(\d{1,2})\b/i.exec(rest);
    if (s) {
      out.season = Number(s[1]);
      rest = rest.replace(s[0], " ");
    }
  }
  out.title = rest.replace(/\s+/g, " ").trim();
  return out;
}

// ---- internals ----

async function getJson(ix: Indexer, path: string, o: FetchOpts): Promise<unknown> {
  const res = await doFetch(addonBase(ix.url) + path, o, "the addon");
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(res.status === 404 ? "The addon has nothing for that" : `Addon said HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The addon's answer isn't JSON");
  }
}

/** A 40-hex segment in a play link's path (…/playback/{hash}/…, …/resolve/{svc}/{key}/{hash}/…). */
function hashInLink(url: string | undefined): string | undefined {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  for (const seg of path.split("/")) {
    const s = decodeURIComponent(seg);
    if (/^[0-9a-f]{40}$/i.test(s)) return s.toLowerCase();
  }
  return undefined;
}

function normHash(h: unknown): string | undefined {
  return typeof h === "string" && /^[0-9a-f]{40}$/i.test(h) ? h.toLowerCase() : undefined;
}

const UNITS: Record<string, number> = { kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

function sizeIn(text: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/i.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]!.replace(",", ".")) * UNITS[m[2]!.toLowerCase()]!);
}

function seedersIn(text: string): number | null {
  const m = /👤\s*(\d+)/u.exec(text) ?? /\bseed(?:er)?s?\s*[:=]?\s*(\d+)/i.exec(text);
  return m ? Number(m[1]) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Hide the addon's address (and each long path segment of it, which may be a key) in a message. */
function scrub(msg: string, url: string): string {
  let out = msg;
  const base = addonBase(url);
  out = out.split(base).join("(addon)");
  try {
    for (const seg of new URL(base).pathname.split("/")) if (seg.length >= 8) out = out.split(seg).join("***");
  } catch {}
  return out;
}
