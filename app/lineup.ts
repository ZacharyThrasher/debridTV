// Channel lineup: rules over the library, never content acquisition (parity N-02).
// Rules are re-evaluated as the library grows, but a channel only changes through
// StationClock.revise(), which waits for the current airing to end (gate C7).
// Channel numbers, once given, stay put (N-03).

import { StationClock } from "../src/clock/schedule.ts";
import type { Channel, ChannelRevision, Ordering } from "../src/clock/types.ts";
import { validMonthDay, type DateRange, type Dayparts, type DaypartRule } from "../src/clock/dayparts.ts";
import { KID_MAX, RATINGS as RATING_SCALE, type Rating } from "../src/clock/ratings.ts";
import { hash32 } from "../src/clock/rng.ts";
import { ORDERINGS } from "../src/clock/ordering.ts";
import { JsonFile } from "./store.ts";
import { airsAsExtra, breakpoints, type LibItem } from "./library.ts";
import type { ExternalIds } from "../src/library/nfo.ts";

const MIN = 60_000;

export interface ChannelMeta {
  ruleKey: string;
  kind: "show" | "mix" | "movies" | "custom" | "demo" | "group" | "trailers" | "music";
  hue: number;
  tagline: string;
}

export type StationChannel = Channel & { meta: ChannelMeta };

export interface CustomChannel {
  id: string;
  name: string;
  showKeys: string[];
  movieIds: string[];
  ordering: Ordering;
  slotMinutes: number | null;
  /** Content groups this channel draws from, after its own shows and films (N-07). */
  groupIds?: string[];
}

/** One show (all its episodes, in order) or one film in a content group. */
export type GroupEntry = { kind: "show"; key: string } | { kind: "movie"; id: string };

/**
 * A named set of shows and films with its own running order and guide description
 * (N-07). A building block: a time slot can air it ("group:<id>"), custom channels
 * can include it, and it can be a channel of its own.
 */
export interface ContentGroup {
  id: string;
  name: string;
  description?: string;
  /** In the viewer's order; "cyclic" airs them in exactly this order. */
  entries: GroupEntry[];
  ordering: Ordering;
  /** Also air it as its own channel. */
  channel?: boolean;
}

interface LineupState {
  channels: StationChannel[];
  numbers: Record<string, number>;
  custom: CustomChannel[];
  hidden: string[];
  /** The viewer's own touches per channel (by rule key), kept across rebuilds. */
  settings?: Record<string, ChannelSettings>;
  /** Shows and genres kept off every channel (N-09b). */
  exclude?: Exclusions;
  /** Content groups (N-07). */
  groups?: ContentGroup[];
}

export interface Exclusions {
  /** Show keys (as in "show:<key>" rule keys). */
  shows?: string[];
  /** Genre names, matched without regard to case or punctuation. */
  genres?: string[];
}

/** What sync needs to know about an item to apply exclusions and watched rules. */
export interface ItemInfo {
  showKey?: string;
  genres?: string[];
  watched?: boolean;
  /** Added to the library recently enough to premiere. */
  recent?: boolean;
}

export type ChannelLogo =
  | { kind: "badge" | "text"; text: string; hue?: number; style?: "block" | "outline" | "pill" }
  | { kind: "image"; url: string };

export interface RestrictedHours {
  from: string;
  to: string;
  maxRating: (typeof RATINGS)[number];
  /** Only between these dates each year (N-32). */
  dates?: DateRange;
}
export interface TimeSlot {
  /** Mon=1 … Sun=7. */
  days: number[];
  from: string;
  /** to <= from means the slot runs overnight. */
  to: string;
  /** Rule key whose programs fill this slot (a channel's, or "group:<id>"). */
  source: string;
  /** Only between these dates each year: October horror, December holidays (N-32). */
  dates?: DateRange;
}

export interface ChannelSettings {
  name?: string;
  favorite?: boolean;
  logo?: ChannelLogo;
  /** Only programs rated PG or lower air; unrated ones don't (gate D7). */
  kid?: boolean;
  restrictedHours?: RestrictedHours[];
  slots?: TimeSlot[];
  /** Air season-0 specials too (after the regular seasons). Off by default (N-05). */
  specials?: boolean;
  /** Share of turns per show (show key, or "films"): 0–100, default 50, 0 = never (N-09a). */
  weights?: Record<string, number>;
  /** Even out turns (default) or airtime (N-09d). */
  balance?: "episodes" | "time";
  /** Now and then stay on one show for up to four hours (N-09e). */
  marathons?: boolean;
  /** Recently added programs air first (N-09c). */
  premieres?: boolean;
  /** all (default), unwatched only, or resume each show after its last watched episode (N-05). */
  watched?: "all" | "unwatched" | "resume";
  /** Shows and genres kept off this channel (N-09b). */
  exclude?: Exclusions;
  /** Bumped by "refresh schedule": a new shuffle from the end of the current program (N-10). */
  reshuffle?: number;
  /** Needs the parental PIN to watch (N-06b). Has no effect while no PIN is set. */
  locked?: boolean;
  /** On the air only between these dates each year; off the air the rest of the year (N-32). */
  season?: DateRange;
}

const WEIGHT_KEYS = /^[\w:. -]{1,200}$/;

export const RATINGS = RATING_SCALE;

export interface Rule {
  key: string;
  name: string;
  kind: ChannelMeta["kind"];
  tagline: string;
  itemIds: string[];
  ordering: Ordering;
  slotMs?: number;
  midBreakMs?: number;
  preferredNumber?: number;
  /** Season-0 specials among itemIds; they stay off unless the channel's settings ask for them. */
  specialIds?: string[];
  /** A program source for slots only (a content group that isn't its own channel). */
  sourceOnly?: boolean;
}

export class Lineup {
  private readonly file: JsonFile<LineupState>;

  constructor(fileName = "lineup.json") {
    this.file = new JsonFile<LineupState>(fileName, () => ({ channels: [], numbers: {}, custom: [], hidden: [] }));
  }

  channels(): StationChannel[] {
    const s = this.file.get();
    return s.channels.filter((c) => !s.hidden.includes(c.meta.ruleKey)).sort((a, b) => a.number - b.number);
  }

  allChannels(): StationChannel[] {
    return this.file.get().channels.slice().sort((a, b) => a.number - b.number);
  }

  custom(): CustomChannel[] {
    return this.file.get().custom;
  }

  hidden(): string[] {
    return this.file.get().hidden;
  }

  setHidden(ruleKey: string, hidden: boolean): void {
    this.file.update((s) => {
      s.hidden = s.hidden.filter((k) => k !== ruleKey);
      if (hidden) s.hidden.push(ruleKey);
    });
  }

  saveCustom(c: CustomChannel): void {
    this.file.update((s) => {
      s.custom = [...s.custom.filter((x) => x.id !== c.id), c];
    });
  }

  deleteCustom(id: string): void {
    this.file.update((s) => {
      s.custom = s.custom.filter((x) => x.id !== id);
      s.channels = s.channels.filter((c) => c.meta.ruleKey !== `custom:${id}`);
    });
  }

  groups(): ContentGroup[] {
    return this.file.get().groups ?? [];
  }

  saveGroup(g: ContentGroup): void {
    this.file.update((s) => {
      const list = s.groups ?? [];
      const i = list.findIndex((x) => x.id === g.id);
      s.groups = i >= 0 ? list.map((x, j) => (j === i ? g : x)) : [...list, g];
    });
  }

  /** Remove a group; slots that aired it are dropped and custom channels forget it. */
  deleteGroup(id: string): boolean {
    let found = false;
    const key = `group:${id}`;
    this.file.update((s) => {
      found = !!s.groups?.some((g) => g.id === id);
      s.groups = (s.groups ?? []).filter((g) => g.id !== id);
      for (const c of s.custom) if (c.groupIds?.includes(id)) {
        c.groupIds = c.groupIds.filter((x) => x !== id);
        if (!c.groupIds.length) delete c.groupIds;
      }
      for (const st of Object.values(s.settings ?? {})) if (st.slots?.some((sl) => sl.source === key)) {
        st.slots = st.slots.filter((sl) => sl.source !== key);
        if (!st.slots.length) delete st.slots;
      }
      s.channels = s.channels.filter((c) => c.meta.ruleKey !== key);
    });
    return found;
  }

  exclusions(): Exclusions {
    return this.file.get().exclude ?? {};
  }

  setExclusions(ex: Exclusions): void {
    this.file.update((s) => {
      s.exclude = ex.shows?.length || ex.genres?.length ? ex : undefined;
    });
  }

  settingsFor(ruleKey: string): ChannelSettings {
    return this.file.get().settings?.[ruleKey] ?? {};
  }

  /**
   * Rename, renumber, favorite or brand a channel. A number already in use is
   * refused (no silent shuffling of other channels, N-03); `null` clears a field.
   */
  updateSettings(
    ruleKey: string,
    patch: { name?: string | null; number?: number; favorite?: boolean; logo?: ChannelLogo | null; kid?: boolean; restrictedHours?: RestrictedHours[]; slots?: TimeSlot[]; specials?: boolean; locked?: boolean; season?: DateRange | null } & Partial<Pick<ChannelSettings, "weights" | "balance" | "marathons" | "premieres" | "watched" | "exclude">> & { reshuffle?: boolean },
  ): { ok: true; swappedWith?: string } | { ok: false; error: string } {
    const s = this.file.get();
    const ch = s.channels.find((c) => c.meta.ruleKey === ruleKey);
    if (!ch) return { ok: false, error: "no such channel" };
    let swappedWith: string | undefined;
    if (patch.number !== undefined && patch.number !== ch.number) {
      if (!Number.isInteger(patch.number) || patch.number < 1 || patch.number > 9999) return { ok: false, error: "Channel numbers run from 1 to 9999." };
      // Asking for a taken number swaps the two channels: explicit, and nothing else moves.
      const holder = s.channels.find((c) => c.number === patch.number);
      const freedKey = Object.entries(s.numbers).find(([k, n]) => n === patch.number && k !== ruleKey)?.[0];
      if (holder) {
        holder.number = ch.number;
        s.numbers[holder.meta.ruleKey] = ch.number;
        swappedWith = holder.name;
      } else if (freedKey) s.numbers[freedKey] = ch.number; // a channel that's off the air keeps a number too
      ch.number = patch.number;
      s.numbers[ruleKey] = patch.number;
    }
    const cur = { ...s.settings?.[ruleKey] };
    if (patch.name !== undefined) {
      const n = (patch.name ?? "").trim().slice(0, 40);
      if (n) cur.name = n;
      else delete cur.name;
    }
    if (patch.favorite !== undefined) cur.favorite = patch.favorite || undefined;
    if (patch.logo !== undefined) {
      if (patch.logo === null) delete cur.logo;
      else cur.logo = patch.logo;
    }
    if (patch.kid !== undefined) cur.kid = patch.kid || undefined;
    if (patch.restrictedHours !== undefined) cur.restrictedHours = patch.restrictedHours.length ? patch.restrictedHours : undefined;
    if (patch.slots !== undefined) cur.slots = patch.slots.length ? patch.slots : undefined;
    if (patch.specials !== undefined) cur.specials = patch.specials || undefined;
    if (patch.weights !== undefined) cur.weights = Object.keys(patch.weights).length ? patch.weights : undefined;
    if (patch.balance !== undefined) cur.balance = patch.balance === "time" ? "time" : undefined;
    if (patch.marathons !== undefined) cur.marathons = patch.marathons || undefined;
    if (patch.premieres !== undefined) cur.premieres = patch.premieres || undefined;
    if (patch.watched !== undefined) cur.watched = patch.watched === "all" ? undefined : patch.watched;
    if (patch.exclude !== undefined) cur.exclude = patch.exclude.shows?.length || patch.exclude.genres?.length ? patch.exclude : undefined;
    if (patch.reshuffle) cur.reshuffle = (cur.reshuffle ?? 0) + 1;
    if (patch.locked !== undefined) cur.locked = patch.locked || undefined;
    if (patch.season !== undefined) cur.season = patch.season ?? undefined;
    s.settings = { ...s.settings, [ruleKey]: cur };
    if (cur.name) ch.name = cur.name;
    this.file.set(s);
    return { ok: true, ...(swappedWith ? { swappedWith } : {}) };
  }

  /** What a settings export carries: choices, not library facts or credentials. */
  exportSettings(): { numbers: Record<string, number>; custom: CustomChannel[]; hidden: string[]; settings: Record<string, ChannelSettings>; exclude: Exclusions; groups: ContentGroup[] } {
    const s = this.file.get();
    return { numbers: { ...s.numbers }, custom: s.custom.slice(), hidden: s.hidden.slice(), settings: { ...s.settings }, exclude: s.exclude ?? {}, groups: (s.groups ?? []).slice() };
  }

  /**
   * Bring back exported choices. Custom channels and hidden flags are merged by id;
   * a remembered number is only taken if nothing here already uses it.
   */
  importSettings(x: { numbers?: unknown; custom?: unknown; hidden?: unknown; settings?: unknown; exclude?: unknown; groups?: unknown }): { custom: number; hidden: number; groups: number } {
    let custom = 0;
    let hidden = 0;
    let groups = 0;
    this.file.update((s) => {
      if (Array.isArray(x.groups))
        for (const raw of x.groups) {
          const g = cleanGroup(raw, typeof raw?.id === "string" ? raw.id : undefined);
          if (!g) continue;
          s.groups = [...(s.groups ?? []).filter((y) => y.id !== g.id), g];
          groups++;
        }
      if (Array.isArray(x.custom))
        for (const c of x.custom as CustomChannel[]) {
          if (!c || typeof c.id !== "string" || typeof c.name !== "string" || !Array.isArray(c.showKeys) || !Array.isArray(c.movieIds)) continue;
          s.custom = [...s.custom.filter((y) => y.id !== c.id), {
            id: c.id.slice(0, 20), name: c.name.slice(0, 40), showKeys: c.showKeys.map(String), movieIds: c.movieIds.map(String),
            ordering: ORDERINGS.includes(c.ordering) ? c.ordering : "block-shuffle", slotMinutes: typeof c.slotMinutes === "number" ? c.slotMinutes : 30,
            ...(Array.isArray(c.groupIds) && c.groupIds.length ? { groupIds: c.groupIds.map(String).slice(0, 50) } : {}),
          }];
          custom++;
        }
      if (Array.isArray(x.hidden))
        for (const k of x.hidden) if (typeof k === "string" && !s.hidden.includes(k)) (s.hidden.push(k), hidden++);
      if (x.settings && typeof x.settings === "object")
        for (const [k, v] of Object.entries(x.settings as Record<string, unknown>)) {
          const c = cleanSettings(v);
          if (c) s.settings = { ...s.settings, [k]: c };
        }
      const ex = cleanExclusions(x.exclude);
      if (ex && (ex.shows?.length || ex.genres?.length))
        s.exclude = { shows: [...new Set([...(s.exclude?.shows ?? []), ...(ex.shows ?? [])])], genres: [...new Set([...(s.exclude?.genres ?? []), ...(ex.genres ?? [])])] };
      if (x.numbers && typeof x.numbers === "object") {
        const used = new Set(Object.values(s.numbers));
        for (const [k, n] of Object.entries(x.numbers as Record<string, unknown>))
          if (typeof n === "number" && Number.isInteger(n) && n > 0 && !(k in s.numbers) && !used.has(n)) (s.numbers[k] = n), used.add(n);
      }
    });
    return { custom, hidden, groups };
  }

  /** Rule keys of channels marked locked (whether or not a PIN makes that count). */
  lockedKeys(): string[] {
    return Object.entries(this.file.get().settings ?? {}).filter(([, v]) => v.locked).map(([k]) => k);
  }

  /** Removing the PIN unlocks every channel for good, so a new PIN starts with none locked. */
  clearLocks(): number {
    const keys = this.lockedKeys();
    if (keys.length) this.file.update((s) => {
      for (const k of keys) if (s.settings?.[k]) delete s.settings[k]!.locked;
    });
    return keys.length;
  }

  /** Forget channels, numbers and choices. */
  reset(): void {
    this.file.set({ channels: [], numbers: {}, custom: [], hidden: [], groups: [] });
  }

  /**
   * Bring channels in line with the rules. New channels start on a past slot
   * boundary so they look like they've been on air all along; existing channels
   * change only at the end of what is airing now.
   */
  sync(clock: StationClock, rulesIn: Rule[], now: number, opts: { timeZone?: string; info?: (id: string) => ItemInfo | undefined } = {}): { added: number; revised: number; removed: number } {
    const s = this.file.get();
    const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const info = opts.info ?? (() => undefined);
    const audience = (r: Rule) => ({ ...scheduleRules(s.settings?.[r.key] ?? {}, byKey, timeZone), ...mixRules(s.settings?.[r.key] ?? {}, r, info) });
    const rules = rulesIn.flatMap((r) => shapeRule(r, s.settings?.[r.key] ?? {}, s.exclude ?? {}, info) ?? []);
    const byKey = new Map(rules.map((r) => [r.key, r]));
    let added = 0;
    let revised = 0;
    const live = new Set(rules.filter((r) => !r.sourceOnly).map((r) => r.key));
    const removedBefore = s.channels.length;
    s.channels = s.channels.filter((c) => live.has(c.meta.ruleKey));
    const removed = removedBefore - s.channels.length;

    // Rules that ask for a number go first so they get it on a fresh lineup.
    const ordered = rules.filter((r) => !r.sourceOnly).sort((a, b) => (a.preferredNumber ?? 1e9) - (b.preferredNumber ?? 1e9));
    for (const r of ordered) {
      const existing = s.channels.find((c) => c.meta.ruleKey === r.key);
      if (!existing) {
        const number = s.numbers[r.key] ?? nextNumber(s.numbers, r.preferredNumber);
        s.numbers[r.key] = number;
        const anchor = Math.floor((now - 7 * 24 * 60 * MIN) / (30 * MIN)) * 30 * MIN;
        s.channels.push({
          id: `ch-${hash32(r.key).toString(36)}`,
          number,
          name: s.settings?.[r.key]?.name ?? r.name,
          revisions: [{ effectiveFromMs: anchor, itemIds: r.itemIds, ordering: r.ordering, slotMs: r.slotMs, midBreakMs: r.midBreakMs, ...audience(r) }],
          meta: { ruleKey: r.key, kind: r.kind, hue: hash32(r.key) % 360, tagline: r.tagline },
        });
        added++;
        continue;
      }
      existing.name = s.settings?.[r.key]?.name ?? r.name;
      existing.meta.tagline = r.tagline;
      const cur = existing.revisions[existing.revisions.length - 1]!;
      const aud = audience(r);
      const same =
        cur.seed === aud.seed &&
        JSON.stringify(cur.mix) === JSON.stringify(aud.mix) &&
        cur.maxRating === aud.maxRating &&
        JSON.stringify(cur.dayparts) === JSON.stringify(aud.dayparts) &&
        cur.ordering === r.ordering &&
        cur.slotMs === r.slotMs &&
        cur.midBreakMs === r.midBreakMs &&
        cur.itemIds.length === r.itemIds.length &&
        cur.itemIds.every((id, i) => id === r.itemIds[i]);
      if (same) continue;
      // Kid, restricted-hours and slot changes also wait for the end of what's on (C7).
      const next = clock.revise(existing, now, { itemIds: r.itemIds, ordering: r.ordering, slotMs: r.slotMs, midBreakMs: r.midBreakMs, ...aud });
      existing.revisions = next.revisions.slice(-6); // keep a short history
      revised++;
    }
    this.file.set(s);
    return { added, revised, removed };
  }
}

/**
 * A rule's programs after the viewer's choices: specials (N-05), exclusions
 * (N-09b, global and per channel) and watched rules. If exclusions or "unwatched"
 * would leave nothing, the channel keeps its full list rather than going dark.
 */
export function shapeRule(r: Rule, st: ChannelSettings, global: Exclusions, info: (id: string) => ItemInfo | undefined): Rule | null {
  let ids = r.itemIds;
  if (r.specialIds?.length && !st.specials) {
    const sp = new Set(r.specialIds);
    ids = ids.filter((id) => !sp.has(id));
  }
  // Kept off everywhere: a channel left with nothing (say, the excluded show's own) goes away.
  const gShows = new Set(global.shows ?? []);
  const gGenres = new Set((global.genres ?? []).map(slug));
  if (gShows.size || gGenres.size) {
    ids = ids.filter((id) => {
      const i = info(id);
      return !(i?.showKey && gShows.has(i.showKey)) && !i?.genres?.some((g) => gGenres.has(slug(g)));
    });
    if (!ids.length) return null;
  }
  const shows = new Set(st.exclude?.shows ?? []);
  const genres = new Set((st.exclude?.genres ?? []).map(slug));
  if (shows.size || genres.size) {
    const kept = ids.filter((id) => {
      const i = info(id);
      return !(i?.showKey && shows.has(i.showKey)) && !i?.genres?.some((g) => genres.has(slug(g)));
    });
    if (kept.length) ids = kept;
  }
  if (st.watched === "unwatched") {
    const kept = ids.filter((id) => !info(id)?.watched);
    if (kept.length) ids = kept;
  } else if (st.watched === "resume") ids = resumeOrder(ids, info);
  return ids === r.itemIds ? r : { ...r, itemIds: ids };
}

/** Each show's episodes rotated to start after its last watched one, in the same slots of the list. */
function resumeOrder(ids: string[], info: (id: string) => ItemInfo | undefined): string[] {
  const groups = new Map<string, number[]>();
  ids.forEach((id, i) => {
    const k = info(id)?.showKey ?? `__${id}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const out = ids.slice();
  for (const pos of groups.values()) {
    const eps = pos.map((i) => ids[i]!);
    let last = -1;
    eps.forEach((id, i) => info(id)?.watched && (last = i));
    const start = last + 1 >= eps.length ? 0 : last + 1;
    pos.forEach((p, i) => (out[p] = eps[(start + i) % eps.length]!));
  }
  return out;
}

/** Weights, balance, marathons, premieres and reshuffles as the clock takes them. */
export function mixRules(st: ChannelSettings, r: Rule, info: (id: string) => ItemInfo | undefined): Pick<ChannelRevision, "mix" | "seed"> {
  const seed = st.reshuffle ? `${r.key}~${st.reshuffle}` : r.key;
  const premieres = st.premieres ? r.itemIds.filter((id) => info(id)?.recent) : [];
  if (!st.weights && !st.balance && !st.marathons && !premieres.length) return { seed, mix: undefined };
  return {
    seed,
    mix: {
      ...(st.weights ? { weights: st.weights } : {}),
      ...(st.balance === "time" ? { balance: "duration" as const } : {}),
      ...(st.marathons ? { marathon: { chance: 0.03, maxMs: 4 * 60 * MIN } } : {}),
      ...(premieres.length ? { premieres } : {}),
    },
  };
}

/**
 * What a channel's audience and schedule settings mean for the clock. Kid channels
 * get a standing PG limit. Time slots borrow another channel's programs and
 * running order; a slot whose source channel no longer exists is left out.
 * Slots are listed first, so where two overlap the earlier one wins.
 */
export function scheduleRules(st: ChannelSettings, rules: ReadonlyMap<string, Rule>, timeZone: string): Pick<ChannelRevision, "maxRating" | "dayparts"> {
  const out: Pick<ChannelRevision, "maxRating" | "dayparts"> = { maxRating: st.kid ? KID_MAX : undefined, dayparts: undefined };
  const dr: DaypartRule[] = [];
  for (const sl of st.slots ?? []) {
    const src = rules.get(sl.source);
    if (!src || !src.itemIds.length) continue;
    dr.push({ days: sl.days, from: sl.from, to: sl.to, program: { key: src.key, itemIds: src.itemIds, ordering: src.ordering, ...(src.slotMs ? { slotMs: src.slotMs } : {}) },
      ...(sl.dates ? { dates: sl.dates } : {}) });
  }
  for (const rh of st.restrictedHours ?? []) dr.push({ from: rh.from, to: rh.to, maxRating: rh.maxRating as Rating, ...(rh.dates ? { dates: rh.dates } : {}) });
  // Out of season, the whole day is off the air.
  if (st.season) dr.push({ from: "00:00", to: "00:00", dates: st.season, outside: true, offAir: true });
  if (dr.length) out.dayparts = { timeZone, rules: dr } satisfies Dayparts;
  return out;
}

/** Accept only well-formed settings; image logos must be inline (no outside requests). */
export function cleanSettings(v: unknown): ChannelSettings | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const out: ChannelSettings = {};
  if (typeof x.name === "string" && x.name.trim()) out.name = x.name.trim().slice(0, 40);
  if (x.favorite === true) out.favorite = true;
  const logo = cleanLogo(x.logo);
  if (logo) out.logo = logo;
  if (x.kid === true) out.kid = true;
  const rh = cleanRestricted(x.restrictedHours);
  if (rh?.length) out.restrictedHours = rh;
  const sl = cleanSlots(x.slots);
  if (sl?.length) out.slots = sl;
  if (x.specials === true) out.specials = true;
  const w = cleanWeights(x.weights);
  if (w && Object.keys(w).length) out.weights = w;
  if (x.balance === "time") out.balance = "time";
  if (x.marathons === true) out.marathons = true;
  if (x.premieres === true) out.premieres = true;
  if (x.watched === "unwatched" || x.watched === "resume") out.watched = x.watched;
  const ex = cleanExclusions(x.exclude);
  if (ex && (ex.shows?.length || ex.genres?.length)) out.exclude = ex;
  if (typeof x.reshuffle === "number" && Number.isInteger(x.reshuffle) && x.reshuffle > 0) out.reshuffle = x.reshuffle;
  if (x.locked === true) out.locked = true;
  const season = cleanDates(x.season);
  if (season) out.season = season;
  return out;
}

export function cleanWeights(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    if (!WEIGHT_KEYS.test(k) || typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) return null;
    if (Math.round(n) !== 50) out[k] = Math.round(n);
  }
  return out;
}

export function cleanExclusions(v: unknown): Exclusions | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const list = (a: unknown) => (Array.isArray(a) && a.every((s) => typeof s === "string") ? [...new Set((a as string[]).map((s) => s.trim().slice(0, 200)).filter(Boolean))].slice(0, 500) : a === undefined ? [] : null);
  const shows = list(x.shows);
  const genres = list(x.genres);
  if (!shows || !genres) return null;
  return { ...(shows.length ? { shows } : {}), ...(genres.length ? { genres } : {}) };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A yearly date range ("MM-DD" both ends), or null. */
export function cleanDates(v: unknown): DateRange | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  return validMonthDay(x.from) && validMonthDay(x.to) ? { from: x.from, to: x.to } : null;
}

export function cleanRestricted(v: unknown): RestrictedHours[] | null {
  if (!Array.isArray(v)) return null;
  const out: RestrictedHours[] = [];
  for (const r of v.slice(0, 8)) {
    const dates = r?.dates == null ? undefined : cleanDates(r.dates);
    if (r && HHMM.test(r.from) && HHMM.test(r.to) && RATINGS.includes(r.maxRating) && dates !== null) out.push({ from: r.from, to: r.to, maxRating: r.maxRating, ...(dates ? { dates } : {}) });
    else return null;
  }
  return out;
}

export function cleanSlots(v: unknown): TimeSlot[] | null {
  if (!Array.isArray(v)) return null;
  const out: TimeSlot[] = [];
  for (const t of v.slice(0, 50)) {
    const days = Array.isArray(t?.days) ? [...new Set<number>(t.days.filter((d: unknown) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7))].sort() : [];
    const dates = t?.dates == null ? undefined : cleanDates(t.dates);
    if (!days.length || !HHMM.test(t.from) || !HHMM.test(t.to) || typeof t.source !== "string" || !t.source || dates === null) return null;
    out.push({ days, from: t.from, to: t.to, source: t.source.slice(0, 200), ...(dates ? { dates } : {}) });
  }
  return out;
}

export function cleanLogo(v: unknown): ChannelLogo | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  if ((l.kind === "badge" || l.kind === "text") && typeof l.text === "string" && l.text.trim()) {
    const hue = typeof l.hue === "number" && Number.isFinite(l.hue) ? Math.round(((l.hue % 360) + 360) % 360) : undefined;
    const style = l.style === "block" || l.style === "outline" || l.style === "pill" ? l.style : undefined;
    return { kind: l.kind, text: l.text.trim().slice(0, 6), ...(hue != null ? { hue } : {}), ...(style ? { style } : {}) };
  }
  if (l.kind === "image" && typeof l.url === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(l.url) && l.url.length <= 300_000)
    return { kind: "image", url: l.url };
  return null;
}

function nextNumber(numbers: Record<string, number>, preferred?: number): number {
  const used = new Set(Object.values(numbers));
  if (preferred && !used.has(preferred)) return preferred;
  let n = preferred ?? 2;
  while (used.has(n)) n++;
  return n;
}

/** Automatic rules. Without genre metadata, channels are built from what is known for sure. */
/**
 * What channels may air: one copy per episode or film (N-01d), none of a refused
 * title, one show key per show. `keptOf` maps every copy's id to the copy that airs.
 */
export function usableLibrary(items: LibItem[], idsOf: IdsOf = nfoIds): { usable: LibItem[]; keptOf: Map<string, string>; showOf: (k: string) => string } {
  // Every present copy takes part in matching, so a copy a provider refused keeps its title off the air (E6).
  const copyGroups = dedupeGroups(
    items.filter((i) => i.present && !i.excluded && i.parsed.kind !== "other"),
    idsOf,
    airable,
  ).filter((g) => g.keep && !g.refused);
  // A pick made on any copy (custom channels, groups) means the copy that airs.
  const keptOf = new Map(copyGroups.flatMap((g) => g.copies.map((c) => [c.id, g.keep!.id] as const)));
  // Counted over every copy, so the channel keeps its name whichever copy airs.
  const aliases = showAliases(copyGroups.flatMap((g) => g.copies), idsOf);
  const usable = copyGroups.map((g) => {
    const i = g.keep!;
    const a = i.parsed.kind === "episode" ? aliases.get(i.parsed.showKey) : undefined;
    return a && i.parsed.kind === "episode" && a.key !== i.parsed.showKey ? { ...i, parsed: { ...i.parsed, showKey: a.key, show: a.name } } : i;
  });
  return { usable, keptOf, showOf: (k: string) => aliases.get(k)?.key ?? k };
}

/** Automatic rules. Without genre metadata, channels are built from what is known for sure. */
export function autoRules(items: LibItem[], custom: CustomChannel[], groups: ContentGroup[] = [], idsOf: IdsOf = nfoIds): Rule[] {
  const { usable, keptOf, showOf } = usableLibrary(items, idsOf);
  const rules: Rule[] = [];
  const eps = usable.filter((i) => i.parsed.kind === "episode");
  const movies = usable.filter((i) => i.parsed.kind === "movie");

  // One channel per show with enough episodes to carry a day.
  const byShow = new Map<string, LibItem[]>();
  for (const e of eps) if (e.parsed.kind === "episode") byShow.set(e.parsed.showKey, [...(byShow.get(e.parsed.showKey) ?? []), e]);
  const shows = [...byShow.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of shows) {
    if (list.length < 6) continue;
    const first = list[0]!.parsed;
    const med = median(list.map((i) => i.durationMs!));
    rules.push({
      key: `show:${key}`,
      name: first.kind === "episode" ? first.show : key,
      kind: "show",
      tagline: `${list.length} episodes, in order`,
      itemIds: sortEpisodes(list).map((i) => i.id),
      ordering: "cyclic",
      slotMs: slotFor(med),
      preferredNumber: 10,
    });
  }

  const shorts = eps.filter((i) => i.durationMs! <= 15 * MIN);
  if (shorts.length >= 8)
    rules.push({ key: "mix:shorts", name: "Quarter Hour", kind: "mix", tagline: "Short episodes, back to back",
      itemIds: sortEpisodes(shorts).map((i) => i.id), ordering: "round-robin-cyclic", slotMs: 15 * MIN, preferredNumber: 6 });
  const half = eps.filter((i) => i.durationMs! > 15 * MIN && i.durationMs! <= 35 * MIN);
  if (half.length >= 8)
    rules.push({ key: "mix:half-hour", name: "The Half Hour", kind: "mix", tagline: "Half-hour shows, taking turns",
      itemIds: sortEpisodes(half).map((i) => i.id), ordering: "round-robin-cyclic", slotMs: 30 * MIN, preferredNumber: 2 });
  const hour = eps.filter((i) => i.durationMs! > 35 * MIN && i.durationMs! <= 80 * MIN);
  if (hour.length >= 6)
    rules.push({ key: "mix:hour", name: "Prime Hour", kind: "mix", tagline: "Hour-long shows, taking turns",
      itemIds: sortEpisodes(hour).map((i) => i.id), ordering: "round-robin-cyclic", slotMs: 60 * MIN, preferredNumber: 3 });
  if (eps.length >= 12)
    rules.push({ key: "mix:marathon", name: "Marathon", kind: "mix", tagline: "Long runs of one show at a time",
      itemIds: sortEpisodes(eps).map((i) => i.id), ordering: "marathon-cyclic", slotMs: 30 * MIN, preferredNumber: 4 });
  if (movies.length >= 4)
    rules.push({ key: "movies:all", name: "Feature Presentation", kind: "movies", tagline: "Movies, all day",
      itemIds: movies.map((i) => i.id).sort(), ordering: "shuffle", slotMs: 30 * MIN, preferredNumber: 5 });

  const byDecade = new Map<number, LibItem[]>();
  for (const m of movies)
    if (m.parsed.kind === "movie" && m.parsed.year) {
      const d = Math.floor(m.parsed.year / 10) * 10;
      byDecade.set(d, [...(byDecade.get(d) ?? []), m]);
    }
  for (const [d, list] of [...byDecade.entries()].sort((a, b) => a[0] - b[0]))
    if (list.length >= 5)
      rules.push({ key: `movies:${d}s`, name: `${decadeName(d)} Cinema`, kind: "movies", tagline: `Films from the ${String(d).slice(2)}s`,
        itemIds: list.map((i) => i.id).sort(), ordering: "shuffle", slotMs: 30 * MIN });

  const groupIds = new Map(groups.map((g) => [g.id, groupItems(g, eps, movies, showOf, keptOf)]));
  for (const c of custom) {
    const showKeys = new Set(c.showKeys.map(showOf));
    const movieIds = new Set(c.movieIds.map((id) => keptOf.get(id) ?? id));
    const ids = [...new Set([
      ...sortEpisodes(eps.filter((e) => e.parsed.kind === "episode" && showKeys.has(e.parsed.showKey))).map((i) => i.id),
      ...movies.filter((m) => movieIds.has(m.id)).map((m) => m.id),
      ...(c.groupIds ?? []).flatMap((g) => groupIds.get(g) ?? []),
    ])];
    if (ids.length)
      rules.push({ key: `custom:${c.id}`, name: c.name, kind: "custom", tagline: "Your channel", itemIds: ids, ordering: c.ordering,
        slotMs: c.slotMinutes ? c.slotMinutes * MIN : undefined, preferredNumber: 50 });
  }
  rules.push(...metadataRules(usable));
  // Coming Attractions (N-23c): local trailers back to back, shuffled. Local files only, so no provider bytes.
  const trailers = items.filter((i) => i.present && !i.excluded && i.durationMs && airsAsExtra(i) && i.trailer);
  if (trailers.length >= 3)
    rules.push({ key: "trailers:local", name: "Coming Attractions", kind: "trailers", tagline: `${trailers.length} trailers from your films`,
      itemIds: trailers.map((i) => i.id).sort(), ordering: "shuffle", preferredNumber: 8 });
  rules.push(...musicRules(items.filter((i) => i.present && !i.excluded && i.durationMs && airsAsExtra(i) && i.track)));
  for (const g of groups) {
    const ids = groupIds.get(g.id)!;
    if (!ids.length) continue;
    const shows = g.entries.filter((e) => e.kind === "show").length;
    const films = g.entries.length - shows;
    rules.push({ key: `group:${g.id}`, name: g.name, kind: "group",
      tagline: g.description?.split(/(?<=[.!?])\s/)[0]?.slice(0, 80) || [shows && `${shows} show${shows > 1 ? "s" : ""}`, films && `${films} film${films > 1 ? "s" : ""}`].filter(Boolean).join(", "),
      itemIds: ids, ordering: g.ordering, slotMs: 30 * MIN, preferredNumber: 60, ...(g.channel ? {} : { sourceOnly: true }) });
  }

  // Mid-program breaks where the files have chapters, sized so no program spills into an extra slot.
  const byId = new Map(usable.map((i) => [i.id, i]));
  for (const r of rules) {
    const sp = r.itemIds.filter((id) => { const p = byId.get(id)?.parsed; return p?.kind === "episode" && p.season === 0; });
    if (sp.length) r.specialIds = sp;
  }
  for (const r of rules) if (r.slotMs && r.kind !== "movies") r.midBreakMs = midBreakFor(r.itemIds.map((id) => byId.get(id)!), r.slotMs);
  return rules;
}

const HOURS = 3_600_000;

/**
 * Music channels from local audio (N-23a): a Jukebox of everything (5+ tracks,
 * artists taking turns), and a station per genre with 15+ tracks and an hour of
 * music (#91+). Songs play back to back; the player shows a visualiser.
 */
export function musicRules(tracks: LibItem[]): Rule[] {
  if (tracks.length < 5) return [];
  const ids = (list: LibItem[]) => list.map((i) => i.id).sort();
  const artists = new Set(tracks.map((t) => t.track?.artist?.toLowerCase() ?? "")).size;
  const rules: Rule[] = [{ key: "music:all", name: "Jukebox", kind: "music", tagline: `${tracks.length} songs${artists > 1 ? `, ${artists} artists` : ""}`,
    itemIds: ids(tracks), ordering: artists > 1 ? "round-robin-shuffle" : "shuffle", preferredNumber: 90 }];
  const byGenre = new Map<string, { name: string; list: LibItem[] }>();
  for (const t of tracks) {
    const g = t.track?.genre?.trim();
    if (!g) continue;
    const k = slug(g);
    const e = byGenre.get(k) ?? { name: g, list: [] };
    e.list.push(t);
    byGenre.set(k, e);
  }
  for (const [k, g] of [...byGenre].sort((a, b) => b[1].list.length - a[1].list.length).slice(0, 8))
    if (g.list.length >= 15 && g.list.reduce((n, i) => n + i.durationMs!, 0) >= HOURS)
      rules.push({ key: `music:${k}`, name: `${g.name} Radio`, kind: "music", tagline: `${g.list.length} ${g.name} songs`, itemIds: ids(g.list), ordering: "shuffle", preferredNumber: 91 });
  return rules;
}

/**
 * Network, genre and collection channels from metadata the viewer's own files
 * carry (.nfo, parity N-04 / N-01c). Nothing is looked up online.
 *
 *   network     3+ shows from one studio/network, shows taking turns in short runs   (#20+)
 *   genre       2+ titles and 8+ hours in one genre, shows and films mixed           (#30+)
 *   collection  3+ films in one set, in release order                                (#40+)
 */
export function metadataRules(usable: LibItem[]): Rule[] {
  const rules: Rule[] = [];
  const titleOf = (i: LibItem) => (i.parsed.kind === "episode" ? `s:${i.parsed.showKey}` : i.id);
  const hours = (list: LibItem[]) => list.reduce((n, i) => n + (i.durationMs ?? 0), 0) / HOURS;

  const groups = (pick: (i: LibItem) => string[] | undefined) => {
    const out = new Map<string, { name: string; items: LibItem[] }>();
    for (const i of usable)
      for (const name of pick(i) ?? []) {
        const key = slug(name);
        if (!key) continue;
        const g = out.get(key) ?? { name, items: [] };
        g.items.push(i);
        out.set(key, g);
      }
    return [...out.entries()];
  };
  const showCount = (list: LibItem[]) => new Set(list.filter((i) => i.parsed.kind === "episode").map(titleOf)).size;

  for (const [key, g] of groups((i) => (i.parsed.kind === "episode" ? i.meta?.studios?.slice(0, 1) : undefined)).sort((a, b) => b[1].items.length - a[1].items.length).slice(0, 12)) {
    const shows = showCount(g.items);
    if (shows < 3) continue;
    rules.push({ key: `network:${key}`, name: g.name, kind: "mix", tagline: `${shows} ${g.name} shows, taking turns`,
      itemIds: sortEpisodes(g.items).map((i) => i.id), ordering: "block-cyclic", slotMs: 30 * MIN, preferredNumber: 20 });
  }

  const genreOf = (i: LibItem) => i.meta?.genres ?? (i.genre ? [i.genre] : undefined);
  for (const [key, g] of groups(genreOf).sort((a, b) => hours(b[1].items) - hours(a[1].items)).slice(0, 12)) {
    const titles = new Set(g.items.map(titleOf)).size;
    if (titles < 2 || hours(g.items) < 8) continue;
    const eps = g.items.filter((i) => i.parsed.kind === "episode");
    const films = g.items.filter((i) => i.parsed.kind === "movie");
    const what = eps.length && films.length ? "shows and films" : films.length ? "films" : "shows";
    rules.push({ key: `genre:${key}`, name: g.name, kind: films.length && !eps.length ? "movies" : "mix", tagline: `${g.name} ${what}`,
      itemIds: [...sortEpisodes(eps).map((i) => i.id), ...films.map((i) => i.id).sort()], ordering: "block-shuffle", slotMs: 30 * MIN, preferredNumber: 30 });
  }

  for (const [key, g] of groups((i) => (i.parsed.kind === "movie" && i.meta?.collection ? [i.meta.collection] : undefined))) {
    if (g.items.length < 3) continue;
    const year = (i: LibItem) => i.meta?.year ?? (i.parsed.kind === "movie" ? i.parsed.year : undefined) ?? 9999;
    const sorted = g.items.slice().sort((a, b) => year(a) - year(b) || a.id.localeCompare(b.id));
    const name = /collection$/i.test(g.name) ? g.name : `${g.name} Collection`;
    rules.push({ key: `collection:${key}`, name, kind: "movies", tagline: `${g.items.length} films, in order`,
      itemIds: sorted.map((i) => i.id), ordering: "cyclic", slotMs: 30 * MIN, preferredNumber: 40 });
  }
  return rules;
}

/**
 * Seasonal presets (N-02a) on top of seasonal channels (N-32): a ready-made
 * content group with its own channel, on the air only between its dates. Offered
 * only when the library has enough matching titles, by genre or tag from the
 * viewer's .nfo files, or a holiday word in a film's or show's name.
 */
export interface SeasonalPreset {
  id: string;
  name: string;
  description: string;
  season: DateRange;
  genres: string[];
  words?: RegExp;
  ordering: Ordering;
}

export const SEASONAL_PRESETS: SeasonalPreset[] = [
  { id: "s-october-horror", name: "October Horror", season: { from: "10-01", to: "10-31" }, genres: ["horror", "halloween"], words: /\bhalloween\b/i,
    ordering: "block-shuffle", description: "Horror shows and films every day in October. Off the air the rest of the year." },
  { id: "s-holidays", name: "Holiday Classics", season: { from: "12-01", to: "12-31" }, genres: ["christmas", "holiday", "holidays", "xmas"],
    words: /\b(christmas|xmas|holiday|holidays|santa|grinch|noel|nutcracker|scrooge)\b/i,
    ordering: "block-shuffle", description: "Christmas and holiday programs all through December." },
  { id: "s-summer", name: "Summer Adventures", season: { from: "06-21", to: "09-01" }, genres: ["adventure"],
    ordering: "shuffle", description: "Adventure shows and films from midsummer to the start of September." },
];
/** A preset is offered from this many matching titles and hours. */
export const PRESET_MIN_TITLES = 3;
export const PRESET_MIN_HOURS = 3;

/** Which shows and films a preset would air from a usable library. */
export function presetMatches(p: SeasonalPreset, usable: LibItem[]): { entries: GroupEntry[]; shows: number; films: number; hours: number } {
  const want = new Set(p.genres);
  const hit = (i: LibItem) => {
    const labels = [...(i.meta?.genres ?? (i.genre ? [i.genre] : [])), ...(i.meta?.tags ?? [])].map((g) => g.toLowerCase().trim());
    if (labels.some((g) => want.has(g))) return true;
    const name = i.parsed.kind === "episode" ? i.parsed.show : i.parsed.kind === "movie" ? i.parsed.title : "";
    return !!p.words && p.words.test(name);
  };
  const shows = new Map<string, number>();
  const films: LibItem[] = [];
  const byShow = new Map<string, LibItem[]>();
  for (const i of usable) if (i.parsed.kind === "episode") byShow.set(i.parsed.showKey, [...(byShow.get(i.parsed.showKey) ?? []), i]);
  for (const [key, eps] of byShow) if (eps.some(hit)) shows.set(key, eps.reduce((n, e) => n + (e.durationMs ?? 0), 0));
  for (const i of usable) if (i.parsed.kind === "movie" && hit(i)) films.push(i);
  const year = (i: LibItem) => (i.parsed.kind === "movie" ? i.parsed.year : undefined) ?? 9999;
  films.sort((a, b) => year(a) - year(b) || a.id.localeCompare(b.id));
  const ms = [...shows.values()].reduce((n, x) => n + x, 0) + films.reduce((n, f) => n + (f.durationMs ?? 0), 0);
  return {
    entries: [...[...shows.keys()].sort().map((key) => ({ kind: "show" as const, key })), ...films.map((f) => ({ kind: "movie" as const, id: f.id }))],
    shows: shows.size, films: films.length, hours: Math.round(ms / 360_000) / 10,
  };
}

/** A group's programs: each show's episodes in order, each film, in the group's entry order; nothing twice. */
export function groupItems(g: ContentGroup, eps: LibItem[], movies: LibItem[], showOf = (k: string) => k, keptOf = new Map<string, string>()): string[] {
  const out = new Set<string>();
  for (const e of g.entries) {
    if (e.kind === "show") for (const i of sortEpisodes(eps.filter((x) => x.parsed.kind === "episode" && x.parsed.showKey === showOf(e.key)))) out.add(i.id);
    else {
      const id = keptOf.get(e.id) ?? e.id;
      if (movies.some((m) => m.id === id)) out.add(id);
    }
  }
  return [...out];
}

const GROUP_ID = /^[\w-]{1,20}$/;

/** Accept a well-formed group, or null. Unknown shows and films are kept: they air once they're in the library. */
export function cleanGroup(v: unknown, id?: string): ContentGroup | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const name = typeof x.name === "string" ? x.name.trim().slice(0, 40) : "";
  if (!name || !Array.isArray(x.entries)) return null;
  const entries: GroupEntry[] = [];
  const seen = new Set<string>();
  for (const e of x.entries.slice(0, 2000)) {
    const k = e?.kind === "show" && typeof e.key === "string" && e.key ? `s:${e.key.slice(0, 200)}` : e?.kind === "movie" && typeof e.id === "string" && e.id ? `m:${e.id.slice(0, 200)}` : null;
    if (!k) return null;
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push(k.startsWith("s:") ? { kind: "show", key: k.slice(2) } : { kind: "movie", id: k.slice(2) });
  }
  const gid = id ?? (typeof x.id === "string" ? x.id : undefined);
  if (gid !== undefined && !GROUP_ID.test(gid)) return null;
  const description = typeof x.description === "string" ? x.description.trim().slice(0, 500) : "";
  return {
    id: gid ?? Math.random().toString(36).slice(2, 9),
    name,
    ...(description ? { description } : {}),
    entries,
    ordering: ORDERINGS.includes(x.ordering as Ordering) ? (x.ordering as Ordering) : "cyclic",
    ...(x.channel === true ? { channel: true } : {}),
  };
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/** Longest break (2, 1.5 or 1 min) that keeps every program within the slots it takes anyway. */
export function midBreakFor(items: LibItem[], slotMs: number): number | undefined {
  const withBps = items.map((i) => ({ d: i.durationMs!, n: breakpoints(i).length }));
  if (!withBps.some((x) => x.n > 0)) return undefined;
  for (const mb of [120_000, 90_000, 60_000])
    if (withBps.every(({ d, n }) => Math.ceil((d + n * mb) / slotMs) === Math.ceil(d / slotMs))) return mb;
  return undefined;
}

/** A film's or show's database ids as known on this PC (.nfo, TMDB cache); for an episode, its show's. */
export type IdsOf = (i: LibItem) => ExternalIds | undefined;
export const nfoIds: IdsOf = (i) => (i.parsed.kind === "episode" ? i.meta?.showIds : i.parsed.kind === "movie" ? i.meta?.ids : undefined);

/** Every copy of one episode or film, and the one that airs. */
export interface CopyGroup {
  /** The copy channels use; null when no copy is usable yet. */
  keep: LibItem | null;
  /** All copies, the kept one first. */
  copies: LibItem[];
  /** A provider refused one of these copies: the title stays off the air, never fetched elsewhere. */
  refused: boolean;
}

/** A copy that may go on the air: finished at its provider, timed, not refused. */
export const airable = (i: LibItem) => i.ready !== false && !!i.durationMs && i.availability !== "policy-blocked";

const ID_KINDS = ["tmdb", "imdb", "tvdb"] as const;

/** Two cuts of one title are different programs (D4); PAL speed-up (4%) and re-encodes are not. */
function sameCut(a: LibItem, b: LibItem): boolean {
  if (a.durationMs == null || b.durationMs == null) return true;
  return Math.abs(a.durationMs - b.durationMs) <= Math.max(2 * MIN, 0.05 * Math.max(a.durationMs, b.durationMs));
}

/**
 * The same episode or film from several places (gate D3, parity N-01d). Copies
 * match on a TMDB, IMDb or TVDB id when the .nfo or the TMDB cache knows one,
 * else on the parsed name (show + season + episode, or title + year). Names never
 * join two copies whose ids disagree, and cuts with other runtimes stay apart
 * (D4). Only local facts are used: nothing is fetched to decide.
 *
 * The kept copy: local first, then whichever is known playable, then TorBox
 * (LIVE-001: fewer refusals so far), then Real-Debrid. `usable` says which copies
 * may air (finished, timed).
 */
export function dedupeGroups(items: LibItem[], idsOf: IdsOf = nfoIds, usable: (i: LibItem) => boolean = () => true): CopyGroup[] {
  const rank = (i: LibItem) =>
    (i.provider === "local" ? 0 : 10) + (i.availability === "playable" ? 0 : 5) + (i.provider === "torbox" ? 0 : i.provider === "realdebrid" ? 1 : 2);
  const parent = items.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  const ids = items.map((i) => idsOf(i));
  const clash = (a: number, b: number) => ID_KINDS.some((k) => ids[a]?.[k] && ids[b]?.[k] && ids[a]![k] !== ids[b]![k]);
  const byKey = new Map<string, number[]>();
  items.forEach((i, k) => {
    const p = i.parsed;
    if (p.kind !== "episode" && p.kind !== "movie") return;
    const tail = p.kind === "episode" ? `|${p.season}|${p.episode}` : "";
    const keys = ID_KINDS.flatMap((t) => (ids[k]?.[t] ? [`${p.kind[0]}|${t}:${ids[k]![t]}${tail}`] : []));
    keys.push(p.kind === "episode" ? `e|${p.showKey}${tail}` : `m|${p.titleKey}|${p.year ?? ""}`);
    for (const key of keys) {
      const list = byKey.get(key) ?? [];
      const other = list.find((o) => sameCut(items[o]!, i) && !clash(o, k));
      if (other != null) parent[find(k)] = find(other);
      list.push(k);
      byKey.set(key, list);
    }
  });
  const groups = new Map<number, LibItem[]>();
  items.forEach((i, k) => groups.set(find(k), [...(groups.get(find(k)) ?? []), i]));
  return [...groups.values()].map((list) => {
    const copies = list.slice().sort((a, b) => Number(usable(b)) - Number(usable(a)) || rank(a) - rank(b) || a.id.localeCompare(b.id));
    const keep = usable(copies[0]!) ? copies[0]! : null;
    return { keep, copies, refused: copies.some((c) => c.availability === "policy-blocked") };
  });
}

/** One copy per episode or film (see dedupeGroups); titles a provider refused are left out entirely. */
export function dedupe(items: LibItem[], idsOf: IdsOf = nfoIds): LibItem[] {
  return dedupeGroups(items, idsOf).flatMap((g) => (g.keep && !g.refused ? [g.keep] : []));
}

/**
 * One show under two names ("The Office" and "The Office (US)") when their ids
 * agree: every name maps to the one with the most episodes, so it gets one
 * channel, in episode order.
 */
export function showAliases(eps: LibItem[], idsOf: IdsOf = nfoIds): Map<string, { key: string; name: string }> {
  const count = new Map<string, { n: number; name: string }>();
  const byId = new Map<string, Set<string>>();
  for (const e of eps) {
    if (e.parsed.kind !== "episode") continue;
    const k = e.parsed.showKey;
    count.set(k, { n: (count.get(k)?.n ?? 0) + 1, name: e.parsed.show });
    const ids = idsOf(e);
    for (const t of ID_KINDS) if (ids?.[t]) byId.set(`${t}:${ids[t]}`, (byId.get(`${t}:${ids[t]}`) ?? new Set()).add(k));
  }
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    return p === k ? k : (parent.set(k, find(p)), parent.get(k)!);
  };
  for (const keys of byId.values()) {
    const [first, ...rest] = [...keys];
    for (const k of rest) parent.set(find(k), find(first!));
  }
  const members = new Map<string, string[]>();
  for (const k of count.keys()) members.set(find(k), [...(members.get(find(k)) ?? []), k]);
  const out = new Map<string, { key: string; name: string }>();
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const best = list.slice().sort((a, b) => count.get(b)!.n - count.get(a)!.n || a.localeCompare(b))[0]!;
    for (const k of list) out.set(k, { key: best, name: count.get(best)!.name });
  }
  return out;
}

export function sortEpisodes(list: LibItem[]): LibItem[] {
  return list.slice().sort((a, b) => {
    const pa = a.parsed, pb = b.parsed;
    if (pa.kind !== "episode" || pb.kind !== "episode") return 0;
    // Season 0 (specials) sorts after the regular seasons.
    const sa = pa.season === 0 ? 1e6 : pa.season, sb = pb.season === 0 ? 1e6 : pb.season;
    return pa.showKey.localeCompare(pb.showKey) || sa - sb || pa.episode - pb.episode || a.id.localeCompare(b.id);
  });
}

/** Smallest familiar TV slot that fits a typical episode (11-min cartoons get 15). */
function slotFor(medianMs: number): number {
  for (const m of [15, 30, 60, 90, 120]) if (medianMs <= m * MIN) return m * MIN;
  return 30 * MIN;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function decadeName(d: number): string {
  const names: Record<number, string> = { 1950: "Fifties", 1960: "Sixties", 1970: "Seventies", 1980: "Eighties", 1990: "Nineties", 2000: "Two-Thousands", 2010: "Twenty-Tens", 2020: "Twenty-Twenties" };
  return names[d] ?? `${d}s`;
}
