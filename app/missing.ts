// "What's missing" and "New this week" for a show channel: which aired episodes the
// library doesn't have, what aired in the last 7 days, and what airs next. From TMDB
// air dates only; it never adds or fetches anything for the library.
//
// Uses the show match online metadata already made (no new searches), and never asks
// about a show whose every copy sits on PIN-locked channels.

import type { LibItem } from "./library.ts";
import type { ShowSchedule } from "./metadata/tmdb.ts";

export interface ShowGaps {
  showKey: string;
  name: string;
  tmdbId: number | null;
  /** Seasons that have aired or that the library has. Specials (0) only when the library has some. */
  seasons: Array<{ season: number; have: number; aired: number; total: number; missing: number[] }>;
  newThisWeek: Array<{ season: number; episode: number; name?: string; airDate: string; inLibrary: boolean }>;
  nextAir?: { season: number; episode: number; airDate: string; name?: string } | null;
  checkedAt: number;
}

export interface GapsDeps {
  /** Library items (present ones are used). */
  items: LibItem[];
  /** PIN-locked items are never looked up. */
  locked: (id: string) => boolean;
  /** Maps a file's show key to the channel's (show aliases, usableLibrary().showOf). Default: as is. */
  showOf?: (key: string) => string;
  online: {
    enabled(): boolean;
    tmdbId(it: LibItem | undefined): string | undefined;
    showSchedule(tmdbId: number): Promise<ShowSchedule | null>;
  };
  now?: number;
  /** Station time zone, so "aired" means aired by today where the viewer is. Default UTC. */
  timeZone?: string;
}

/** Today as YYYY-MM-DD in a time zone. */
export function dayIn(ms: number, timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Null when online metadata is off, the show isn't in the library or TMDB has no match for it yet. */
export async function showGaps(showKey: string, deps: GapsDeps): Promise<ShowGaps | null> {
  if (!deps.online.enabled()) return null;
  const showOf = deps.showOf ?? ((k: string) => k);
  const eps = deps.items.filter((i) => i.present && !i.excluded && i.parsed.kind === "episode" && showOf(i.parsed.showKey) === showKey && !deps.locked(i.id));
  if (!eps.length) return null;
  const idStr = eps.map((i) => deps.online.tmdbId(i)).find(Boolean);
  const tmdbId = idStr ? Number(idStr) : NaN;
  if (!Number.isInteger(tmdbId)) return null;
  let sch: ShowSchedule | null;
  try {
    sch = await deps.online.showSchedule(tmdbId);
  } catch {
    return null;
  }
  if (!sch) return null;
  const today = dayIn(deps.now ?? Date.now(), deps.timeZone);
  return gapsFrom(showKey, eps, sch, today);
}

/** The counting, apart from TMDB, for tests. `eps` are the show's library episodes. */
export function gapsFrom(showKey: string, eps: LibItem[], sch: ShowSchedule, today: string): ShowGaps {
  const regular = sch.seasons.filter((s) => s.season > 0).sort((a, b) => a.season - b.season);
  // Library episodes by season; a multi-episode file (S01E01E02) holds each one.
  const have = new Map<number, Set<number>>();
  const add = (s: number, e: number) => (have.get(s) ?? have.set(s, new Set()).get(s)!).add(e);
  for (const it of eps) {
    const p = it.parsed;
    if (p.kind !== "episode") continue;
    for (let e = p.episode; e <= (p.episodeEnd ?? p.episode); e++) {
      if (p.absolute) {
        // Numbered across the whole run ("Show - 57"): walk TMDB's season sizes.
        let n = e;
        const s = regular.find((x) => {
          if (n <= x.episodeCount) return true;
          n -= x.episodeCount;
          return false;
        });
        if (s) add(s.season, n);
        else add(p.season, e);
      } else add(p.season, e);
    }
  }

  const dated = (s: number) => sch.episodes[String(s)];
  const L = sch.lastAired;
  const airedIn = (s: { season: number; episodeCount: number; airDate?: string }): number[] => {
    const list = dated(s.season);
    if (list) return list.filter((e) => e.airDate && e.airDate <= today).map((e) => e.episode);
    if (s.airDate && s.airDate > today) return [];
    // An earlier season than the latest aired episode has aired in full; that season up to it.
    let n = 0;
    if (s.season === 0) n = s.airDate ? s.episodeCount : 0;
    else if (L && L.airDate <= today) n = s.season < L.season ? s.episodeCount : s.season === L.season ? L.episode : 0;
    else if (L) n = s.season < L.season ? s.episodeCount : s.season === L.season ? L.episode - 1 : 0;
    return Array.from({ length: Math.max(0, n) }, (_, i) => i + 1);
  };

  const seasons: ShowGaps["seasons"] = [];
  const known = new Set(sch.seasons.map((s) => s.season));
  const all = [...sch.seasons, ...[...have.keys()].filter((s) => !known.has(s)).map((s) => ({ season: s, episodeCount: 0 }))];
  for (const s of all.sort((a, b) => a.season - b.season)) {
    const mine = have.get(s.season) ?? new Set<number>();
    if (s.season === 0 && !mine.size) continue;
    const aired = airedIn(s);
    if (!aired.length && !mine.size) continue;
    const missing = aired.filter((e) => !mine.has(e)).sort((a, b) => a - b);
    const total = Math.max(s.episodeCount, dated(s.season)?.length ?? 0, aired.length);
    seasons.push({ season: s.season, have: aired.length - missing.length, aired: aired.length, total, missing });
  }

  const weekAgo = addDays(today, -6);
  const listed = Object.entries(sch.episodes).flatMap(([s, list]) => list.map((e) => ({ ...e, season: Number(s) })));
  listed.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const newThisWeek = listed
    .filter((e) => e.airDate && e.airDate >= weekAgo && e.airDate <= today)
    .map((e) => ({ season: e.season, episode: e.episode, ...(e.name ? { name: e.name } : {}), airDate: e.airDate!, inLibrary: !!have.get(e.season)?.has(e.episode) }));

  const upcoming = listed.find((e) => e.airDate && e.airDate > today);
  const nextAir = upcoming
    ? { season: upcoming.season, episode: upcoming.episode, airDate: upcoming.airDate!, ...(upcoming.name ? { name: upcoming.name } : {}) }
    : sch.nextAir && sch.nextAir.airDate > today ? sch.nextAir : null;

  const first = eps.find((i) => i.parsed.kind === "episode");
  return {
    showKey,
    name: sch.name || (first?.parsed.kind === "episode" ? first.parsed.show : showKey),
    tmdbId: sch.id,
    seasons, newThisWeek, nextAir,
    checkedAt: sch.at,
  };
}
