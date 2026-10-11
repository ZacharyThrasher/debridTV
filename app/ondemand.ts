// On Demand and Continue Watching (parity N-30): pick a program outside the live
// lineup. Everything here is worked out from local facts (library, history), so
// browsing costs 0 provider calls and 0 bytes; media is read only once the viewer
// presses play, through the usual /media routes.

import { dedupe, sortEpisodes, type IdsOf } from "./lineup.ts";
import type { LibItem } from "./library.ts";

/** Under this much seen, a program isn't "in progress" yet. */
export const RESUME_MIN_MS = 60_000;

export interface OnDemandDeps {
  /** Every present file of the current library (demo or live). */
  items: LibItem[];
  seenMs: (id: string) => number;
  furthestMs: (id: string) => number;
  watched: (id: string, durationMs: number | null) => boolean;
  /** Reachable only through locked channels while the PIN guard is up. */
  locked: (id: string) => boolean;
  /** Fields the server adds per item (availability, art, codecs, rating). */
  extra: (it: LibItem) => Record<string, unknown>;
  /** Database ids known on this PC, so copies from several sources show once (N-01d). */
  ids?: IdsOf;
}

export interface Recent {
  at: number;
  itemId: string;
  channel: string;
}

/** Files On Demand offers: present, video, not hidden by a lock; one copy per episode or film, none of a refused title. */
export function offered(d: OnDemandDeps): LibItem[] {
  return dedupe(d.items.filter((i) => i.present && (i.parsed.kind === "episode" || i.parsed.kind === "movie") && !d.locked(i.id)), d.ids);
}

export function resumeMs(d: OnDemandDeps, it: LibItem): number | null {
  if (d.watched(it.id, it.durationMs)) return null;
  if (d.seenMs(it.id) < RESUME_MIN_MS) return null;
  const f = d.furthestMs(it.id);
  return f > 0 && (!it.durationMs || f < it.durationMs) ? f : null;
}

export function itemView(d: OnDemandDeps, it: LibItem) {
  const p = it.parsed;
  const ep = p.kind === "episode" ? p : null;
  return {
    id: it.id,
    kind: p.kind === "episode" ? "episode" : "movie",
    title: ep ? ep.show : p.kind === "movie" ? p.title : it.name,
    ...(ep ? { showKey: ep.showKey, season: ep.season, episode: ep.episode, label: ep.absolute ? `Ep. ${ep.episode}` : `S${ep.season} · E${ep.episode}` } : {}),
    subtitle: it.subtitle ?? (ep ? it.meta?.title : undefined),
    year: p.kind === "movie" ? (p.year ?? it.meta?.year) : it.meta?.year,
    description: it.meta?.plot,
    genre: it.genre ?? it.meta?.genres?.[0],
    durationMs: it.durationMs ?? null,
    seenMs: d.seenMs(it.id),
    resumeMs: resumeMs(d, it),
    watched: d.watched(it.id, it.durationMs),
    ...d.extra(it),
  };
}

/**
 * What to play next of a show: an episode in progress after the last finished one,
 * else the first unwatched one after it; the first episode if nothing has been seen;
 * null when every episode after the last finished one is watched.
 */
export function nextUp(d: OnDemandDeps, episodes: LibItem[]): LibItem | null {
  const eps = sortEpisodes(episodes);
  let last = -1;
  eps.forEach((e, i) => d.watched(e.id, e.durationMs) && (last = i));
  const rest = eps.slice(last + 1);
  return rest.find((e) => resumeMs(d, e) != null) ?? rest.find((e) => !d.watched(e.id, e.durationMs)) ?? null;
}

function byShow(items: LibItem[]): Map<string, LibItem[]> {
  const m = new Map<string, LibItem[]>();
  for (const i of items) if (i.parsed.kind === "episode") m.set(i.parsed.showKey, [...(m.get(i.parsed.showKey) ?? []), i]);
  return m;
}

function showArt(d: OnDemandDeps, eps: LibItem[]) {
  for (const e of eps.slice(0, 50)) {
    const a = d.extra(e).art as Record<string, string> | undefined;
    if (a && (a.poster || a.logo || a.fanart)) return a;
  }
  return undefined;
}

function showSummary(d: OnDemandDeps, key: string, eps: LibItem[]) {
  const first = eps[0]!;
  const name = first.parsed.kind === "episode" ? first.parsed.show : key;
  const seasons = [...new Set(eps.map((e) => (e.parsed.kind === "episode" ? e.parsed.season : 0)))].sort((a, b) => (a || 1e6) - (b || 1e6));
  const years = eps.map((e) => e.meta?.year).filter((y): y is number => !!y);
  const rated = eps.map((e) => d.extra(e).rating).find((r) => r);
  const nu = nextUp(d, eps);
  return {
    key, name, episodes: eps.length, seasons,
    ...(years.length ? { year: Math.min(...years) } : {}),
    ...(first.genre ?? first.meta?.genres?.[0] ? { genre: first.genre ?? first.meta?.genres?.[0] } : {}),
    ...(rated ? { rating: rated } : {}),
    art: showArt(d, eps),
    watchedCount: eps.filter((e) => d.watched(e.id, e.durationMs)).length,
    nextUp: nu ? itemView(d, nu) : null,
  };
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase();

/** GET /api/ondemand */
export function browse(d: OnDemandDeps, q = "", kind: "all" | "show" | "movie" = "all") {
  const items = offered(d);
  const needle = q.trim().toLowerCase();
  const shows = kind === "movie" ? [] : [...byShow(items)]
    .filter(([, eps]) => !needle || eps.some((e) => norm(e.parsed.kind === "episode" ? e.parsed.show : "").includes(needle) || norm(e.subtitle ?? e.meta?.title).includes(needle)))
    .map(([key, eps]) => showSummary(d, key, eps))
    .sort((a, b) => a.name.localeCompare(b.name));
  const movies = kind === "show" ? [] : items
    .filter((i) => i.parsed.kind === "movie" && (!needle || norm(i.parsed.title).includes(needle)))
    .map((i) => itemView(d, i))
    .sort((a, b) => a.title.localeCompare(b.title) || (a.year ?? 0) - (b.year ?? 0));
  // Episode-name matches (up to 30), so "lighthouse" finds the episode, not just its show.
  const episodes = !needle || kind === "movie" ? [] : sortEpisodes(items.filter((i) => i.parsed.kind === "episode" && norm(i.subtitle ?? i.meta?.title).includes(needle)))
    .slice(0, 30).map((i) => itemView(d, i));
  return { shows, movies, episodes };
}

/** GET /api/ondemand/show */
export function show(d: OnDemandDeps, key: string) {
  const eps = byShow(offered(d)).get(key);
  if (!eps) return null;
  const sorted = sortEpisodes(eps);
  const seasons = new Map<number, LibItem[]>();
  for (const e of sorted) if (e.parsed.kind === "episode") seasons.set(e.parsed.season, [...(seasons.get(e.parsed.season) ?? []), e]);
  const s = showSummary(d, key, sorted);
  const description = sorted.map((e) => e.meta?.showPlot).find(Boolean);
  return {
    key, name: s.name, ...(description ? { description } : {}), art: s.art,
    seasons: [...seasons].map(([season, list]) => ({ season, episodes: list.map((e) => itemView(d, e)) })),
    nextUp: s.nextUp,
  };
}

/**
 * GET /api/continue: programs left part way (resume), and the next episode of a
 * show whose last-watched episode was finished (next). One row per show or film,
 * newest first.
 */
export function continueWatching(d: OnDemandDeps, recent: Recent[], limit = 20) {
  const items = offered(d);
  const byId = new Map(items.map((i) => [i.id, i]));
  const shows = byShow(items);
  const seen = new Set<string>();
  const out: Array<ReturnType<typeof itemView> & { reason: "resume" | "next"; lastAt: number; channel: string }> = [];
  for (const r of recent.slice().sort((a, b) => b.at - a.at)) {
    if (out.length >= limit) break;
    let it = byId.get(r.itemId);
    if (!it) continue;
    const group = it.parsed.kind === "episode" ? `s:${it.parsed.showKey}` : `m:${it.id}`;
    if (seen.has(group)) continue;
    seen.add(group);
    if (resumeMs(d, it) != null) {
      out.push({ ...itemView(d, it), reason: "resume", lastAt: r.at, channel: r.channel });
      continue;
    }
    if (it.parsed.kind !== "episode" || !d.watched(it.id, it.durationMs)) continue;
    it = nextUp(d, shows.get(it.parsed.showKey) ?? []) ?? undefined;
    if (it) out.push({ ...itemView(d, it), reason: resumeMs(d, it) != null ? "resume" : "next", lastAt: r.at, channel: r.channel });
  }
  return { items: out };
}
