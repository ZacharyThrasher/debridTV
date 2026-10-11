// Channel lineup: rules over the library, never content acquisition (parity N-02).
// Rules are re-evaluated as the library grows, but a channel only changes through
// StationClock.revise(), which waits for the current airing to end (gate C7).
// Channel numbers, once given, stay put (N-03).

import { StationClock } from "../src/clock/schedule.ts";
import type { Channel, Ordering } from "../src/clock/types.ts";
import { hash32 } from "../src/clock/rng.ts";
import { ORDERINGS } from "../src/clock/ordering.ts";
import { JsonFile } from "./store.ts";
import { breakpoints, type LibItem } from "./library.ts";

const MIN = 60_000;

export interface ChannelMeta {
  ruleKey: string;
  kind: "show" | "mix" | "movies" | "custom" | "demo";
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
}

interface LineupState {
  channels: StationChannel[];
  numbers: Record<string, number>;
  custom: CustomChannel[];
  hidden: string[];
  /** The viewer's own touches per channel (by rule key), kept across rebuilds. */
  settings?: Record<string, ChannelSettings>;
}

export type ChannelLogo = { kind: "text"; text: string; bg?: string } | { kind: "image"; url: string; bg?: string };

export interface ChannelSettings {
  name?: string;
  favorite?: boolean;
  logo?: ChannelLogo;
}

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

  settingsFor(ruleKey: string): ChannelSettings {
    return this.file.get().settings?.[ruleKey] ?? {};
  }

  /**
   * Rename, renumber, favorite or brand a channel. A number already in use is
   * refused (no silent shuffling of other channels, N-03); `null` clears a field.
   */
  updateSettings(ruleKey: string, patch: { name?: string | null; number?: number; favorite?: boolean; logo?: ChannelLogo | null }): { ok: true } | { ok: false; error: string } {
    const s = this.file.get();
    const ch = s.channels.find((c) => c.meta.ruleKey === ruleKey);
    if (!ch) return { ok: false, error: "no such channel" };
    if (patch.number !== undefined && patch.number !== ch.number) {
      if (!Number.isInteger(patch.number) || patch.number < 1 || patch.number > 9999) return { ok: false, error: "Channel numbers run from 1 to 9999." };
      const holder = s.channels.find((c) => c.number === patch.number);
      if (holder) return { ok: false, error: `${patch.number} is ${holder.name}. Pick a free number.` };
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
    s.settings = { ...s.settings, [ruleKey]: cur };
    if (cur.name) ch.name = cur.name;
    this.file.set(s);
    return { ok: true };
  }

  /** What a settings export carries: choices, not library facts or credentials. */
  exportSettings(): { numbers: Record<string, number>; custom: CustomChannel[]; hidden: string[]; settings: Record<string, ChannelSettings> } {
    const s = this.file.get();
    return { numbers: { ...s.numbers }, custom: s.custom.slice(), hidden: s.hidden.slice(), settings: { ...s.settings } };
  }

  /**
   * Bring back exported choices. Custom channels and hidden flags are merged by id;
   * a remembered number is only taken if nothing here already uses it.
   */
  importSettings(x: { numbers?: unknown; custom?: unknown; hidden?: unknown; settings?: unknown }): { custom: number; hidden: number } {
    let custom = 0;
    let hidden = 0;
    this.file.update((s) => {
      if (Array.isArray(x.custom))
        for (const c of x.custom as CustomChannel[]) {
          if (!c || typeof c.id !== "string" || typeof c.name !== "string" || !Array.isArray(c.showKeys) || !Array.isArray(c.movieIds)) continue;
          s.custom = [...s.custom.filter((y) => y.id !== c.id), {
            id: c.id.slice(0, 20), name: c.name.slice(0, 40), showKeys: c.showKeys.map(String), movieIds: c.movieIds.map(String),
            ordering: ORDERINGS.includes(c.ordering) ? c.ordering : "block-shuffle", slotMinutes: typeof c.slotMinutes === "number" ? c.slotMinutes : 30,
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
      if (x.numbers && typeof x.numbers === "object") {
        const used = new Set(Object.values(s.numbers));
        for (const [k, n] of Object.entries(x.numbers as Record<string, unknown>))
          if (typeof n === "number" && Number.isInteger(n) && n > 0 && !(k in s.numbers) && !used.has(n)) (s.numbers[k] = n), used.add(n);
      }
    });
    return { custom, hidden };
  }

  /** Forget channels, numbers and choices. */
  reset(): void {
    this.file.set({ channels: [], numbers: {}, custom: [], hidden: [] });
  }

  /**
   * Bring channels in line with the rules. New channels start on a past slot
   * boundary so they look like they've been on air all along; existing channels
   * change only at the end of what is airing now.
   */
  sync(clock: StationClock, rules: Rule[], now: number): { added: number; revised: number; removed: number } {
    const s = this.file.get();
    let added = 0;
    let revised = 0;
    const live = new Set(rules.map((r) => r.key));
    const removedBefore = s.channels.length;
    s.channels = s.channels.filter((c) => live.has(c.meta.ruleKey));
    const removed = removedBefore - s.channels.length;

    // Rules that ask for a number go first so they get it on a fresh lineup.
    const ordered = rules.slice().sort((a, b) => (a.preferredNumber ?? 1e9) - (b.preferredNumber ?? 1e9));
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
          revisions: [{ effectiveFromMs: anchor, seed: r.key, itemIds: r.itemIds, ordering: r.ordering, slotMs: r.slotMs, midBreakMs: r.midBreakMs }],
          meta: { ruleKey: r.key, kind: r.kind, hue: hash32(r.key) % 360, tagline: r.tagline },
        });
        added++;
        continue;
      }
      existing.name = s.settings?.[r.key]?.name ?? r.name;
      existing.meta.tagline = r.tagline;
      const cur = existing.revisions[existing.revisions.length - 1]!;
      const same =
        cur.ordering === r.ordering &&
        cur.slotMs === r.slotMs &&
        cur.midBreakMs === r.midBreakMs &&
        cur.itemIds.length === r.itemIds.length &&
        cur.itemIds.every((id, i) => id === r.itemIds[i]);
      if (same) continue;
      const next = clock.revise(existing, now, { itemIds: r.itemIds, ordering: r.ordering, slotMs: r.slotMs, midBreakMs: r.midBreakMs });
      existing.revisions = next.revisions.slice(-6); // keep a short history
      revised++;
    }
    this.file.set(s);
    return { added, revised, removed };
  }
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
  return out;
}

export function cleanLogo(v: unknown): ChannelLogo | null {
  if (!v || typeof v !== "object") return null;
  const l = v as Record<string, unknown>;
  const bg = typeof l.bg === "string" && /^#[0-9a-f]{3,8}$/i.test(l.bg) ? l.bg : undefined;
  if (l.kind === "text" && typeof l.text === "string" && l.text.trim()) return { kind: "text", text: l.text.trim().slice(0, 6), ...(bg ? { bg } : {}) };
  if (l.kind === "image" && typeof l.url === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(l.url) && l.url.length <= 300_000)
    return { kind: "image", url: l.url, ...(bg ? { bg } : {}) };
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
export function autoRules(items: LibItem[], custom: CustomChannel[]): Rule[] {
  const usable = dedupe(
    items.filter(
      (i) => i.present && i.ready !== false && !i.excluded && i.durationMs && i.parsed.kind !== "other" && i.availability !== "policy-blocked",
    ),
  );
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

  for (const c of custom) {
    const ids = [
      ...sortEpisodes(eps.filter((e) => e.parsed.kind === "episode" && c.showKeys.includes(e.parsed.showKey))).map((i) => i.id),
      ...movies.filter((m) => c.movieIds.includes(m.id)).map((m) => m.id),
    ];
    if (ids.length)
      rules.push({ key: `custom:${c.id}`, name: c.name, kind: "custom", tagline: "Your channel", itemIds: ids, ordering: c.ordering,
        slotMs: c.slotMinutes ? c.slotMinutes * MIN : undefined, preferredNumber: 50 });
  }
  // Mid-program breaks where the files have chapters, sized so no program spills into an extra slot.
  const byId = new Map(usable.map((i) => [i.id, i]));
  for (const r of rules) if (r.slotMs && r.kind !== "movies") r.midBreakMs = midBreakFor(r.itemIds.map((id) => byId.get(id)!), r.slotMs);
  return rules;
}

/** Longest break (2, 1.5 or 1 min) that keeps every program within the slots it takes anyway. */
export function midBreakFor(items: LibItem[], slotMs: number): number | undefined {
  const withBps = items.map((i) => ({ d: i.durationMs!, n: breakpoints(i).length }));
  if (!withBps.some((x) => x.n > 0)) return undefined;
  for (const mb of [120_000, 90_000, 60_000])
    if (withBps.every(({ d, n }) => Math.ceil((d + n * mb) / slotMs) === Math.ceil(d / slotMs))) return mb;
  return undefined;
}

/**
 * The same episode on two providers must not air twice as often (gate D3). Keep
 * one copy: local first, then whichever is known playable, then TorBox (LIVE-001:
 * fewer refusals so far), then Real-Debrid. Editions with very different runtimes
 * are kept apart (D4).
 */
function dedupe(items: LibItem[]): LibItem[] {
  const rank = (i: LibItem) =>
    (i.provider === "local" ? 0 : 10) + (i.availability === "playable" ? 0 : 5) + (i.provider === "torbox" ? 0 : i.provider === "realdebrid" ? 1 : 2);
  const best = new Map<string, LibItem>();
  for (const i of items) {
    const p = i.parsed;
    const minutes = Math.round((i.durationMs ?? 0) / (5 * MIN));
    const key =
      p.kind === "episode" ? `e|${p.showKey}|${p.season}|${p.episode}|${minutes}` : p.kind === "movie" ? `m|${p.titleKey}|${p.year ?? ""}|${minutes}` : i.id;
    const cur = best.get(key);
    if (!cur || rank(i) < rank(cur)) best.set(key, i);
  }
  return [...best.values()];
}

function sortEpisodes(list: LibItem[]): LibItem[] {
  return list.slice().sort((a, b) => {
    const pa = a.parsed, pb = b.parsed;
    if (pa.kind !== "episode" || pb.kind !== "episode") return 0;
    return pa.showKey.localeCompare(pb.showKey) || pa.season - pb.season || pa.episode - pb.episode || a.id.localeCompare(b.id);
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
