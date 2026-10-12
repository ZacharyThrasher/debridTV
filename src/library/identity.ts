// Show identity: which shows in a library are one show, whatever the file names
// call them. Release names spell a show many ways: "Dandadan" and "Dan Da Dan",
// "JoJo no Kimyou na Bouken" and "JoJo's Bizarre Adventure", a pack named with
// both, an arc ("Stardust Crusaders") that is really a season, a typo ("Braking
// Bad"). This module turns every spelling into one show with seasons that don't
// collide, and keeps look-alikes apart (Battlestar Galactica 1978 and 2004, The
// Office US and UK, Dragon Ball and Dragon Ball Z).
//
// Pure: no I/O. Works offline from names alone; database ids (a tvshow.nfo or the
// TMDB cache, worked out by the caller) are the strongest key when present, and
// the viewer's own merges and splits beat everything.

import { titleKeyOf } from "./parse.ts";

// ---------------------------------------------------------------------------
// Known titles: romaji and English names of one show, and arcs that are seasons.

/** Canonical name, then other spellings (as title keys). */
const KNOWN: Array<[string, string[]]> = [
  ["JoJo's Bizarre Adventure", ["jojo no kimyou na bouken", "jojo no kimyo na boken", "jojo no kimyou na boken", "jojos bizarre adventures", "jojo s bizarre adventure"]],
  ["Attack on Titan", ["shingeki no kyojin", "shingeki no kyoujin"]],
  ["Demon Slayer: Kimetsu no Yaiba", ["kimetsu no yaiba", "demon slayer"]],
  ["My Hero Academia", ["boku no hero academia", "boku no hiro akademia"]],
  ["Frieren: Beyond Journey's End", ["sousou no frieren", "frieren"]],
  ["Delicious in Dungeon", ["dungeon meshi"]],
  ["Solo Leveling", ["ore dake level up na ken"]],
  ["The Apothecary Diaries", ["kusuriya no hitorigoto"]],
  ["The Promised Neverland", ["yakusoku no neverland"]],
  ["Fullmetal Alchemist: Brotherhood", ["hagane no renkinjutsushi brotherhood", "hagane no renkinjutsushi fullmetal alchemist"]],
  ["Neon Genesis Evangelion", ["shin seiki evangelion", "shinseiki evangelion"]],
  ["That Time I Got Reincarnated as a Slime", ["tensei shitara slime datta ken"]],
  ["Kaguya-sama: Love Is War", ["kaguya sama wa kokurasetai", "kaguya sama wa kokurasetai tensai tachi no renai zunousen"]],
  ["The Dangers in My Heart", ["boku no kokoro no yabai yatsu"]],
  ["Mushoku Tensei: Jobless Reincarnation", ["mushoku tensei", "mushoku tensei isekai ittara honki dasu"]],
  ["Re:ZERO -Starting Life in Another World-", ["re zero kara hajimeru isekai seikatsu", "re zero starting life in another world", "re zero"]],
  ["Assassination Classroom", ["ansatsu kyoushitsu", "ansatsu kyoshitsu"]],
  ["Laid-Back Camp", ["yuru camp"]],
  ["KonoSuba: God's Blessing on This Wonderful World!", ["kono subarashii sekai ni shukufuku wo", "konosuba"]],
  ["The Rising of the Shield Hero", ["tate no yuusha no nariagari"]],
  ["Record of Ragnarok", ["shuumatsu no valkyrie"]],
  ["The Eminence in Shadow", ["kage no jitsuryokusha ni naritakute"]],
  ["Kaiju No. 8", ["kaijuu 8 gou", "kaiju 8 gou", "kaijuu 8gou"]],
  ["Heavenly Delusion", ["tengoku daimakyou"]],
  ["Spice and Wolf", ["ookami to koushinryou", "ookami to koshinryo"]],
  ["Your Lie in April", ["shigatsu wa kimi no uso"]],
  ["Ghost in the Shell: Stand Alone Complex", ["koukaku kidoutai stand alone complex"]],
  ["Haikyu!!", ["haikyuu"]],
  ["Arcane", ["arcane league of legends"]],
  ["The Ancient Magus' Bride", ["mahoutsukai no yome"]],
  ["To Your Eternity", ["fumetsu no anata e"]],
  ["Toilet-bound Hanako-kun", ["jibaku shounen hanako kun"]],
  ["Rascal Does Not Dream of Bunny Girl Senpai", ["seishun buta yarou wa bunny girl senpai no yume wo minai"]],
  ["My Dress-Up Darling", ["sono bisque doll wa koi wo suru"]],
  ["Wotakoi: Love Is Hard for Otaku", ["wotaku ni koi wa muzukashii"]],
  ["The Quintessential Quintuplets", ["gotoubun no hanayome", "5 toubun no hanayome"]],
  ["Code Geass: Lelouch of the Rebellion", ["code geass hangyaku no lelouch"]],
  ["Mobile Suit Gundam: The Witch from Mercury", ["kidou senshi gundam suisei no majo"]],
  ["Blue Exorcist", ["ao no exorcist"]],
  ["The Seven Deadly Sins", ["nanatsu no taizai"]],
  ["Ranking of Kings", ["ousama ranking"]],
  ["Steins;Gate", ["steins gate"]],
  ["Bleach", []],
];

interface ArcRule {
  names: string[];
  season?: number;
  /** Arc-relative episode 1 is this episode + 1 of the season. */
  offset?: number;
}

/** Arcs that are seasons of a show (TMDB's numbering), by the show's title key. */
const ARCS: Record<string, ArcRule[]> = {
  "jojos bizarre adventure": [
    { names: ["phantom blood"], season: 1 },
    { names: ["battle tendency", "sentou chouryuu"], season: 1, offset: 9 },
    { names: ["stardust crusaders egypt", "stardust crusaders battle in egypt", "egypt hen"], season: 2, offset: 24 },
    { names: ["stardust crusaders"], season: 2 },
    { names: ["diamond is unbreakable", "diamond wa kudakenai"], season: 3 },
    { names: ["golden wind", "ougon no kaze", "vento aureo"], season: 4 },
    { names: ["stone ocean"], season: 5 },
  ],
  "attack on titan": [
    { names: ["final chapters", "the final chapters", "kanketsu hen"], season: 4, offset: 28 },
    { names: ["final season", "the final season"], season: 4 },
  ],
  "demon slayer kimetsu no yaiba": [
    { names: ["mugen train arc", "mugen ressha hen"], season: 2 },
    { names: ["entertainment district arc", "yuukaku hen"], season: 2, offset: 7 },
    { names: ["swordsmith village arc", "katanakaji no sato hen"], season: 3 },
    { names: ["hashira training arc", "hashira geiko hen"], season: 4 },
  ],
  bleach: [{ names: ["thousand year blood war", "sennen kessen hen"] }],
};

const ALIAS = new Map<string, string>();
for (const [name, others] of KNOWN) {
  const key = baseKeyOf(name);
  for (const k of [key, ...others.map(baseKeyOf)]) if (!ALIAS.has(k)) ALIAS.set(k, name);
}

// ---------------------------------------------------------------------------
// Names

/** A title key without a leading article: "The Office" and "Office" are one. */
export function baseKeyOf(title: string): string {
  return titleKeyOf(plain(title)).replace(/^(?:the|a|an) (?=\S)/, "");
}

/** Accents off, typographic apostrophes straight. */
function plain(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’‘`´]/g, "'");
}

const COUNTRY = new Set(["US", "UK", "AU", "NZ", "CA", "IE"]);
/** Pack and release words that end up in show names ("COMPLETE SERIES", "Dual Audio"). */
const NOISE = new Set([
  "complete", "completed", "batch", "collection", "dual", "audio", "multi", "multisub", "subs", "sub", "subbed", "dub", "dubbed",
  "eng", "english", "jap", "japanese", "jpn", "vostfr", "raw", "raws", "uncensored", "uncut", "bd", "bdrip", "web", "nf", "cr",
  "amzn", "hevc", "x264", "x265", "10bit", "hi10", "hi10p", "flac", "aac", "remastered", "hd", "sd", "1080p", "720p", "2160p", "4k",
]);
const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

export interface ShowName {
  /** Display name, tidied ("The Office (US)", "Dan Da Dan"). */
  name: string;
  /** Title key without a leading article, with the country ("office us"). */
  base: string;
  /** From a known-titles entry (romaji or another spelling). */
  known: boolean;
  country?: string;
  year?: number;
  /** "2nd Season", "Season 3", "II": the files are this season. */
  season?: number;
  /** An arc or part named after the show ("Stardust Crusaders", "Yuukaku-hen", "Final Season"). */
  arc?: string;
}

/**
 * Read a parsed show name: tidy it, find the known show behind a romaji or
 * alternate title, and split off a season or arc. `year` is the parsed year.
 */
export function readShowName(raw: string, year?: number): ShowName {
  const k = `${raw}|${year ?? ""}`;
  let hit = READ_CACHE.get(k);
  if (!hit) {
    if (READ_CACHE.size > 20_000) READ_CACHE.clear();
    hit = readShowNameUncached(raw, year);
    READ_CACHE.set(k, hit);
  }
  return { ...hit };
}
const READ_CACHE = new Map<string, ShowName>();

function readShowNameUncached(raw: string, year?: number): ShowName {
  let s = plain(raw).replace(/\[[^\]]*\]|\{[^}]*\}/g, " ");
  let country: string | undefined;
  const alts: string[] = [];
  s = s.replace(/\(([^)]*)\)/g, (_m, inner: string) => {
    const t = inner.trim();
    if (/^(19|20)\d\d$/.test(t)) year ??= Number(t);
    else if (COUNTRY.has(t.toUpperCase())) country = t.toUpperCase();
    else if (/[a-z]{3}/i.test(t)) alts.push(t);
    return " ";
  });
  // "The Office US": an upper-case country code at the end of a mixed-case name ("This Is Us" keeps its "Us").
  const cm = /^(.*\S)\s+([A-Z]{2})\s*$/.exec(s.trim());
  if (!country && cm && COUNTRY.has(cm[2]!) && /[a-z]/.test(cm[1]!)) {
    country = cm[2];
    s = cm[1]!;
  }
  const candidates = [...splitAlternates(s), ...alts].map((c) => readCandidate(c)).filter((c) => c.base !== "");
  const pick = candidates.find((c) => c.known) ?? candidates[0] ?? { name: tidyName(raw), base: baseKeyOf(raw), known: false };
  const out: ShowName = { ...pick };
  if (country && !out.known) {
    out.country = country;
    out.base = `${out.base} ${country.toLowerCase()}`;
    out.name = `${out.name} (${country})`;
  }
  if (year) out.year = year;
  return out;
}

/** "A / B", "A | B", "A aka B", and packs named twice: "ENGLISH - ARC ROMAJI - ARC". */
function splitAlternates(s: string): string[] {
  const parts = s.split(/\s+(?:\/|\||aka)\s+/i).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const segs = p.split(/\s+[-–—]\s+/);
    const last = segs[segs.length - 1]!;
    const k = segs.length >= 3 ? segs.findIndex((g, i) => i > 0 && i < segs.length - 1 && g.toLowerCase().startsWith(`${last.toLowerCase()} `)) : -1;
    if (k > 0) {
      out.push(`${segs.slice(0, k).join(" - ")} - ${last}`, `${segs[k]!.slice(last.length).trim()} - ${segs.slice(k + 1).join(" - ")}`);
    } else out.push(p);
  }
  return out;
}

function tidyName(s: string): string {
  const t = plain(s).replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s\-–:]+|[\s\-–:]+$/g, "").trim();
  // ALL CAPS release names read better in title case; mixed case is the author's.
  return /[a-z]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/'S\b/g, "'s");
}

function arcRules(base: string): ArcRule[] {
  return ARCS[base] ?? [];
}

function matchArc(base: string, arcKey: string): ArcRule | undefined {
  return arcRules(base).find((r) => r.names.some((n) => arcKey === n || arcKey.startsWith(`${n} `) || arcKey.endsWith(` ${n}`)));
}

/** Season words at the end of a title key. */
function seasonTail(key: string): { key: string; season?: number; arc?: string } {
  let m = /^(.+?) (?:season|series|saison|staffel|book) (\d{1,2})$/.exec(key);
  if (m) return { key: m[1]!, season: Number(m[2]) };
  m = /^(.+?) (\d{1,2})(?:st|nd|rd|th) season$/.exec(key);
  if (m) return { key: m[1]!, season: Number(m[2]) };
  m = /^(.+?) s(\d{1,2})$/.exec(key);
  if (m) return { key: m[1]!, season: Number(m[2]) };
  m = /^(.+? .+?) (ii|iii|iv|v|vi)$/.exec(key);
  if (m) return { key: m[1]!, season: ROMAN[m[2]!] };
  m = /^(.+?) (?:the )?final season$/.exec(key);
  if (m) return { key: m[1]!, arc: "Final Season" };
  m = /^(.+?) (?:part|cour) (\d)$/.exec(key);
  if (m) return { key: m[1]!, arc: `Part ${m[2]}` };
  return { key };
}

/** Trailing pack words and season ranges ("Complete Batch", "Season 1-3", "S01-S03"). */
function stripNoise(key: string): string {
  let t = key.split(" ");
  for (;;) {
    const n = t.length;
    while (t.length > 1 && (NOISE.has(t[t.length - 1]!) || /^(19|20)\d\d$/.test(t[t.length - 1]!))) t.pop();
    if (t.length > 2 && t[t.length - 1] === "series" && NOISE.has(t[t.length - 2]!)) t.splice(-2);
    const j = t.join(" ");
    const r = /^(.+?) (?:(?:season|seasons) \d{1,2} \d{1,2}|s\d{1,2} s\d{1,2})$/.exec(j);
    if (r) t = r[1]!.split(" ");
    if (t.length === n) return t.join(" ");
  }
}

const isArcWord = (key: string) => / (?:arc|hen|saga)$/.test(key) || /^(?:the )?final (?:season|chapters?)$/.test(key) || /^(?:part|cour) \d$/.test(key);

function readCandidate(c: string): ShowName {
  const segs = c.split(/\s+[-–—]\s+|:\s+/).map((g) => g.trim()).filter(Boolean);
  if (!segs.length) return { name: "", base: "", known: false };
  // Trailing segments that are pack words, a season, or an arc come off; the rest is the title.
  let season: number | undefined;
  let arc: string | undefined;
  while (segs.length > 1) {
    const last = segs[segs.length - 1]!;
    const k = stripNoise(baseKeyOf(last));
    const st = seasonTail(`x ${k}`);
    if (k === "" || NOISE.has(k)) segs.pop();
    else if (st.key === "x" && st.season) (season = st.season, segs.pop());
    else if (isArcWord(k) || matchArc(knownBase(baseKeyOf(segs.slice(0, -1).join(" "))) ?? "", k)) (arc = tidyName(last), segs.pop());
    else break;
  }
  const titleRaw = segs.join(" - ");
  let key = stripNoise(baseKeyOf(titleRaw));
  const st = seasonTail(key);
  if (st.season || st.arc) {
    key = st.key;
    season ??= st.season;
    arc ??= st.arc;
  }
  // Known title, whole or as a prefix ("JoJo's Bizarre Adventure Stardust Crusaders").
  const whole = ALIAS.get(key) ?? ALIAS.get(key.replace(/ /g, ""));
  if (whole) return withArc({ name: whole, base: baseKeyOf(whole), known: true }, season, arc);
  const words = key.split(" ");
  for (let n = words.length - 1; n >= 1; n--) {
    const head = words.slice(0, n).join(" ");
    const known = ALIAS.get(head);
    if (!known) continue;
    const rest = words.slice(n).join(" ");
    const base = baseKeyOf(known);
    const rt = seasonTail(`x ${rest}`);
    if (matchArc(base, rest) || isArcWord(rest)) return withArc({ name: known, base, known: true }, season, arc ?? tidyName(rest));
    if (rt.key === "x" && rt.season) return withArc({ name: known, base, known: true }, season ?? rt.season, arc);
    if (ALIAS.get(rest) === known) return withArc({ name: known, base, known: true }, season, arc);
  }
  // Display: the title as written, minus what came off the key.
  let name = tidyName(titleRaw);
  const nameKey = baseKeyOf(name);
  if (nameKey !== key) {
    const keep = key.split(" ").length + (titleKeyOf(plain(name)).split(" ").length - nameKey.split(" ").length);
    name = tidyName(name.split(/\s+/).slice(0, keep).join(" "));
    if (baseKeyOf(name) !== key) name = tidyName(key);
  }
  return withArc({ name, base: key, known: false }, season, arc);
}

function knownBase(key: string): string | undefined {
  const k = ALIAS.get(key);
  return k ? baseKeyOf(k) : key;
}

function withArc(n: ShowName, season?: number, arc?: string): ShowName {
  if (season) n.season = season;
  if (arc) n.arc = arc;
  return n;
}

// ---------------------------------------------------------------------------
// Spelling

/** Optimal string alignment distance (Levenshtein plus swapped neighbours). */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Two title keys that are one title spelled differently: the same letters with
 * other spacing ("dandadan" / "dan da dan"), or the same words with a slip in one
 * or two long ones ("braking bad", "jojos bizarre adventures"). Short names,
 * different numbers, a changed first letter or an extra word never match
 * ("lost"/"last", "fargo"/"cargo", "dragon ball"/"dragon ball z").
 */
export function sameSpelling(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = a.replace(/ /g, ""), cb = b.replace(/ /g, "");
  if (ca === cb) return ca.length >= 4;
  if (Math.min(ca.length, cb.length) < 8) return false;
  const ta = a.split(" "), tb = b.split(" ");
  if (ta.length !== tb.length) return false;
  if ((a.match(/\d+/g) ?? []).join() !== (b.match(/\d+/g) ?? []).join()) return false;
  let slips = 0;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i]!, y = tb[i]!;
    if (x === y) continue;
    // Four-letter words may slip only inside a long, many-word title ("better caul saul").
    const min = ca.length >= 12 && ta.length >= 3 ? 4 : 5;
    if (x.length < min || y.length < min || x[0] !== y[0] || editDistance(x, y, 1) > 1) return false;
    slips++;
  }
  return slips <= (ca.length >= 16 ? 2 : 1);
}

// ---------------------------------------------------------------------------
// Grouping

export interface ExternalIdsLite {
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
}

/** Every file of one parsed show name (and year). */
export interface ShowUnit {
  /** `${showKey}|${year}`: the parser's key, so the same name in two years stays two units. */
  id: string;
  /** The parsed show name. */
  name: string;
  year?: number;
  episodes: number;
  minEpisode: number;
  seasons: number[];
  /** Every file numbers episodes from the start of the show ("Frieren - 29"). */
  absolute: boolean;
  /** Database ids of the show, when known locally. */
  ids?: ExternalIdsLite;
}

export interface TmdbShow {
  name?: string;
  seasons?: Array<{ season: number; name?: string; episodes?: number }>;
}

export interface IdentityOverrides {
  /** Pairs of unit ids the viewer said are one show. */
  merge?: Array<[string, string]>;
  /** Unit ids the viewer said stand alone. */
  apart?: string[];
  /** Names the viewer gave shows, by show key. */
  names?: Record<string, string>;
}

export type Why = "same name" | "spelling" | "known title" | "database id" | "you merged" | "you split";

export interface Placement {
  key: string;
  name: string;
  /** The files' season becomes this one; episodes shift by `offset`. */
  season?: number;
  offset?: number;
  /** Episode counts of seasons 1..n, to turn absolute numbers into seasons. */
  seasonCounts?: number[];
}

export interface ShowGroup {
  key: string;
  name: string;
  tmdb?: string;
  members: Array<{ unit: string; name: string; episodes: number; why?: Why; season?: number; arc?: string }>;
}

export interface Resolution {
  placement: Map<string, Placement>;
  groups: ShowGroup[];
}

/** What to ask TMDB for a unit: the show behind the name, without an arc's or later season's year. */
export function searchFor(unit: { name: string; year?: number }): { show: string; year?: number } {
  const n = readShowName(unit.name, unit.year);
  const show = n.country ? n.name.replace(/ \([A-Z]{2}\)$/, "") : n.name;
  return n.arc || n.season || !n.year ? { show } : { show, year: n.year };
}

/**
 * Group units into shows. Order of trust: the viewer's merges and splits, then
 * shared database ids, then the same name, then a spelling slip. A name or
 * spelling never joins two shows whose ids disagree or whose years differ.
 */
export function resolveShows(units: ShowUnit[], opts: { overrides?: IdentityOverrides; tmdbShow?: (id: string) => TmdbShow | undefined } = {}): Resolution {
  const ov = opts.overrides ?? {};
  const apart = new Set(ov.apart ?? []);
  const names = new Map(units.map((u) => [u.id, readShowName(u.name, u.year)]));
  const byId = new Map(units.map((u) => [u.id, u]));
  const parent = new Map(units.map((u) => [u.id, u.id]));
  const find = (k: string): string => {
    const p = parent.get(k)!;
    if (p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const why = new Map<string, Why>();
  // Per group: ids by kind and the years of its plain (not arc, not later-season) units.
  const facts = new Map<string, { ids: Map<string, Set<string>>; years: Set<number> }>();
  for (const u of units) {
    const n = names.get(u.id)!;
    const ids = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(u.ids ?? {})) if (v) ids.set(k, new Set([String(v)]));
    facts.set(u.id, { ids, years: new Set(n.year && !n.arc && !n.season ? [n.year] : []) });
  }
  const clash = (a: string, b: string, years: boolean) => {
    const fa = facts.get(find(a))!, fb = facts.get(find(b))!;
    for (const [k, s] of fa.ids) {
      const o = fb.ids.get(k);
      if (o && ![...s].some((x) => o.has(x))) return true;
    }
    return years && fa.years.size > 0 && fb.years.size > 0 && ![...fa.years].some((y) => fb.years.has(y));
  };
  const union = (a: string, b: string, reason: Why) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    parent.set(rb, ra);
    const fa = facts.get(ra)!, fb = facts.get(rb)!;
    for (const [k, s] of fb.ids) fa.ids.set(k, new Set([...(fa.ids.get(k) ?? []), ...s]));
    for (const y of fb.years) fa.years.add(y);
    if (!why.has(b)) why.set(b, reason);
  };

  for (const [a, b] of ov.merge ?? []) if (byId.has(a) && byId.has(b)) union(a, b, "you merged");
  const auto = units.filter((u) => !apart.has(u.id));

  // Shared database ids.
  const byDb = new Map<string, string[]>();
  for (const u of auto) for (const [k, v] of Object.entries(u.ids ?? {})) if (v) byDb.set(`${k}:${v}`, [...(byDb.get(`${k}:${v}`) ?? []), u.id]);
  for (const list of byDb.values()) for (const id of list.slice(1)) if (!clash(list[0]!, id, false)) union(list[0]!, id, "database id");

  // Same name. A name without a year joins its year only when one year carries that name.
  const byBase = new Map<string, ShowUnit[]>();
  for (const u of auto) byBase.set(names.get(u.id)!.base, [...(byBase.get(names.get(u.id)!.base) ?? []), u]);
  for (const list of byBase.values()) {
    const plainYears = new Set(list.flatMap((u) => {
      const n = names.get(u.id)!;
      return n.year && !n.arc && !n.season ? [n.year] : [];
    }));
    const yearOf = (u: ShowUnit) => {
      const n = names.get(u.id)!;
      return n.arc || n.season ? undefined : n.year;
    };
    for (const u of list) {
      for (const o of list) {
        if (o === u || find(o.id) === find(u.id)) continue;
        const yu = yearOf(u), yo = yearOf(o);
        if (yu && yo && yu !== yo) continue;
        if ((!yu || !yo) && plainYears.size > 1) continue;
        if (clash(u.id, o.id, true)) continue;
        union(o.id, u.id, names.get(u.id)!.known && names.get(u.id)!.base !== baseKeyOf(u.name) ? "known title" : "same name");
      }
    }
  }

  // Spelling slips, between different names.
  const bases = [...byBase.keys()];
  for (let i = 0; i < bases.length; i++) {
    for (let j = i + 1; j < bases.length; j++) {
      if (!sameSpelling(bases[i]!, bases[j]!)) continue;
      const a = byBase.get(bases[i]!)!, b = byBase.get(bases[j]!)!;
      const big = (l: ShowUnit[]) => l.slice().sort((x, y) => y.episodes - x.episodes)[0]!;
      const [x, y] = [big(a), big(b)];
      if (find(x.id) === find(y.id) || clash(x.id, y.id, true)) continue;
      // The better-attested spelling stays the anchor.
      const [keep, join] = a.reduce((n, u) => n + u.episodes, 0) >= b.reduce((n, u) => n + u.episodes, 0) ? [a, b] : [b, a];
      for (const u of join) if (!clash(keep[0]!.id, u.id, true)) union(keep[0]!.id, u.id, "spelling");
    }
  }

  // Groups, keys and names.
  const members = new Map<string, ShowUnit[]>();
  for (const u of units) members.set(find(u.id), [...(members.get(find(u.id)) ?? []), u]);
  const draft = [...members.values()].map((list) => {
    const plainUnits = list.filter((u) => !names.get(u.id)!.arc && !names.get(u.id)!.season);
    const pool = plainUnits.length ? plainUnits : list;
    // The name most files use, preferring mixed case and spaced words ("Dan Da Dan" over "Dandadan").
    const votes = new Map<string, { n: number; name: string; words: number; caps: boolean }>();
    for (const u of pool) {
      const nm = names.get(u.id)!;
      const v = votes.get(nm.base) ?? { n: 0, name: nm.name, words: nm.base.split(" ").length, caps: !/[a-z]/.test(u.name) };
      v.n += u.episodes;
      if (v.caps && /[a-z]/.test(u.name)) (v.name = nm.name, v.caps = false);
      votes.set(nm.base, v);
    }
    // Spellings of one compact form pool their votes.
    const pooled = new Map<string, { n: number; best: { n: number; name: string; words: number; caps: boolean } }>();
    for (const [base, v] of votes) {
      const c = base.replace(/ /g, "");
      const p = pooled.get(c) ?? { n: 0, best: v };
      p.n += v.n;
      if (v.words > p.best.words || (v.words === p.best.words && v.n > p.best.n)) p.best = v;
      pooled.set(c, p);
    }
    const best = [...pooled.values()].sort((a, b) => b.n - a.n || b.best.words - a.best.words || a.best.name.localeCompare(b.best.name))[0]!.best;
    const tmdbIds = new Set(list.flatMap((u) => (u.ids?.tmdb ? [u.ids.tmdb] : [])));
    const tmdb = tmdbIds.size === 1 ? [...tmdbIds][0] : undefined;
    const years = new Set(pool.flatMap((u) => (names.get(u.id)!.year && !names.get(u.id)!.arc ? [names.get(u.id)!.year!] : [])));
    return { list, name: best.name, base: baseKeyOf(best.name), tmdb, year: years.size === 1 ? [...years][0] : undefined };
  });
  // Two shows with one name (remakes): the year tells them apart.
  const sameBase = new Map<string, number>();
  for (const d of draft) sameBase.set(d.base, (sameBase.get(d.base) ?? 0) + 1);
  const used = new Set<string>();
  const tmdbName = (d: (typeof draft)[number]) => (d.tmdb ? opts.tmdbShow?.(d.tmdb)?.name : undefined);
  const tmdbNames = new Map<string, number>();
  for (const d of draft) {
    const t = tmdbName(d);
    if (t) tmdbNames.set(t, (tmdbNames.get(t) ?? 0) + 1);
  }
  const groups: ShowGroup[] = [];
  const placement = new Map<string, Placement>();
  for (const d of draft.sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name))) {
    let name = d.name;
    if ((sameBase.get(d.base) ?? 0) > 1 && d.year) name = `${name} (${d.year})`;
    let key = titleKeyOf(name);
    for (let n = 2; used.has(key); n++) key = `${titleKeyOf(name)} ${n}`;
    used.add(key);
    const t = tmdbName(d);
    const display = ov.names?.[key] ?? (t && tmdbNames.get(t) === 1 && (sameBase.get(d.base) ?? 0) === 1 ? t : name);
    const tm = d.tmdb ? opts.tmdbShow?.(d.tmdb) : undefined;
    const seasons = placeSeasons(d.list, names, d.base, tm);
    const group: ShowGroup = { key, name: display, ...(d.tmdb ? { tmdb: d.tmdb } : {}), members: [] };
    const anchor = d.list.slice().sort((a, b) => b.episodes - a.episodes)[0]!;
    for (const u of d.list.slice().sort((a, b) => b.episodes - a.episodes || a.name.localeCompare(b.name))) {
      const n = names.get(u.id)!;
      const s = seasons.get(u.id);
      placement.set(u.id, { key, name: display, ...s });
      group.members.push({
        unit: u.id, name: u.name, episodes: u.episodes,
        ...(u === anchor ? {} : whyOf(u, n, why.get(u.id), d.base)),
        ...(s?.season ? { season: s.season } : {}),
        ...(n.arc ? { arc: n.arc } : {}),
      });
    }
    if (apart.size) for (const m of group.members) if (apart.has(m.unit) && group.members.length === 1) m.why = "you split";
    groups.push(group);
  }
  return { placement, groups: groups.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Why a unit sits in its show, in the viewer's words. Arcs and seasons say so instead. */
function whyOf(u: ShowUnit, n: ShowName, recorded: Why | undefined, base: string): { why?: Why } {
  if (recorded === "you merged" || recorded === "database id") return { why: recorded };
  if (n.arc || n.season) return {};
  const own = baseKeyOf(u.name);
  if (n.known && own !== n.base && own.replace(/ /g, "") !== n.base.replace(/ /g, "")) return { why: "known title" };
  return { why: n.base === base || n.base.replace(/ /g, "") === base.replace(/ /g, "") ? "same name" : "spelling" };
}

/** Where each unit's files sit in the show's seasons, so arcs and parts don't collide. */
function placeSeasons(list: ShowUnit[], names: Map<string, ShowName>, base: string, tm?: TmdbShow): Map<string, Omit<Placement, "key" | "name">> {
  const out = new Map<string, Omit<Placement, "key" | "name">>();
  const tmSeasons = (tm?.seasons ?? []).filter((s) => s.season >= 1).sort((a, b) => a.season - b.season);
  const counts = tmSeasons.length && tmSeasons.every((s, i) => s.season === i + 1 && (s.episodes ?? 0) > 0) ? tmSeasons.map((s) => s.episodes!) : undefined;
  const taken = new Set<number>();
  const later: ShowUnit[] = [];
  for (const u of list) {
    const n = names.get(u.id)!;
    if (n.arc) {
      const arcKey = baseKeyOf(n.arc);
      const rule = matchArc(base, arcKey) ?? matchArc(knownBase(baseKeyOf(n.name)) ?? "", arcKey);
      const fromTmdb = tmSeasons.find((s) => s.name && nameMatches(baseKeyOf(s.name), arcKey));
      const season = rule?.season ?? fromTmdb?.season;
      if (season) {
        const offset = rule?.offset && u.minEpisode <= rule.offset ? rule.offset : undefined;
        out.set(u.id, { season, ...(offset ? { offset } : {}) });
        taken.add(season);
      } else later.push(u);
    } else if (n.season) {
      out.set(u.id, { season: n.season });
      taken.add(n.season);
    } else {
      for (const s of u.seasons) taken.add(s);
      if (u.absolute && counts) out.set(u.id, { seasonCounts: counts });
    }
  }
  // Arcs nothing knows: the next free seasons, oldest first.
  for (const u of later.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name))) {
    const season = Math.max(0, ...taken) + 1;
    taken.add(season);
    out.set(u.id, { season });
  }
  return out;
}

function nameMatches(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/ (?:arc|hen|saga)$/, "");
  const x = strip(a), y = strip(b);
  return x === y || (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x)));
}

/** A file's season and episode in its show, after placement. */
export function placeEpisode(p: Placement | undefined, ep: { season: number; episode: number; absolute?: boolean }): { season: number; episode: number; absolute: boolean } {
  if (p?.season != null) return { season: p.season, episode: ep.episode + (p.offset ?? 0), absolute: false };
  if (p?.seasonCounts && ep.absolute && ep.episode > p.seasonCounts[0]!) {
    let n = ep.episode;
    for (let s = 0; s < p.seasonCounts.length; s++) {
      if (n <= p.seasonCounts[s]!) return { season: s + 1, episode: n, absolute: false };
      n -= p.seasonCounts[s]!;
    }
  }
  return { season: ep.season, episode: ep.episode, absolute: !!ep.absolute };
}
