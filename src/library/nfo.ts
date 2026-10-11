// Kodi-style .nfo metadata, read from the viewer's own folders (parity N-01c).
//
// Only local files are read: an .nfo inside a Real-Debrid or TorBox torrent would
// cost API calls and bytes to fetch, and online lookups (TMDB/OMDb) would be new
// outbound traffic, which needs the account holder's yes first. Nothing here
// touches the network.
//
// Supported shapes (https://kodi.wiki/view/NFO_files):
//   <movie>           title, year, mpaa, genre*, set (collection), studio*, tag*, plot
//   <episodedetails>  title (episode title), season, episode, mpaa, plot
//   <tvshow>          title, mpaa, genre*, studio*, tag*, plot
// An .nfo that only holds a URL (the "scraper hint" form) has no fields and is ignored.
// `<rating>`/`<ratings>` are review scores, not age ratings, and are not read.

import { normalizeRating, type Rating } from "../clock/ratings.ts";

export interface NfoMeta {
  kind: "movie" | "episode" | "show";
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  /** Age rating on the film scale, when the file states one we can read. */
  rating?: Rating;
  /** The rating exactly as written, for display. */
  ratingText?: string;
  genres?: string[];
  /** Movie collection ("set"), e.g. a franchise. */
  collection?: string;
  studios?: string[];
  tags?: string[];
  plot?: string;
  /** An episode's show summary, from tvshow.nfo (On Demand's show page). */
  showPlot?: string;
  /** Database ids the file states (<uniqueid>, or the older <id>/<imdbid>/<tmdbid>), for dedupe (N-01d). */
  ids?: ExternalIds;
  /** An episode's show ids, from tvshow.nfo. */
  showIds?: ExternalIds;
}

/** TMDB / IMDb / TVDB ids. A film's or show's ids; for an episode, the episode's own. */
export interface ExternalIds {
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
}

const ROOTS: Record<string, NfoMeta["kind"]> = { movie: "movie", episodedetails: "episode", tvshow: "show" };

/** Parse one .nfo. Returns null for anything that isn't a Kodi movie/episode/show document. */
export function parseNfo(text: string): NfoMeta | null {
  const body = text.replace(/^﻿/, "").replace(/<!--[\s\S]*?-->/g, "");
  const root = /<(movie|episodedetails|tvshow)[\s>]/i.exec(body);
  if (!root) return null;
  const kind = ROOTS[root[1]!.toLowerCase()]!;
  // Multi-episode files hold several <episodedetails>; the first one describes the file.
  const end = body.search(new RegExp(`</${root[1]}>`, "i"));
  const doc = body.slice(root.index, end > 0 ? end : undefined);
  // Fields of nested blocks (actors, file info, ratings) must not be mistaken for the document's own.
  const own = doc.replace(/<(actor|fileinfo|ratings|uniqueid|thumb|fanart|resume|art|namedseason)\b[\s\S]*?<\/\1>/gi, "");

  const all = (tag: string) => [...own.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi"))].map((m) => clean(m[1]!)).filter(Boolean);
  const one = (tag: string) => all(tag)[0];
  const int = (tag: string) => {
    const n = Number(one(tag));
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  const out: NfoMeta = { kind };
  const title = one("title");
  if (title) out.title = title.slice(0, 200);
  const year = int("year") ?? Number(/^(\d{4})-/.exec(one("premiered") ?? one("aired") ?? "")?.[1]);
  if (year && year > 1880 && year < 2100) out.year = year;
  if (kind === "episode") {
    const s = int("season");
    const e = int("episode");
    if (s != null) out.season = s;
    if (e != null) out.episode = e;
  }
  const mpaa = one("mpaa") ?? one("certification");
  if (mpaa) {
    out.ratingText = mpaa.slice(0, 40);
    const r = normalizeRating(mpaa);
    if (r) out.rating = r;
  }
  const genres = splitList(all("genre"));
  if (genres.length) out.genres = genres;
  // <set> is either plain text or <set><name>…</name><overview>…</overview></set>.
  const setRaw = /<set(?:\s[^>]*)?>([\s\S]*?)<\/set>/i.exec(own)?.[1];
  if (setRaw) {
    const name = clean(/<name>([\s\S]*?)<\/name>/i.exec(setRaw)?.[1] ?? (/</.test(setRaw) ? "" : setRaw));
    if (name) out.collection = name.slice(0, 120);
  }
  const studios = splitList(all("studio"));
  if (studios.length) out.studios = studios;
  const tags = splitList(all("tag"));
  if (tags.length) out.tags = tags;
  const plot = one("plot") ?? one("outline");
  if (plot) out.plot = plot.slice(0, 1000);
  const ids = nfoIds(doc);
  if (ids) out.ids = ids;
  return out;
}

/**
 * Kodi writes <uniqueid type="tmdb|imdb|tvdb">; older scrapers wrote <id>, <imdbid>,
 * <tmdbid>. Read from the document itself, not from nested actor or episode-guide blocks.
 */
export function nfoIds(doc: string): ExternalIds | undefined {
  const own = doc.replace(/<(actor|fileinfo|ratings|thumb|fanart|resume|art|namedseason|episodeguide)\b[\s\S]*?<\/\1>/gi, "");
  const out: ExternalIds = {};
  for (const m of own.matchAll(/<uniqueid\b([^>]*)>([\s\S]*?)<\/uniqueid>/gi)) {
    const type = /type\s*=\s*["']?([a-z]+)/i.exec(m[1]!)?.[1]?.toLowerCase();
    if (type === "tmdb" || type === "imdb" || type === "tvdb") put(out, type, clean(m[2]!));
  }
  for (const [tag, kind] of [["tmdbid", "tmdb"], ["imdbid", "imdb"], ["imdb_id", "imdb"], ["tvdbid", "tvdb"]] as const) {
    const v = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(own)?.[1];
    if (v) put(out, kind, clean(v));
  }
  // A bare <id> is IMDb's when it looks like one, else the scraper's (TVDB for shows, TMDB for films): too vague to use.
  const bare = /<id>([\s\S]*?)<\/id>/i.exec(own)?.[1];
  if (bare && /^tt\d{5,10}$/.test(clean(bare))) put(out, "imdb", clean(bare));
  return Object.keys(out).length ? out : undefined;
}

function put(out: ExternalIds, kind: keyof ExternalIds, v: string): void {
  if (out[kind]) return;
  if (kind === "imdb" ? /^tt\d{5,10}$/.test(v) : /^\d{1,10}$/.test(v)) out[kind] = v;
}

/** Fill gaps in an episode's metadata from its show's tvshow.nfo. */
export function withShow(ep: NfoMeta | null, show: NfoMeta | null): NfoMeta | null {
  if (!show) return ep;
  const showPlot = { ...(show.plot ? { showPlot: show.plot } : {}), ...(show.ids ? { showIds: show.ids } : {}) };
  if (!ep) return { kind: "episode", rating: show.rating, ratingText: show.ratingText, genres: show.genres, studios: show.studios, tags: show.tags, ...showPlot };
  return {
    ...ep,
    rating: ep.rating ?? show.rating,
    ratingText: ep.ratingText ?? show.ratingText,
    genres: ep.genres ?? show.genres,
    studios: ep.studios ?? show.studios,
    tags: ep.tags ?? show.tags,
    ...showPlot,
  };
}

/** Some exporters write one genre per tag, others "Comedy / Drama" in one. */
function splitList(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs)
    for (const part of x.split(/\s*[/|,]\s*/)) {
      const v = part.trim().slice(0, 60);
      if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  return out.slice(0, 12);
}

function clean(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      if (k === "lt") return "<";
      if (k === "gt") return ">";
      if (k === "quot") return '"';
      if (k === "apos") return "'";
      if (k === "amp") return "&";
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}
