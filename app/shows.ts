// Show identity for the whole app: every view (On Demand, channels, guide, the
// library page) reads items through `ShowIdentity.apply`, so one show has one
// name, one key and seasons that don't collide, whatever its files are called.
// The grouping itself is src/library/identity.ts; this file feeds it the library,
// the ids known on this PC (tvshow.nfo, the TMDB cache: never looked up here) and
// the viewer's own merges, splits and names, kept in shows.json.

import type { LibItem } from "./library.ts";
import type { ExternalIds } from "../src/library/nfo.ts";
import type { Parsed } from "../src/library/parse.ts";
import { placeEpisode, resolveShows, searchFor, type IdentityOverrides, type Resolution, type ShowGroup, type ShowUnit, type TmdbShow } from "../src/library/identity.ts";
import { JsonFile } from "./store.ts";

type Episode = Extract<Parsed, { kind: "episode" }>;

export interface ShowIdentityDeps {
  /** Database ids for an item's show (its tvshow.nfo, then the TMDB cache). Cache reads only. */
  idsOf: (i: LibItem) => ExternalIds | undefined;
  /** What the TMDB cache knows about a show: its name and seasons. Cache reads only. */
  tmdbShow?: (tmdbId: string) => TmdbShow | undefined;
}

interface OverrideFile extends IdentityOverrides {
  v: 1;
}

/** The parser's unit for an episode: its name key and year. */
export const unitOf = (p: Episode) => `${p.showKey}|${p.year ?? ""}`;

/** Every parsed show name (and year) in the items, with what grouping needs to know. */
export function unitsOf(items: LibItem[], idsOf: ShowIdentityDeps["idsOf"]): ShowUnit[] {
  const acc = new Map<string, { u: ShowUnit; rep: LibItem; seasons: Set<number> }>();
  for (const i of items) {
    const p = i.parsed;
    if (p.kind !== "episode") continue;
    const id = unitOf(p);
    let a = acc.get(id);
    if (!a) {
      a = { u: { id, name: p.show, ...(p.year ? { year: p.year } : {}), episodes: 0, minEpisode: p.episode, seasons: [], absolute: true }, rep: i, seasons: new Set() };
      acc.set(id, a);
    }
    a.u.episodes++;
    a.u.minEpisode = Math.min(a.u.minEpisode, p.episode);
    a.u.absolute &&= !!p.absolute;
    a.seasons.add(p.season);
    // A tvshow.nfo with ids beats a file without one.
    if (!a.rep.meta?.showIds && i.meta?.showIds) a.rep = i;
  }
  return [...acc.values()].map(({ u, rep, seasons }) => {
    u.seasons = [...seasons].sort((a, b) => a - b);
    const ids = idsOf(withSearch(rep, searchFor(u)));
    return ids && Object.values(ids).some(Boolean) ? { ...u, ids: { ...ids } } : u;
  });
}

function withSearch(i: LibItem, searchAs: { show: string; year?: number }): LibItem {
  return i.parsed.kind === "episode" ? { ...i, parsed: { ...i.parsed, searchAs } } : i;
}

/** An item as its show's identity says: same object when nothing changes. */
export function placeItem(i: LibItem, res: Resolution, units?: Map<string, ShowUnit>): LibItem {
  const p = i.parsed;
  if (p.kind !== "episode") return i;
  const id = unitOf(p);
  const pl = res.placement.get(id);
  if (!pl) return i;
  const at = placeEpisode(pl, p);
  const u = units?.get(id);
  const search = searchFor(u ?? { name: p.show, ...(p.year ? { year: p.year } : {}) });
  const shift = at.episode - p.episode;
  const changed = pl.key !== p.showKey || pl.name !== p.show || at.season !== p.season || shift !== 0 || at.absolute !== !!p.absolute
    || search.show !== p.show || search.year !== p.year;
  if (!changed) return i;
  const next: Episode = { ...p, show: pl.name, showKey: pl.key, season: at.season, episode: at.episode, searchAs: search, unit: id };
  if (p.episodeEnd !== undefined) next.episodeEnd = p.episodeEnd + shift;
  if (at.absolute) next.absolute = true;
  else delete next.absolute;
  return { ...i, parsed: next };
}

export class ShowIdentity {
  private readonly file = new JsonFile<OverrideFile>("shows.json", () => ({ v: 1, merge: [], apart: [], names: {} }));
  private memo: { sig: string; res: Resolution; units: Map<string, ShowUnit> } | null = null;

  private readonly deps: ShowIdentityDeps;

  constructor(deps: ShowIdentityDeps) {
    this.deps = deps;
  }

  /** The grouping for these items (cached until the shows, ids or overrides change). */
  resolve(items: LibItem[]): { res: Resolution; units: Map<string, ShowUnit> } {
    const units = unitsOf(items, this.deps.idsOf);
    const ov = this.file.get();
    const tm = new Map<string, TmdbShow | undefined>();
    for (const u of units) if (u.ids?.tmdb && !tm.has(u.ids.tmdb)) tm.set(u.ids.tmdb, this.deps.tmdbShow?.(u.ids.tmdb));
    const sig = JSON.stringify([units, ov, [...tm].map(([k, t]) => [k, t?.name, t?.seasons?.length ?? 0])]);
    if (this.memo?.sig !== sig) {
      this.memo = { sig, res: resolveShows(units, { overrides: ov, tmdbShow: (id) => tm.get(id) }), units: new Map(units.map((u) => [u.id, u])) };
    }
    return this.memo;
  }

  /** Items with their show's one name, key and seasons. */
  apply(items: LibItem[]): LibItem[] {
    const { res, units } = this.resolve(items);
    return items.map((i) => placeItem(i, res, units));
  }

  /** One item, by the last grouping worked out (raw when its show is new since). */
  view(i: LibItem | undefined): LibItem | undefined {
    return i && this.memo ? placeItem(i, this.memo.res, this.memo.units) : i;
  }

  /** Shows and what each was made from, for the merge and split controls. */
  groups(items: LibItem[]): ShowGroup[] {
    return this.resolve(items).res.groups;
  }

  overrides(): IdentityOverrides {
    return this.file.get();
  }

  /** The viewer says show `key` is show `into`. */
  merge(items: LibItem[], key: string, into: string): ShowGroup | null {
    const gs = this.groups(items);
    const a = gs.find((g) => g.key === key), b = gs.find((g) => g.key === into);
    if (!a || !b || a === b) return null;
    const units = [...a.members, ...b.members].map((m) => m.unit);
    this.file.update((f) => {
      f.apart = (f.apart ?? []).filter((u) => !units.includes(u));
      f.merge = [...(f.merge ?? []), ...a.members.map((m) => [b.members[0]!.unit, m.unit] as [string, string])].slice(-500);
      if (f.names?.[key] && !f.names[into]) f.names[into] = f.names[key];
    });
    return this.groups(items).find((g) => g.members.some((m) => m.unit === b.members[0]!.unit)) ?? null;
  }

  /** The viewer says one name (unit) isn't this show. */
  split(items: LibItem[], unit: string): ShowGroup | null {
    if (!this.groups(items).some((g) => g.members.some((m) => m.unit === unit))) return null;
    this.file.update((f) => {
      f.merge = (f.merge ?? []).filter(([a, b]) => a !== unit && b !== unit);
      f.apart = [...new Set([...(f.apart ?? []), unit])].slice(-500);
    });
    return this.groups(items).find((g) => g.members.some((m) => m.unit === unit)) ?? null;
  }

  /** A name the viewer chose for a show, or null to go back to the automatic one. */
  rename(items: LibItem[], key: string, name: string | null): ShowGroup | null {
    if (!this.groups(items).some((g) => g.key === key)) return null;
    this.file.update((f) => {
      f.names ??= {};
      if (name && name.trim()) f.names[key] = name.trim().slice(0, 80);
      else delete f.names[key];
    });
    return this.groups(items).find((g) => g.key === key) ?? null;
  }

  /** Forget the viewer's merges, splits and name for one show. */
  reset(items: LibItem[], key: string): ShowGroup | null {
    const g = this.groups(items).find((x) => x.key === key);
    if (!g) return null;
    const units = new Set(g.members.map((m) => m.unit));
    // Names split off this show stand alone now; the automatic grouping says which were its.
    for (const a of resolveShows(unitsOf(items, this.deps.idsOf)).groups)
      if (a.members.some((m) => units.has(m.unit))) for (const m of a.members) units.add(m.unit);
    this.file.update((f) => {
      f.merge = (f.merge ?? []).filter(([a, b]) => !units.has(a) && !units.has(b));
      f.apart = (f.apart ?? []).filter((u) => !units.has(u));
      if (f.names) delete f.names[key];
    });
    return this.groups(items).find((x) => x.members.some((m) => units.has(m.unit))) ?? null;
  }

  /** Settings export/import. */
  export(): IdentityOverrides {
    const { merge, apart, names } = this.file.get();
    return { merge, apart, names };
  }
  import(x: unknown): boolean {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    const pairs = Array.isArray(o.merge) ? o.merge.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string")) : [];
    const apart = Array.isArray(o.apart) ? o.apart.filter((s): s is string => typeof s === "string") : [];
    const names = o.names && typeof o.names === "object" ? Object.fromEntries(Object.entries(o.names as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 80)])) : {};
    this.file.set({ v: 1, merge: pairs.slice(-500), apart: apart.slice(-500), names });
    this.memo = null;
    return true;
  }
}

type Json = (status: number, body: unknown) => void;

/**
 * /api/shows/identity routes. GET lists shows with what each was made from
 * (?key= for one). POST /merge {key, into}, /split {unit}, /rename {key, name},
 * /reset {key}. Changes need the PIN when the guard is up.
 */
export function showRoutes(ids: ShowIdentity, items: () => LibItem[], p: string, method: string, body: Record<string, unknown>, query: URLSearchParams, guarded: () => boolean, json: Json, changed: () => void): boolean {
  if (!p.startsWith("/api/shows/identity")) return false;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 300) : null);
  if (p === "/api/shows/identity" && method === "GET") {
    const all = ids.groups(items());
    const key = query.get("key");
    if (key) {
      const g = all.find((x) => x.key === key);
      json(g ? 200 : 404, g ?? { error: "no such show" });
    } else json(200, { shows: all.map((g) => ({ key: g.key, name: g.name, names: g.members.length, episodes: g.members.reduce((n, m) => n + m.episodes, 0) })) });
    return true;
  }
  if (method !== "POST") return false;
  if (guarded()) {
    json(403, { error: "Enter the parental PIN to change this.", pinRequired: true });
    return true;
  }
  let out: ShowGroup | null = null;
  if (p === "/api/shows/identity/merge") {
    const key = str(body.key), into = str(body.into);
    out = key && into ? ids.merge(items(), key, into) : null;
  } else if (p === "/api/shows/identity/split") {
    const unit = str(body.unit);
    out = unit ? ids.split(items(), unit) : null;
  } else if (p === "/api/shows/identity/rename") {
    const key = str(body.key);
    out = key ? ids.rename(items(), key, str(body.name)) : null;
  } else if (p === "/api/shows/identity/reset") {
    const key = str(body.key);
    out = key ? ids.reset(items(), key) : null;
  } else return false;
  if (!out) json(400, { error: "No such show." });
  else {
    changed();
    json(200, out);
  }
  return true;
}
