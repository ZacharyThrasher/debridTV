// DebridTV local server. Runs on the viewer's own PC and listens on 127.0.0.1.
// Other devices can reach it only when the owner turns on Home network access on
// the PC (app/lan/access.ts: private addresses, paired devices); tuner export and
// cloud relay stay behind their gates. Provider keys live in the local data folder and never reach
// the browser. Media is proxied so every byte and every cancellation is measured.
//
//   node app/server.ts            then open http://127.0.0.1:7337
//
// `createApp()` builds the whole thing without listening, so tests can run it
// against the mock providers on a spare port.

import http from "node:http";
import type { ExternalIds } from "../src/library/nfo.ts";
import { readFileSync, existsSync, statSync, createReadStream, rmSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { StationClock } from "../src/clock/schedule.ts";
import type { Airing } from "../src/clock/types.ts";
import { WatchLedger } from "../src/history/watched.ts";
import { ProviderError } from "../src/providers/types.ts";
import { Gates } from "../src/gates.ts";
import { JsonFile, dataDir } from "./store.ts";
import { seasonState, validTimeZone } from "../src/clock/dayparts.ts";
import { parseVttBlock } from "../src/library/vtt.ts";
import { RATINGS, normalizeRating, ratingRank } from "../src/clock/ratings.ts";
import { Library, ART_MAX_BYTES, type ArtKind, displayTitle, effectiveRating, mediaBadges, fileStatus, plainError, PROVIDER_NAMES, STATUS_ORDER, type Config, type LibItem, type ProviderBases, type RemoteProvider } from "./library.ts";
import { Lineup, airable, autoRules, dedupeGroups, nfoIds, presetMatches, usableLibrary, SEASONAL_PRESETS, PRESET_MIN_HOURS, PRESET_MIN_TITLES, cleanGroup, cleanDates, cleanExclusions, cleanLogo, cleanRestricted, cleanSlots, cleanWeights, type ItemInfo, type StationChannel, type CustomChannel } from "./lineup.ts";
import { Meters } from "./meters.ts";
import { ORDERINGS } from "../src/clock/ordering.ts";
import { demoItems } from "./demo.ts";
import { backupIfDue, listBackups, readBackup } from "./backups.ts";
import { EdgeCache } from "./edgecache.ts";
import { PinLock } from "./pinlock.ts";
import { OnlineMetadata } from "./metadata/tmdb.ts";
import { allowedUnder } from "../src/clock/ratings.ts";
import { SilenceJob, type SilenceTarget } from "./silence.ts";
import { browse as onDemandBrowse, continueWatching, show as onDemandShow, type OnDemandDeps } from "./ondemand.ts";
import { LanAccess, type LanOptions } from "./lan/access.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const HOST = "127.0.0.1";
const MIN = 60_000;
const VERSION = "0.2.0";

export interface AppOptions {
  /** 0 picks a free port (tests). Default 7337 or $PORT. */
  port?: number;
  /** Provider API bases; tests point these at the mock providers. */
  bases?: Partial<ProviderBases>;
  /** Look for ffmpeg (slow-ish); tests turn it off. */
  ffmpeg?: boolean;
  /** Background timers (periodic lineup refresh). */
  timers?: boolean;
  /** TMDB API and image bases; tests point these at a recorded mock. */
  tmdb?: { apiBase?: string; imageBase?: string; spacingMs?: number };
  /** Home network access options (tests simulate a TV's address with `peer`). */
  lan?: Pick<LanOptions, "peer" | "addresses" | "listen" | "now">;
}

interface HistoryState {
  spans: Record<string, Array<[number, number]>>;
  recent: Array<{ at: number; itemId: string; channel: string }>;
  /** Marks the viewer set by hand; they win over measured viewing. */
  manual?: Record<string, "watched" | "unwatched">;
}

export function createApp(opts: AppOptions = {}) {
let port = opts.port ?? Number(process.env.PORT ?? 7337);

// ---------------------------------------------------------------- state

const config = new JsonFile<Config>("config.json", () => ({}));
const historyFile = new JsonFile<HistoryState>("history.json", () => ({ spans: {}, recent: [], manual: {} }));
const meters = new Meters();
const gates = new Gates(); // Only Home network access (lan) can grant "sharing", from the PC.
const lan = new LanAccess({ gates, ...opts.lan });
const library = new Library(() => config.get(), meters, () => scheduleRebuild(), opts.bases);
const liveLineup = new Lineup("lineup.json");
const demoLineup = new Lineup("lineup-demo.json");
const demo = demoItems();
const pin = new PinLock();
// Online posters and descriptions (off until the viewer enters a TMDB key). Reads its disk cache only, never waits on TMDB.
const online = new OnlineMetadata({ ...opts.tmdb, log: (d) => meters.log("api", d) });
/** Which items only locked channels carry; recomputed after every rebuild or lock change. */
let lockSets: { gen: number; locked: Set<string>; open: Set<string> } | null = null;
let lockGen = 0;
let ledger = WatchLedger.import(historyFile.get().spans);
const ffmpeg = opts.ffmpeg === false ? null : detectFfmpeg();
const ffprobe = ffmpeg ? detectFfprobe(ffmpeg) : null;
const silenceJob = new SilenceJob(ffmpeg);
/** Episodes on this PC with no chapters and no silence check yet (N-22c). Never debrid files. */
function silenceTargets(all = false): SilenceTarget[] {
  return library.items().filter((i) => i.provider === "local" && isConnected("local") && i.present && !i.excluded && i.parsed.kind === "episode"
    && i.durationMs && !i.chaptersMs?.length && (all || !i.silence))
    .map((i) => ({ id: i.id, path: i.ref, durationMs: i.durationMs!, label: displayTitle(i) }));
}

function connected() {
  const c = config.get();
  return { torbox: !!c.torboxKey, realdebrid: !!c.rdToken, local: (c.localDirs ?? []).length > 0 };
}
function isConnected(provider: string): boolean {
  const c = connected();
  return provider === "torbox" ? c.torbox : provider === "realdebrid" ? c.realdebrid : provider === "local" ? c.local : false;
}
/** Library items from sources that are still connected. A disconnected source leaves the air. */
function liveLibrary(): LibItem[] {
  return library.items().filter((i) => isConnected(i.provider));
}
function isWatched(id: string, durationMs: number | null | undefined): boolean {
  const m = historyFile.get().manual?.[id];
  if (m) return m === "watched";
  return durationMs ? ledger.isWatched(id, durationMs) : false;
}

function isDemo(): boolean {
  const c = connected();
  if (process.env.DEBRIDTV_DEMO === "1") return true;
  if (!(c.torbox || c.realdebrid || c.local)) return true;
  // Connected but nothing playable yet: keep the demo on air until the first channel exists.
  return liveLineup.channels().length === 0;
}

/** Database ids known on this PC for a film or show: the .nfo's, then the TMDB cache's (N-01d). Never looked up here. */
function idsOf(i: LibItem): ExternalIds | undefined {
  const own = nfoIds(i);
  const tmdb = own?.tmdb ? undefined : online.tmdbId(i);
  return tmdb ? { ...own, tmdb } : own;
}
type CopyView = { id: string; provider: string; airs: boolean; refused: boolean };
/** Each file's copies of the same title, for files that have more than one (N-01d): where it lives, which copy airs, which a provider refused. */
function copiesById(items: LibItem[]): Map<string, CopyView[]> {
  const out = new Map<string, CopyView[]>();
  for (const g of dedupeGroups(items.filter((i) => i.present && !i.excluded && i.parsed.kind !== "other"), idsOf, airable)) {
    if (g.copies.length < 2) continue;
    const view = g.copies.map((c) => ({ id: c.id, provider: c.provider, airs: g.keep?.id === c.id, refused: c.availability === "policy-blocked" }));
    for (const c of g.copies) out.set(c.id, view);
  }
  return out;
}
/** Providers that refused another copy of an airing title, by the id of the copy that airs (the banner's small note). */
let refusedElsewhere = new Map<string, string[]>();
function allItems(): LibItem[] {
  return isDemo() ? demo : liveLibrary();
}
function itemById(id: string): LibItem | undefined {
  return id.startsWith("demo-") ? demo.find((d) => d.id === id) : library.get(id);
}
function lineup(): Lineup {
  return isDemo() ? demoLineup : liveLineup;
}

const edge = new EdgeCache(join(dataDir(), "cache"));
meters.cache = { bytes: edge.bytes(), files: edge.entries() };
let clock = new StationClock([]);
let rebuildTimer: NodeJS.Timeout | null = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuild();
  }, 300);
}
function rebuild() {
  lockGen++;
  const now = Date.now();
  // Live channels are kept in sync even while the demo is showing, so the switch is seamless.
  const liveItems = liveLibrary();
  const ids = new Set(liveItems.map((i) => i.id));
  const liveClock = new StationClock(library.mediaItems().filter((m) => ids.has(m.id)));
  // Edge cache keeps only files still in the library, present and not refused.
  edge.keepOnly((id) => {
    const it = library.get(id);
    return !!it && it.present && it.availability !== "policy-blocked" && isConnected(it.provider);
  });
  meters.cache = { bytes: edge.bytes(), files: edge.entries() };
  const timeZone = stationTimeZone();
  liveLineup.sync(liveClock, autoRules(liveItems, liveLineup.custom(), liveLineup.groups(), idsOf), now, { timeZone, info: itemInfo(liveItems, now) });
  const demoClock = new StationClock(demoMedia());
  demoLineup.sync(demoClock, autoRules(demo, demoLineup.custom(), demoLineup.groups(), idsOf), now, { timeZone, info: itemInfo(demo, now) });
  clock = isDemo() ? demoClock : liveClock;
  refusedElsewhere = new Map(
    [...copiesById(liveItems).values()].flatMap((v) => {
      const kept = v.find((c) => c.airs);
      const refused = [...new Set(v.filter((c) => c.refused).map((c) => c.provider))];
      return kept && refused.length ? [[kept.id, refused] as const] : [];
    }),
  );
  // Fill in posters and descriptions the files lack; skips PIN-locked items. No-op without a TMDB key.
  if (!isDemo()) void online.sync(liveItems, lockedItem);
}
const PREMIERE_DAYS = 14;
/** Show, genres, watched and "new" per item, for exclusions, watched rules and premieres. */
function itemInfo(items: LibItem[], now: number): (id: string) => ItemInfo | undefined {
  const map = new Map(items.map((i) => [i.id, {
    showKey: i.parsed.kind === "episode" ? i.parsed.showKey : undefined,
    genres: i.meta?.genres ?? (i.genre ? [i.genre] : undefined),
    watched: isWatched(i.id, i.durationMs),
    recent: i.addedAt != null && now - i.addedAt < PREMIERE_DAYS * 24 * 60 * MIN,
  }]));
  return (id) => map.get(id);
}

/** What "Export settings" and the daily backup contain: choices, never keys (gate F4). */
function settingsExport() {
  const c = config.get();
  return {
    exportedAt: new Date().toISOString(), app: "DebridTV", version: VERSION,
    note: "Settings only. API keys are never exported.",
    sources: { torbox: !!c.torboxKey, realdebrid: !!c.rdToken, localDirs: c.localDirs ?? [] },
    scanPerMinute: c.scanPerMinute ?? 30,
    lineup: liveLineup.exportSettings(),
    ratings: library.manualRatings(),
  };
}
function importSettings(res: http.ServerResponse, body: Record<string, unknown>) {
  const l = (body as { lineup?: unknown }).lineup;
  if (!l || typeof l !== "object") return json(res, 400, { error: "That isn't a DebridTV settings file." });
  const n = liveLineup.importSettings(l as never);
  const ratings = library.importRatings((body as { ratings?: unknown }).ratings);
  rebuild();
  return json(res, 200, { ok: true, ...n, ratings });
}
const backupDir = () => join(dataDir(), "backups");
function dailyBackup() {
  try {
    const made = backupIfDue(backupDir(), settingsExport(), Date.now(), config.get().backupKeep ?? 14);
    if (made) meters.log("backup", `Settings backed up (${made.name})`);
  } catch (e) {
    meters.log("error", `backup: ${e instanceof Error ? e.message : e}`);
  }
}

/** Restricted hours and time slots follow this zone: $DEBRIDTV_TZ, else this computer's. */
function stationTimeZone(): string {
  const env = process.env.DEBRIDTV_TZ;
  return env && validTimeZone(env) ? env : Intl.DateTimeFormat().resolvedOptions().timeZone;
}
function demoMedia() {
  const manual = library.manualRatings();
  return demo.map((i) => ({
    rating: effectiveRating(i, manual)?.rating,
    id: i.id,
    title: displayTitle(i),
    showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined,
    season: i.parsed.kind === "episode" ? i.parsed.season : undefined,
    episode: i.parsed.kind === "episode" ? i.parsed.episode : undefined,
    durationMs: i.durationMs,
    source: { provider: i.provider, ref: i.ref },
  }));
}
rebuild();

// ---------------------------------------------------------------- views

function channelView(c: StationChannel) {
  const st = lineup().settingsFor(c.meta.ruleKey);
  const hue = st.logo && "hue" in st.logo && st.logo.hue != null ? st.logo.hue : c.meta.hue;
  return { id: c.id, number: c.number, name: c.name, hue, kind: c.meta.kind, tagline: c.meta.tagline, ruleKey: c.meta.ruleKey,
    favorite: !!st.favorite, logo: st.logo ?? null, kid: !!st.kid, ...lockView(st), art: channelArt(c), season: seasonView(st.season) };
}
/** A seasonal channel's dates, whether it is on now, and when that changes (N-32). */
function seasonView(season: { from: string; to: string } | undefined) {
  return season ? { ...season, ...seasonState(season, Date.now(), stationTimeZone()) } : null;
}

// ---------------------------------------------------------------- parental lock (N-06b)

/** A channel counts as locked only while a PIN is set; `unlocked` = the PIN was entered recently. */
function lockView(st: { locked?: boolean }) {
  const locked = !!st.locked && pin.pinSet();
  return { locked, unlocked: locked && pin.isUnlocked() };
}
/** The PIN guard is up: some channel is locked and nobody has entered the PIN. */
function guarded(): boolean {
  return pin.pinSet() && !pin.isUnlocked() && lineup().lockedKeys().length > 0;
}
const PIN_NEEDED = { error: "Enter the parental PIN to change this.", pinRequired: true };
/**
 * Items reachable only through locked channels. An item that also airs on an
 * unlocked channel (within that channel's rating limit) stays watchable there.
 */
function lockedItem(id: string): boolean {
  if (!guarded()) return false;
  if (!lockSets || lockSets.gen !== lockGen) {
    const l = lineup();
    const lockedKeys = new Set(l.lockedKeys());
    const rating = ratingLookup();
    const locked = new Set<string>();
    const open = new Set<string>();
    for (const c of l.allChannels()) if (lockedKeys.has(c.meta.ruleKey)) for (const iid of channelItems(c)) locked.add(iid);
    for (const c of l.channels()) if (!lockedKeys.has(c.meta.ruleKey)) for (const iid of channelItems(c, rating)) open.add(iid);
    lockSets = { gen: lockGen, locked, open };
  }
  return lockSets.locked.has(id) && !lockSets.open.has(id);
}
function ratingLookup() {
  const manual = library.manualRatings();
  return (iid: string) => {
    const it = itemById(iid);
    return it ? effectiveRating(it, manual)?.rating : undefined;
  };
}
/** Every item a channel can air (any revision, slot programs too); with `rating`, only those its rating limit lets through. */
function channelItems(c: StationChannel, rating?: (id: string) => string | undefined): Set<string> {
  const out = new Set<string>();
  for (const rev of c.revisions) {
    const lists = [rev.itemIds, ...(rev.dayparts?.rules ?? []).flatMap((r) => (r.program ? [r.program.itemIds] : []))];
    for (const ids of lists) for (const iid of ids) if (!rating || allowedUnder(rating(iid), rev.maxRating)) out.add(iid);
  }
  return out;
}
/** Unlocked channels that also air some of this channel's programs: locking this one doesn't hide those. */
function alsoOn(c: StationChannel) {
  const l = lineup();
  const lockedKeys = new Set(l.lockedKeys());
  const mine = channelItems(c);
  const rating = ratingLookup();
  const out: Array<{ id: string; number: number; name: string; programs: number }> = [];
  for (const o of l.channels()) {
    if (o.id === c.id || lockedKeys.has(o.meta.ruleKey)) continue;
    let n = 0;
    for (const iid of channelItems(o, rating)) if (mine.has(iid)) n++;
    if (n) out.push({ id: o.id, number: o.number, name: o.name, programs: n });
  }
  return out.sort((a, b) => b.programs - a.programs);
}
function refuseLocked(res: http.ServerResponse, id: string): boolean {
  if (!lockedItem(id)) return false;
  // Final: the player shows the locked card and asks for the PIN; it never retries.
  json(res, 403, { error: "This channel is locked. Enter the parental PIN to watch.", locked: true, final: true });
  return true;
}

/** URLs for a local file's own artwork (N-01c), then TMDB's for what it lacks (N-01c online); paths stay on the server. */
function artView(it: LibItem | undefined): Partial<Record<ArtKind, string>> | undefined {
  if (!it) return undefined;
  const kinds = new Set<ArtKind>([...(it.provider === "local" && it.art ? (Object.keys(it.art) as ArtKind[]) : []), ...online.kinds(it)]);
  if (!kinds.size) return undefined;
  const out: Partial<Record<ArtKind, string>> = {};
  for (const k of kinds) out[k] = `/api/art/${it.id}/${k}`;
  return out;
}
/** A show channel's clear logo, if its folder has one; the editor can offer it as the channel's logo. */
function channelArt(c: StationChannel) {
  if (c.meta.kind !== "show") return undefined;
  const ids = c.revisions[c.revisions.length - 1]!.itemIds;
  for (const id of ids.slice(0, 50)) {
    const a = artView(itemById(id));
    if (a?.logo || a?.poster) return { ...(a.logo ? { logo: a.logo } : {}), ...(a.poster ? { poster: a.poster } : {}) };
  }
  return undefined;
}

/**
 * What a locked channel shows until the PIN is entered: when things start and end
 * (so the guide grid and breaks still line up), and nothing that says what they are.
 */
function lockedAiringView(a: Airing) {
  return {
    start: a.startMs, end: a.endMs, itemId: null, locked: true, title: "Locked", rating: null,
    segments: a.segments.map((s) => (s.kind === "program" ? { kind: s.kind, start: s.startMs, end: s.endMs } : { kind: s.kind, start: s.startMs, end: s.endMs, reason: s.reason })),
  };
}
/** airingView, or the locked stand-in when this channel is locked and nobody has entered the PIN. */
function airingViewFor(c: StationChannel): (a: Airing) => object {
  const v = lockView(lineup().settingsFor(c.meta.ruleKey));
  if (v.locked && !v.unlocked) return lockedAiringView;
  const group = groupForAiring(c);
  return (a) => {
    const g = group(a.itemId);
    return g ? { ...airingView(a), group: g } : airingView(a);
  };
}

function airingView(a: Airing) {
  const it = itemById(a.itemId);
  const p = it?.parsed;
  return {
    start: a.startMs,
    end: a.endMs,
    itemId: a.itemId,
    title: p?.kind === "episode" ? p.show : p?.kind === "movie" ? p.title : it?.trailer ? it.trailer.title : it?.track?.title ?? (it?.name ?? "Unknown"),
    episode: p?.kind === "episode" ? (p.absolute ? `Ep. ${p.episode}` : `S${p.season} · E${p.episode}`) : undefined,
    year: p?.kind === "movie" ? p.year : it?.trailer?.year ?? it?.track?.year,
    subtitle: it?.subtitle ?? (p?.kind === "episode" ? (it?.meta?.title ?? online.text(it)?.name) : undefined),
    genre: it?.genre ?? it?.meta?.genres?.[0] ?? it?.track?.genre,
    rating: it ? (effectiveRating(it, library.manualRatings())?.rating ?? null) : null,
    description: it?.meta?.plot ?? online.text(it)?.overview,
    kind: it?.trailer ? "trailer" : it?.track ? "track" : p?.kind,
    ...(it?.trailer ? { trailerFor: trailerFor(it.trailer) } : {}),
    ...(it?.track ? { artist: it.track.artist ?? null, album: it.track.album ?? null, trackNo: it.track.track ?? null } : {}),
    durationMs: it?.durationMs ?? null,
    ...availabilityView(it),
    provider: it?.provider,
    ...(refusedElsewhere.has(a.itemId) ? { refusedElsewhere: refusedElsewhere.get(a.itemId)!.map((p) => PROVIDER_NAMES[p as keyof typeof PROVIDER_NAMES] ?? p) } : {}),
    codecs: it ? { container: it.container, video: it.video, audio: it.audio, ...mediaBadges(it) } : undefined,
    watched: isWatched(a.itemId, it?.durationMs),
    art: artView(it),
    segments: a.segments.map((s) => (s.kind === "program" ? { kind: s.kind, start: s.startMs, end: s.endMs, fileFrom: s.fileFromMs } : { kind: s.kind, start: s.startMs, end: s.endMs, reason: s.reason })),
  };
}

/** The film a trailer advertises, and its library id when the film itself is here (N-23c). */
function trailerFor(t: { title: string; titleKey: string; year?: number }) {
  const film = allItems().find((i) => i.present && i.parsed.kind === "movie" && i.parsed.titleKey === t.titleKey && (!t.year || !i.parsed.year || i.parsed.year === t.year));
  return { title: t.title, year: t.year ?? null, itemId: film?.id ?? null };
}

/**
 * Availability as the player and guide see it. The stored value is what the media
 * host last said; an account that is no longer paid up or a file that left the
 * library overrides it with its own distinct reason (gate D5).
 */
/**
 * How much of a channel's lineup has a known age rating, so the editor can say
 * what a kid flag or restricted hours will actually leave on the air.
 */
function ratingCoverage(c: StationChannel) {
  const manual = library.manualRatings();
  const ids = c.revisions[c.revisions.length - 1]!.itemIds;
  const counts: Record<string, number> = Object.fromEntries([...RATINGS, "unrated"].map((r) => [r, 0]));
  for (const id of ids) {
    const it = itemById(id);
    const r = it ? effectiveRating(it, manual)?.rating : undefined;
    counts[r ?? "unrated"]!++;
  }
  const kidOk = ids.filter((id) => { const it = itemById(id); return it && ratingRank(effectiveRating(it, manual)?.rating) <= RATINGS.indexOf("PG"); }).length;
  return { total: ids.length, byRating: counts, unrated: counts.unrated!, kidSafe: kidOk };
}

/** The shows (and films) a channel draws from, for weight sliders and exclusions. */
function channelGroups(c: StationChannel) {
  const rule = autoRules(allItems(), lineup().custom(), lineup().groups(), idsOf).find((r) => r.key === c.meta.ruleKey);
  const out = new Map<string, { key: string; name: string; count: number; genres: string[] }>();
  for (const id of rule?.itemIds ?? []) {
    const it = itemById(id);
    if (!it) continue;
    const key = it.parsed.kind === "episode" ? it.parsed.showKey : "films";
    const g = out.get(key) ?? { key, name: it.parsed.kind === "episode" ? it.parsed.show : "Films", count: 0, genres: [] };
    g.count++;
    for (const x of it.meta?.genres ?? (it.genre ? [it.genre] : [])) if (!g.genres.includes(x)) g.genres.push(x);
    out.set(key, g);
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

/** How many season-0 specials this channel's rule could air (shown or not). */
function specialsOf(c: StationChannel): number {
  const rule = autoRules(allItems(), lineup().custom(), lineup().groups(), idsOf).find((r) => r.key === c.meta.ruleKey);
  return rule?.specialIds?.length ?? 0;
}

function availabilityView(it: LibItem | undefined) {
  if (!it) return { availability: "unknown", availabilityReason: undefined };
  if (it.provider === "demo") return { availability: it.availability, availabilityReason: it.availabilityReason };
  const st = fileStatus(it, accountOf(it.provider));
  if (st.status === "account" || st.status === "gone" || st.status === "not-ready")
    return { availability: "unavailable", availabilityReason: st.message.replace(/\.$/, "") };
  return { availability: it.availability ?? "unknown", availabilityReason: it.availabilityReason };
}
function accountOf(provider: string) {
  return provider === "torbox" || provider === "realdebrid" ? library.account(provider) : undefined;
}

function sourcesView() {
  const c = config.get();
  const items = library.items();
  const by = (p: string) => items.filter((i) => i.provider === p);
  const summary = (p: "torbox" | "realdebrid" | "local") => {
    const list = by(p);
    const account = p === "local" ? undefined : library.account(p);
    const counts = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0])) as Record<string, number>;
    for (const i of list) counts[fileStatus(i, account).status]!++;
    const video = list.filter((i) => i.parsed.kind !== "other" && i.present);
    return {
      connected: isConnected(p),
      refreshedAt: library.refreshedAt()[p] ?? null,
      files: list.filter((i) => i.present).length,
      video: video.length,
      timed: video.filter((i) => i.durationMs).length,
      policyBlocked: counts.refused!,
      unavailable: counts.problem! + counts.account!,
      probeErrors: 0,
      counts,
      account: account ? { plan: account.plan ?? null, premium: account.premium ?? null, premiumUntil: account.premiumUntilMs ?? null,
        checkedAt: account.checkedAtMs, error: account.error ?? null } : null,
    };
  };
  return {
    torbox: summary("torbox"),
    realdebrid: { ...summary("realdebrid"), packsToExpand: library.pendingPacks() },
    local: { ...summary("local"), dirs: c.localDirs ?? [] },
    scan: { ...library.scan, needed: library.needsScan(), perMinute: c.scanPerMinute ?? 30,
      failed: library.items().filter((i) => isConnected(i.provider) && i.present && i.durationMs == null && i.probe?.error && i.probe.error !== "policy").length },
    dataDir: dataDir(),
  };
}

// ---------------------------------------------------------------- media

const MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".ts": "video/mp2t",
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4" };

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, id: string, internal: boolean) {
  const it = itemById(id);
  if (!it || it.provider === "demo") return json(res, 404, { error: "no media for this item" });
  if (refuseLocked(res, id)) return;
  const label = displayTitle(it).slice(0, 60);
  const range = req.headers.range ?? "bytes=0-";

  if (it.provider === "local") {
    if (!existsSync(it.ref)) return json(res, 410, { error: "file is gone" });
    const size = statSync(it.ref).size;
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    res.writeHead(206, { "content-type": MIME[extname(it.ref).toLowerCase()] ?? "application/octet-stream", "accept-ranges": "bytes",
      "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` });
    createReadStream(it.ref, { start, end }).pipe(res);
    return;
  }

  const client = library.client(it.provider);
  if (!client) return json(res, 409, { error: `${PROVIDER_NAMES[it.provider]} is not connected` });
  const st = fileStatus(it, accountOf(it.provider));
  if (st.status === "refused") return json(res, 451, { error: "policy", message: st.message });
  if (st.status === "account" || st.status === "gone" || st.status === "not-ready") return json(res, 409, { error: st.status, message: st.message });
  const ac = new AbortController();
  let finished = false;
  let opened = false;
  req.on("close", () => {
    if (!finished) {
      ac.abort();
      if (opened) meters.close(label, true);
    }
  });
  try {
    const type = MIME[extname(it.name).toLowerCase()] ?? "application/octet-stream";
    const rm = /^bytes=(\d+)-(\d*)$/.exec(range);
    const want = rm ? { from: Number(rm[1]), to: rm[2] ? Number(rm[2]) : null } : null;
    const known = edge.get(id, it.bytes || undefined);
    // Wholly inside a cached end: answered here, no host involved.
    if (want && known) {
      const to = Math.min(want.to ?? known.size - 1, known.size - 1);
      const local = edge.read(id, want.from, to);
      if (local) {
        finished = true;
        meters.add("cached", local.length);
        res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-length": String(local.length), "content-range": `bytes ${want.from}-${to}/${known.size}` });
        return void res.end(local);
      }
    }
    let upstream: Response | null = null;
    // A read starting inside the cached head: send what's here at once and ask the host only for the rest.
    const lead = want && known && want.from < known.headLen && (want.to == null || want.to >= known.headLen)
      ? edge.read(id, want.from, known.headLen - 1) : null;
    const upRange = lead && want ? `bytes=${want.from + lead.length}-${want.to ?? ""}` : range;
    for (let attempt = 0; attempt < 2; attempt++) {
      const grant = await library.grants.get(client, it.ref, ac.signal);
      const pending = fetch(grant.url, { headers: { range: upRange }, signal: ac.signal });
      if (lead && attempt === 0 && !res.headersSent) {
        const end = want!.to ?? known!.size - 1;
        res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-length": String(end - want!.from + 1), "content-range": `bytes ${want!.from}-${end}/${known!.size}` });
        res.write(lead);
        meters.add("cached", lead.length);
      }
      upstream = await pending;
      if (upstream.status !== 403 && upstream.status !== 404 && upstream.status !== 410) break;
      // A refused link is re-resolved exactly once (ADR-0002).
      await upstream.body?.cancel();
      library.grants.invalidate(client, it.ref);
    }
    if (!upstream || !upstream.ok || !upstream.body) {
      library.markAvailability(id, "unavailable", `The media host said ${upstream?.status}`);
      if (res.headersSent) return void res.destroy();
      return json(res, 502, { error: `media host ${upstream?.status}` });
    }
    library.notePlayback(id, upstream.headers);
    const cr = /bytes (\d+)-(\d+)\/(\d+)/.exec(upstream.headers.get("content-range") ?? "");
    const total = cr ? Number(cr[3]) : upstream.status === 200 ? Number(upstream.headers.get("content-length") ?? 0) : 0;
    if (lead && (!cr || Number(cr[1]) !== want!.from + lead.length || total !== known!.size)) {
      // The host's file isn't the one cached: forget it and end this response; the player asks again.
      edge.drop(id);
      await upstream.body.cancel().catch(() => {});
      return void res.destroy();
    }
    if (!res.headersSent) {
      const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes" };
      for (const h of ["content-length", "content-range"]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status, headers);
    }
    opened = true;
    meters.open(`${internal ? "[compat] " : ""}${label}`);
    const body = Readable.fromWeb(upstream.body as any);
    const watch = total > 0 && (!it.bytes || it.bytes === total) ? edge.observe(id, total, cr ? Number(cr[1]) : 0) : null;
    let ended = false;
    body.on("data", (chunk: Buffer) => {
      meters.add("playback", chunk.length);
      watch?.chunk(chunk);
    });
    body.on("end", () => {
      finished = true;
      ended = true;
      meters.close(label, false);
    });
    body.on("close", () => {
      watch?.done(ended);
      meters.cache = { bytes: edge.bytes(), files: edge.entries() };
    });
    body.on("error", () => {});
    body.pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    if (e instanceof ProviderError && e.kind === "policy") {
      edge.drop(id);
      library.markAvailability(id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
      if (res.headersSent) return void res.destroy();
      scheduleRebuild();
      return json(res, 451, { error: "policy", message: `${PROVIDER_NAMES[it.provider]} refused this file. DebridTV won't retry it or fetch it elsewhere.` });
    }
    if (e instanceof ProviderError && (e.kind === "auth" || e.kind === "account")) void library.checkAccount(it.provider as RemoteProvider).catch(() => {});
    // A rate limit or a provider outage is about the account, not this file: don't mark the file, and make the scan wait.
    if (e instanceof ProviderError && (e.kind === "rate-limited" || e.kind === "transient")) library.playbackPushedBack(it.provider as RemoteProvider, e.kind === "rate-limited" ? "rate-limited" : "provider-down", e.retryAfterMs);
    else library.markAvailability(id, "unavailable", plainError(e));
    meters.log("error", `${label}: ${plainError(e)}`);
    json(res, 502, { error: plainError(e) });
  }
}

/**
 * Compatibility path: ffmpeg reads through our own metered proxy, starts at the
 * live position, copies video when the browser can decode it, converts audio to
 * AAC, and emits fragmented MP4. Like real TV, this stream can't be seeked.
 */
function serveLive(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL) {
  const it = itemById(id);
  if (!it) return json(res, 404, { error: "unknown item" });
  if (refuseLocked(res, id)) return;
  if (!ffmpeg) return json(res, 501, { error: "ffmpeg not found" });
  const start = Math.max(0, Number(url.searchParams.get("start") ?? 0));
  const canDecode = (url.searchParams.get("v") ?? "h264").split(",");
  // Track choice (N-18a): indexes count within their kind, as ffmpeg's 0:a:N / 0:s:N do.
  const pick = (name: string, kind: "audio" | "subtitle") => {
    const raw = url.searchParams.get(name);
    if (raw == null || raw === "") return { ok: true as const, index: null };
    const n = Number(raw);
    const known = it.tracks?.filter((t) => t.kind === kind);
    if (!Number.isInteger(n) || n < 0 || (known && known.length > 0 && n >= known.length)) return { ok: false as const, index: null };
    return { ok: true as const, index: n, track: known?.[n] };
  };
  const a = pick("a", "audio");
  const sub = pick("s", "subtitle");
  if (!a.ok || !sub.ok) return json(res, 400, { error: "No such audio or subtitle track." });
  // Audio codec: AAC by default; ac=opus for browsers without an AAC decoder (some Chromium builds).
  const ac = url.searchParams.get("ac") ?? "aac";
  if (ac !== "aac" && ac !== "opus") return json(res, 400, { error: "Audio is ac=aac or ac=opus." });
  // N-19: a ceiling on the converted picture's height (only when video is re-encoded; copied video is untouched).
  const maxhRaw = url.searchParams.get("maxh");
  const maxh = maxhRaw == null || maxhRaw === "" || maxhRaw === "0" ? null : Number(maxhRaw);
  if (maxh !== null && maxh !== 720 && maxh !== 1080) return json(res, 400, { error: "maxh is 720 or 1080." });
  const scale = maxh ? `scale=-2:'min(ih,${maxh})'` : "scale='min(1920,iw)':-2";
  const subCodec = sub.index != null ? (sub as { track?: { codec: string } }).track?.codec : undefined;
  const textSub = sub.index != null && (!subCodec || TEXT_SUBS.has(subCodec));
  const burn = sub.index != null && !textSub && url.searchParams.get("burn") === "1" && IMAGE_SUBS.has(subCodec ?? "");
  const copyVideo = !burn && (it.video ? canDecode.includes(it.video) : false);
  // Songs (and any file with no picture) get a sound-only stream.
  const audioOnly = !!it.track || (!!it.tracks?.length && !it.tracks.some((t) => t.kind === "video"));
  const tok = url.searchParams.get("tok");
  const subsOut = textSub && tok ? 3 : null;
  const input = it.provider === "local" ? it.ref : `http://${HOST}:${port}/media/${id}?internal=1`;
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"];
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", start.toFixed(2), "-i", input,
    ...(audioOnly
      ? []
      : burn
      ? ["-filter_complex", `[0:v:0][0:s:${sub.index}]overlay=eof_action=pass,${scale}[v]`, "-map", "[v]", ...encode]
      : ["-map", "0:v:0", ...(copyVideo ? ["-c:v", "copy"] : [...encode, "-vf", scale])]),
    // An index we couldn't check against the file's track list is optional, so a wrong guess plays without sound rather than failing.
    "-map", a.index == null ? "0:a:0?" : `0:a:${a.index}${it.tracks?.length ? "" : "?"}`, "-sn", "-dn", "-map_chapters", "-1",
    ...(ac === "opus" ? ["-c:a", "libopus", "-ac", "2", "-b:a", "160k"] : ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]),
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    // Text subtitles ride along as a second output of the same process: no second read.
    // Shifted by the seek so cue times are file times; /api/livesubs makes them stream-relative.
    ...(subsOut ? ["-map", `0:s:${sub.index}`, "-c:s", "webvtt", "-output_ts_offset", start.toFixed(3), "-f", "webvtt", `pipe:${subsOut}`] : []),
  ];
  // Copying video can only start on a keyframe, so the picture begins a little
  // before the live position. Find that keyframe (the same seek ffmpeg makes) so the
  // player can skip ahead to the exact station time.
  if (tok && liveStarts.has(tok)) {
    // The browser often re-requests the same stream; the keyframe is already known.
  } else if (tok && copyVideo && ffprobe) {
    const p = spawn(ffprobe, ["-v", "error", "-read_intervals", `${start.toFixed(2)}%+#1`, "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", input],
      { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.on("exit", () => {
      const k = parseFloat(out);
      liveStarts.set(tok, Number.isFinite(k) && k <= start ? k * 1000 : start * 1000);
      if (liveStarts.size > 50) liveStarts.delete(liveStarts.keys().next().value!);
    });
    setTimeout(() => p.exitCode == null && p.kill("SIGKILL"), 15_000).unref();
  } else if (tok) liveStarts.set(tok, start * 1000);
  const child: ChildProcess = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe", ...(subsOut ? ["pipe" as const] : [])] });
  if (subsOut && tok) collectSubs(tok, child.stdio[subsOut] as NodeJS.ReadableStream);
  let err = "";
  child.stderr!.on("data", (d) => (err = (err + d).slice(-2000)));
  res.writeHead(200, { "content-type": "video/mp4", "cache-control": "no-store" });
  child.stdout!.pipe(res);
  const kill = () => {
    if (child.exitCode == null) child.kill("SIGKILL");
  };
  req.on("close", kill);
  child.on("exit", (code) => {
    if (code && code !== 255 && err) meters.log("error", `compat: ${err.split("\n").filter(Boolean).pop()}`);
    res.end();
  });
}

const TEXT_SUBS = new Set(["srt", "ass", "webvtt", "mov_text", "subrip", "ssa", "text"]);
const IMAGE_SUBS = new Set(["pgs", "vobsub", "hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"]);

interface LiveCue {
  n: number;
  /** File time. */
  startMs: number;
  endMs: number;
  text: string;
}
const liveSubs = new Map<string, { cues: LiveCue[]; done: boolean; next: number }>();

/** Read ffmpeg's WebVTT output as it arrives into cues for one stream token. */
function collectSubs(tok: string, stream: NodeJS.ReadableStream) {
  // A re-request of the same stream adds only cues not seen yet, so `n` keeps counting up.
  const st = liveSubs.get(tok) ?? { cues: [], done: false, next: 1 };
  st.done = false;
  liveSubs.delete(tok);
  liveSubs.set(tok, st);
  if (liveSubs.size > 20) liveSubs.delete(liveSubs.keys().next().value!);
  const seen = new Set(st.cues.map((c) => `${c.startMs}|${c.endMs}|${c.text}`));
  let buf = "";
  const flush = (final: boolean) => {
    const blocks = buf.replace(/\r/g, "").split(/\n\n+/);
    buf = final ? "" : blocks.pop()!;
    for (const b of blocks) {
      const c = parseVttBlock(b);
      if (!c) continue;
      const key = `${c.startMs}|${c.endMs}|${c.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      st.cues.push({ n: st.next++, ...c });
      if (st.cues.length > 2000) st.cues.shift();
    }
  };
  stream.setEncoding?.("utf8");
  stream.on("data", (d: string | Buffer) => {
    buf += String(d);
    flush(false);
  });
  stream.on("end", () => {
    flush(true);
    st.done = true;
  });
  stream.on("error", () => (st.done = true));
}


const liveStarts = new Map<string, number>();

// ---------------------------------------------------------------- http

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const p = url.pathname;
  try {
    // Host, Origin, home network address and pairing checks; also serves /pair and /api/lan/*.
    if (await lan.intercept(req, res, url, port)) return;
    if (p.startsWith("/api/")) return await api(req, res, url);
    const live = /^\/media\/([\w-]+)\/live$/.exec(p);
    if (live) return serveLive(req, res, live[1]!, url);
    const media = /^\/media\/([\w-]+)$/.exec(p);
    if (media) return await serveMedia(req, res, media[1]!, url.searchParams.get("internal") === "1");
    return serveStatic(res, p);
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const p = url.pathname;
  const m = req.method ?? "GET";
  const body = m === "POST" || m === "PUT" ? await readJson(req) : {};

  if (p === "/api/bootstrap") {
    return json(res, 200, {
      now: Date.now(),
      demo: isDemo(),
      // Sources are connected but no channel exists yet: the demo is a stand-in while running times are learned.
      waiting: isDemo() && Object.values(connected()).some(Boolean) ? { scanning: library.scan.running, needed: library.needsScan() } : null,
      channels: lineup().channels().map(channelView),
      ffmpeg: !!ffmpeg,
      connected: connected(),
      gates: { sharing: gates.isGranted("sharing"), cloudRelay: gates.isGranted("cloud-relay"), tunerExport: gates.isGranted("tuner-export") },
      version: VERSION,
    });
  }
  if (p === "/api/guide") {
    const from = Number(url.searchParams.get("from") ?? Date.now() - 30 * MIN);
    const to = Math.min(from + 12 * 60 * MIN, Number(url.searchParams.get("to") ?? from + 3 * 60 * MIN));
    const out = lineup().channels().map((c) => ({ channel: channelView(c), airings: clock.airingsBetween(c, from, to).map(airingViewFor(c)) }));
    return json(res, 200, { now: Date.now(), from, to, rows: out });
  }
  if (p === "/api/now") {
    const ch = lineup().channels().find((c) => c.id === url.searchParams.get("channel"));
    if (!ch) return json(res, 404, { error: "no such channel" });
    const t = Number(url.searchParams.get("at") ?? Date.now());
    const target = clock.tune(ch, t);
    meters.tunes += url.searchParams.get("count") === "1" ? 1 : 0;
    if (!target) return json(res, 200, { now: Date.now(), channel: channelView(ch), offAir: true });
    const next = clock.airingAt(ch, target.airing.endMs);
    const view = airingViewFor(ch);
    const hidden = view === lockedAiringView;
    return json(res, 200, {
      now: Date.now(),
      channel: channelView(ch),
      airing: view(target.airing),
      segment: target.segment.kind === "program"
        ? { kind: "program", start: target.segment.startMs, end: target.segment.endMs, ...(hidden ? {} : { fileFrom: target.segment.fileFromMs }) }
        : { kind: "break", start: target.segment.startMs, end: target.segment.endMs, reason: target.segment.reason },
      ...(hidden ? { locked: true } : {}),
      fileOffsetMs: hidden ? null : target.fileOffsetMs,
      next: next ? view(next) : null,
    });
  }
  if (p === "/api/prefetch" && m === "POST") {
    // Resolve the playback link early (EXP-006); no media is read here.
    const it = itemById(String(body.itemId ?? ""));
    if (it && refuseLocked(res, it.id)) return;
    if (!it || it.provider === "demo" || it.provider === "local") return json(res, 200, { ok: true, skipped: true });
    const client = library.client(it.provider);
    if (!client) return json(res, 409, { error: "not connected" });
    const st = fileStatus(it, accountOf(it.provider)).status;
    // Never ask for a link the provider already refused, or for a file it hasn't finished.
    if (st === "refused" || st === "account" || st === "gone" || st === "not-ready") return json(res, 200, { ok: false, skipped: true, status: st });
    try {
      await library.grants.get(client, it.ref);
      return json(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        library.markAvailability(it.id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
        scheduleRebuild();
        return json(res, 200, { ok: false, policy: true });
      }
      return json(res, 200, { ok: false, error: plainError(e) });
    }
  }
  const art = /^\/api\/art\/([\w-]+)\/(poster|fanart|thumb|logo)$/.exec(p);
  if (art && m === "GET") {
    const it = itemById(art[1]!);
    const file = (it?.provider === "local" ? it.art?.[art[2] as ArtKind] : undefined) ?? online.imageFile(it, art[2] as ArtKind);
    if (!it || !file) return json(res, 404, { error: "no picture" });
    if (refuseLocked(res, it.id)) return;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {}
    if (!size || size > ART_MAX_BYTES) return json(res, 404, { error: "no picture" });
    const types: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    res.writeHead(200, { "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": String(size),
      "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    createReadStream(file).pipe(res);
    return;
  }
  if (p === "/api/item") {
    const it = itemById(url.searchParams.get("id") ?? "");
    if (!it) return json(res, 404, {});
    if (refuseLocked(res, it.id)) return;
    return json(res, 200, {
      id: it.id, title: displayTitle(it), provider: it.provider, container: it.container, video: it.video, audio: it.audio,
      tracks: it.tracks ?? [], chaptersMs: it.chaptersMs ?? [],
      durationMs: it.durationMs, ...availabilityView(it), seenMs: ledger.seenMs(it.id), watched: isWatched(it.id, it.durationMs),
    });
  }
  if (p === "/api/watch" && m === "POST") {
    const { itemId, fromMs, toMs, channel } = body as { itemId: string; fromMs: number; toMs: number; channel: string };
    const it = itemById(itemId);
    if (!it || !(toMs > fromMs) || toMs - fromMs > 10 * MIN) return json(res, 400, { error: "bad span" });
    ledger.record(itemId, fromMs, toMs);
    historyFile.update((h) => {
      h.spans = ledger.export();
      const last = h.recent[0];
      if (!last || last.itemId !== itemId) h.recent.unshift({ at: Date.now(), itemId, channel });
      else (last.at = Date.now()), (last.channel = channel);
      h.recent = h.recent.slice(0, 200);
    });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history") {
    const h = historyFile.get();
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 60));
    return json(res, 200, {
      recent: h.recent.slice(0, limit).map((r) => historyRow(r, h)),
      total: h.recent.length,
      threshold: 0.9,
    });
  }
  if (p === "/api/history/clear" && m === "POST") {
    historyFile.set({ spans: {}, recent: [], manual: {} });
    ledger = new WatchLedger();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/mark" && m === "POST") {
    // A hand mark is a separate, labelled fact; it never invents viewing time.
    const id = String(body.itemId ?? "");
    const mark = body.mark === "watched" || body.mark === "unwatched" ? body.mark : null;
    if (!itemById(id)) return json(res, 404, { error: "unknown item" });
    historyFile.update((h) => {
      h.manual = { ...h.manual };
      if (mark) h.manual[id] = mark;
      else delete h.manual[id];
      if (mark && !h.recent.some((r) => r.itemId === id)) h.recent.unshift({ at: Date.now(), itemId: id, channel: "" });
    });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/forget" && m === "POST") {
    const id = String(body.itemId ?? "");
    historyFile.update((h) => {
      delete h.spans[id];
      if (h.manual) delete h.manual[id];
      h.recent = h.recent.filter((r) => r.itemId !== id);
    });
    ledger = WatchLedger.import(historyFile.get().spans);
    return json(res, 200, { ok: true });
  }
  if (p === "/api/history/export") {
    const h = historyFile.get();
    return download(res, "debridtv-history.json", {
      exportedAt: new Date().toISOString(), app: "DebridTV", version: VERSION, watchedThreshold: 0.9,
      note: "Viewing history only. No keys, links or account details.",
      recent: h.recent.map((r) => historyRow(r, h)), spans: h.spans, manual: h.manual ?? {},
    });
  }
  if (p === "/api/livesubs") {
    // Text subtitles for a compatibility stream, times relative to the stream's start (the /api/livestart zero).
    const tok = url.searchParams.get("tok") ?? "";
    const st = liveSubs.get(tok);
    const zero = liveStarts.get(tok);
    if (!st) return json(res, 404, { error: "no subtitles for this stream" });
    if (zero == null) return json(res, 200, { cues: [], done: false, pending: true });
    const since = Number(url.searchParams.get("since") ?? 0);
    return json(res, 200, {
      cues: st.cues.filter((c) => c.n > since).map((c) => ({ n: c.n, startMs: c.startMs - zero, endMs: c.endMs - zero, text: c.text })),
      done: st.done,
    });
  }
  if (p === "/api/livestart") {
    const v = liveStarts.get(url.searchParams.get("tok") ?? "");
    return v == null ? json(res, 404, { pending: true }) : json(res, 200, { startMs: v });
  }
  if (p === "/api/meters") return json(res, 200, meters.snapshot());
  if (p === "/api/metadata" && m === "GET") return json(res, 200, online.status());
  if (p === "/api/metadata" && m === "POST") {
    // { key } checks a TMDB key with TMDB (one request) and keeps it on this PC; { key: null } turns online metadata off.
    if (!("key" in body)) return json(res, 400, { error: "key missing" });
    const r = await online.setKey(typeof body.key === "string" ? body.key : null);
    if (!r.ok) return json(res, 400, { error: r.error });
    meters.log("api", online.enabled() ? "TMDB key saved; online posters and descriptions are on" : "Online posters and descriptions turned off");
    if (online.enabled()) rebuild();
    return json(res, 200, online.status());
  }
  if (p === "/api/sources" && m === "GET") return json(res, 200, sourcesView());
  if (p === "/api/sources" && m === "POST") {
    const { provider, key, dirs } = body as { provider: string; key?: string; dirs?: string[] };
    if (provider === "torbox" || provider === "realdebrid") {
      const k = String(key ?? "").trim();
      if (!/^[\w-]{16,128}$/.test(k)) return json(res, 400, { error: "That doesn't look like an API key." });
      const previous = provider === "torbox" ? config.get().torboxKey : config.get().rdToken;
      config.update((c) => {
        if (provider === "torbox") c.torboxKey = k;
        else c.rdToken = k;
      }, { secret: true });
      if (previous !== k) library.forgetAccount(provider);
      try {
        // Two reads: the account (plan and premium end), then the library list.
        const account = await library.checkAccount(provider);
        const r = await library.refresh(provider);
        scheduleRebuild();
        return json(res, 200, { ok: true, ...r, account: { plan: account.plan ?? null, premium: account.premium ?? null, premiumUntil: account.premiumUntilMs ?? null } });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === "auth") {
          config.update((c) => {
            if (provider === "torbox") delete c.torboxKey;
            else delete c.rdToken;
          }, { secret: true });
          library.forgetAccount(provider);
          return json(res, 400, { error: `${PROVIDER_NAMES[provider]} rejected this key. Nothing was saved.` });
        }
        return json(res, 502, { error: plainError(e) });
      }
    }
    if (provider === "local") {
      const list = (dirs ?? []).map((d) => resolve(String(d))).filter((d) => existsSync(d) && statSync(d).isDirectory());
      config.update((c) => {
        c.localDirs = list;
      });
      const n = library.refreshLocal();
      scheduleRebuild();
      return json(res, 200, { ok: true, files: n, dirs: list });
    }
    return json(res, 400, { error: "unknown provider" });
  }
  if (p === "/api/sources/disconnect" && m === "POST") {
    // Removing a provider deletes its key (gate A4). Library facts stay for history.
    const provider = String(body.provider);
    library.stopScan("Provider disconnected");
    if (provider === "torbox" || provider === "realdebrid") library.forgetAccount(provider);
    config.update((c) => {
      if (provider === "torbox") delete c.torboxKey;
      if (provider === "realdebrid") delete c.rdToken;
      if (provider === "local") c.localDirs = [];
    }, { secret: true });
    scheduleRebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/sources/refresh" && m === "POST") {
    const provider = String(body.provider);
    if (!isConnected(provider)) return json(res, 409, { error: "not connected" });
    try {
      if (provider === "local") {
        const files = library.refreshLocal();
        scheduleRebuild();
        return json(res, 200, { ok: true, files });
      }
      const account = await library.checkAccount(provider as RemoteProvider);
      const r = await library.refresh(provider as RemoteProvider);
      scheduleRebuild();
      return json(res, 200, { ok: true, ...r, premium: account.premium ?? null });
    } catch (e) {
      return json(res, 502, { error: plainError(e) });
    }
  }
  if (p === "/api/sources/account" && m === "POST") {
    const provider = String(body.provider);
    if ((provider !== "torbox" && provider !== "realdebrid") || !isConnected(provider)) return json(res, 409, { error: "not connected" });
    try {
      const a = await library.checkAccount(provider);
      scheduleRebuild();
      return json(res, 200, { ok: true, plan: a.plan ?? null, premium: a.premium ?? null, premiumUntil: a.premiumUntilMs ?? null, error: a.error ?? null });
    } catch (e) {
      return json(res, 400, { error: plainError(e) });
    }
  }
  if (p === "/api/scan/start" && m === "POST") {
    if (typeof body.perMinute === "number") config.update((c) => {
      c.scanPerMinute = Math.max(1, Math.min(120, body.perMinute as number));
    }, { secret: true });
    void library.runScan().then(() => scheduleRebuild());
    return json(res, 200, { ok: true });
  }
  if (p === "/api/scan/stop" && m === "POST") {
    library.stopScan();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/scan/retry-failed" && m === "POST") {
    return json(res, 200, { ok: true, cleared: library.retryFailedProbes() });
  }
  if (p === "/api/library/files") {
    // Every file, with its state in plain words. Reads only local facts: no provider calls.
    const want = url.searchParams.get("status") ?? "";
    const prov = url.searchParams.get("provider") ?? "";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
    const counts = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0])) as Record<string, number>;
    const rows: Array<{ it: LibItem; status: string; message: string }> = [];
    const copies = copiesById(liveLibrary());
    for (const it of liveLibrary()) {
      if (prov && it.provider !== prov) continue;
      if (q && !`${displayTitle(it)} ${it.name}`.toLowerCase().includes(q)) continue;
      const st = fileStatus(it, accountOf(it.provider));
      counts[st.status]!++;
      if (!want || want === st.status) rows.push({ it, ...st });
    }
    rows.sort((a, b) => STATUS_ORDER.indexOf(a.status as never) - STATUS_ORDER.indexOf(b.status as never) || displayTitle(a.it).localeCompare(displayTitle(b.it)));
    return json(res, 200, {
      counts, total: rows.length, offset, limit,
      files: rows.slice(offset, offset + limit).map(({ it, status, message }) => ({
        id: it.id, title: displayTitle(it), name: it.name, provider: it.provider, status, message, art: artView(it),
        kind: it.parsed.kind, durationMs: it.durationMs, bytes: it.bytes, providerState: it.providerState,
        container: it.container, video: it.video, audio: it.audio, excluded: !!it.excluded, nameBlocked: it.nameBlocked ?? null,
        checkedAt: it.availabilityAt ?? null, playableAt: it.playableAt ?? null, goneAt: it.goneAt ?? null,
        etagChanges: it.etagChanges ?? 0, watched: isWatched(it.id, it.durationMs), seenMs: ledger.seenMs(it.id),
        ...(copies.has(it.id) ? { copies: copies.get(it.id) } : {}),
      })),
    });
  }
  if (p === "/api/library/exclude" && m === "POST") {
    if (!library.setExcluded(String(body.id ?? ""), !!body.excluded)) return json(res, 404, { error: "unknown item" });
    return json(res, 200, { ok: true });
  }
  if (p === "/api/library/check" && m === "POST") {
    // The viewer asked: is this one playable right now? One link request, nothing more.
    const it = library.get(String(body.id ?? ""));
    if (!it || !isConnected(it.provider)) return json(res, 404, { error: "unknown item" });
    const st = fileStatus(it, accountOf(it.provider));
    // A file kept off only by its name was never asked about, so one check is allowed.
    if (st.status === "refused" && !it.nameBlocked) return json(res, 409, { error: "refused", message: st.message });
    if (st.status === "not-ready") return json(res, 409, { error: "not-ready", message: st.message });
    if (st.status === "gone") return json(res, 409, { error: "gone", message: st.message });
    if (it.provider === "local") {
      const ok = existsSync(it.ref);
      library.markAvailability(it.id, ok ? "playable" : "unavailable", ok ? undefined : "The file is gone from disk");
      return json(res, 200, { ok, message: ok ? "The file is on disk." : "The file is gone from disk." });
    }
    const client = library.client(it.provider)!;
    try {
      library.grants.invalidate(client, it.ref);
      await library.grants.get(client, it.ref);
      if (it.nameBlocked) {
        library.clearNameBlock(it.id);
        scheduleRebuild();
      }
      library.markAvailability(it.id, "playable");
      return json(res, 200, { ok: true, message: `${PROVIDER_NAMES[it.provider]} gave a playback link just now.` });
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        library.markAvailability(it.id, "policy-blocked", `${PROVIDER_NAMES[it.provider]} refused this file`);
        scheduleRebuild();
        return json(res, 200, { ok: false, message: `${PROVIDER_NAMES[it.provider]} refused this file. DebridTV won't retry it or fetch it elsewhere.` });
      }
      if (!(e instanceof ProviderError && e.kind === "rate-limited")) library.markAvailability(it.id, "unavailable", plainError(e));
      return json(res, 200, { ok: false, message: `${plainError(e)}.` });
    }
  }
  if (p === "/api/lock" && m === "GET") return json(res, 200, { ...pin.status(), lockedChannels: pin.pinSet() ? lineup().lockedKeys().length : 0 });
  if (p === "/api/lock/pin" && m === "POST") {
    // Set ({pin}), change ({old, pin}) or remove ({old, pin: null}) the parental PIN.
    const r = await pin.setPin(body.old, body.pin === undefined ? "" : body.pin);
    if (!r.ok) return json(res, r.status, { error: r.error, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) });
    let unlockedChannels = 0;
    if (body.pin === null) unlockedChannels = liveLineup.clearLocks() + demoLineup.clearLocks();
    lockGen++;
    return json(res, 200, { ok: true, ...pin.status(), ...(body.pin === null ? { unlockedChannels } : {}) });
  }
  if (p === "/api/lock/unlock" && m === "POST") {
    const r = await pin.unlock(body.pin);
    if (!r.ok) return json(res, r.status, { ok: false, error: r.error, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) });
    meters.log("lock", "Locked channels unlocked with the PIN");
    return json(res, 200, { ok: true, untilMs: r.untilMs });
  }
  if (p === "/api/lock/lock" && m === "POST") {
    pin.lock();
    return json(res, 200, { ok: true, ...pin.status() });
  }
  if (p === "/api/export") {
    // N-26a: everything (choices, ratings, folders) or the channel lineup alone.
    const all = settingsExport();
    if (url.searchParams.get("only") !== "lineup") return download(res, "debridtv-settings.json", all);
    return download(res, "debridtv-lineup.json", { exportedAt: all.exportedAt, app: all.app, version: all.version,
      note: "Channel lineup only: numbers, names, custom channels and per-channel choices.", lineup: all.lineup });
  }
  if (p === "/api/backups" && m === "GET") {
    const keep = config.get().backupKeep ?? 14;
    return json(res, 200, { keep, folder: backupDir(), backups: listBackups(backupDir()) });
  }
  if (p === "/api/backups" && m === "POST") {
    // { keep } changes how many daily backups are kept (0 = no automatic backups); { now: true } writes one now.
    if (typeof body.keep === "number") config.update((c) => {
      c.backupKeep = Math.max(0, Math.min(90, Math.round(body.keep as number)));
    }, { secret: true });
    const made = body.now === true ? backupIfDue(backupDir(), settingsExport(), Date.now(), config.get().backupKeep ?? 14, true) : null;
    return json(res, 200, { keep: config.get().backupKeep ?? 14, made, backups: listBackups(backupDir()) });
  }
  if (p === "/api/backups/restore" && m === "POST") {
    if (guarded()) return json(res, 403, PIN_NEEDED);
    const data = readBackup(backupDir(), String(body.name ?? ""));
    if (!data) return json(res, 404, { error: "No such backup." });
    return importSettings(res, data as Record<string, unknown>);
  }
  if (p === "/api/import" && m === "POST") return guarded() ? json(res, 403, PIN_NEEDED) : importSettings(res, body);
  if (p === "/api/forget" && m === "POST") {
    // Everything DebridTV knows, gone: keys, library facts, history, channels.
    if (body.confirm !== "forget everything") return json(res, 400, { error: "confirmation missing" });
    library.stopScan("Everything was forgotten");
    config.set({}, { secret: true });
    library.clear();
    historyFile.set({ spans: {}, recent: [], manual: {} });
    ledger = new WatchLedger();
    liveLineup.reset();
    demoLineup.reset();
    rmSync(backupDir(), { recursive: true, force: true });
    online.forget();
    edge.clear();
    pin.clear();
    meters.cache = { bytes: 0, files: 0 };
    rebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/ondemand" && m === "GET") {
    const k = url.searchParams.get("kind");
    return json(res, 200, onDemandBrowse(onDemandDeps(), url.searchParams.get("q") ?? "", k === "show" || k === "movie" ? k : "all"));
  }
  if (p === "/api/ondemand/show" && m === "GET") {
    const v = onDemandShow(onDemandDeps(), url.searchParams.get("key") ?? "");
    return v ? json(res, 200, v) : json(res, 404, { error: "no such show" });
  }
  if (p === "/api/continue" && m === "GET") {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20));
    return json(res, 200, continueWatching(onDemandDeps(), historyFile.get().recent, limit));
  }
  if (p === "/api/silence" && m === "GET") {
    const local = silenceTargets(true);
    return json(res, 200, { ...silenceJob.state, ffmpeg: !!ffmpeg, eligible: local.length, pending: silenceTargets().length,
      withBreaks: local.filter((t) => itemById(t.id)?.silence?.breaksMs.length).length });
  }
  if (p === "/api/silence/start" && m === "POST") {
    // N-22c: viewer-started, local files only. Decodes the soundtrack on this PC; no provider is involved.
    if (!ffmpeg) return json(res, 409, { error: "Finding silences needs ffmpeg on this PC." });
    if (body.again === true) for (const t of silenceTargets(true)) library.clearSilence(t.id);
    const targets = silenceTargets();
    void silenceJob.run(targets, (id, r, ms) => {
      library.setSilence(id, r);
      meters.log("silence", "error" in r ? `${itemById(id)?.name.slice(0, 40)}: ${r.error}` : `${r.breaksMs.length} break${r.breaksMs.length === 1 ? "" : "s"} from ${r.silences} silences in ${(ms / 1000).toFixed(1)} s`);
    }).then(() => scheduleRebuild());
    return json(res, 200, { ok: true, total: targets.length });
  }
  if (p === "/api/silence/stop" && m === "POST") {
    silenceJob.halt();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/library") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const items = allItems().filter((i) => i.parsed.kind !== "other" && i.present);
    const shows = new Map<string, { key: string; name: string; episodes: number; timed: number }>();
    const movies: Array<{ id: string; title: string; year?: number; timed: boolean }> = [];
    for (const i of items) {
      if (i.parsed.kind === "episode") {
        const s = shows.get(i.parsed.showKey) ?? { key: i.parsed.showKey, name: i.parsed.show, episodes: 0, timed: 0 };
        s.episodes++;
        if (i.durationMs) s.timed++;
        shows.set(i.parsed.showKey, s);
      } else if (i.parsed.kind === "movie") movies.push({ id: i.id, title: i.parsed.title, year: i.parsed.year, timed: !!i.durationMs });
    }
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    return json(res, 200, {
      shows: [...shows.values()].filter((s) => match(s.name)).sort((a, b) => b.episodes - a.episodes),
      movies: movies.filter((x) => match(x.title)).sort((a, b) => a.title.localeCompare(b.title)),
    });
  }
  if (p === "/api/ratings" && m === "GET") {
    // Age ratings per show and film: the viewer's pick, the .nfo's, or none. Local facts only.
    const manual = library.manualRatings();
    const shows = new Map<string, { key: string; name: string; episodes: number; rating: string | null; from: string | null; nfo: string | null }>();
    const movies: Array<{ id: string; title: string; rating: string | null; from: string | null; nfo: string | null }> = [];
    for (const it of allItems()) {
      if (!it.present || it.parsed.kind === "other") continue;
      const r = effectiveRating(it, manual);
      if (it.parsed.kind === "episode") {
        const k = it.parsed.showKey;
        const s = shows.get(k) ?? { key: k, name: it.parsed.show, episodes: 0, rating: null, from: null, nfo: null };
        s.episodes++;
        const showR = manual.shows[k];
        if (showR) (s.rating = showR), (s.from = "you");
        else if (r && !s.rating) (s.rating = r.rating), (s.from = r.from);
        if (!s.nfo && it.meta?.ratingText) s.nfo = it.meta.ratingText;
        shows.set(k, s);
      } else movies.push({ id: it.id, title: displayTitle(it), rating: r?.rating ?? null, from: r?.from ?? null, nfo: it.meta?.ratingText ?? null });
    }
    return json(res, 200, { scale: RATINGS, shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)), movies: movies.sort((a, b) => a.title.localeCompare(b.title)) });
  }
  if (p === "/api/ratings" && m === "POST") {
    if (guarded()) return json(res, 403, PIN_NEEDED);
    const b = body as { showKey?: unknown; itemId?: unknown; rating?: unknown };
    const rating = b.rating === null || b.rating === "" ? null : normalizeRating(String(b.rating ?? ""));
    if (b.rating != null && b.rating !== "" && !rating) return json(res, 400, { error: "Ratings are G, PG, PG-13, R or NC-17 (TV ratings like TV-14 are accepted too)." });
    const ok = library.setRating({ showKey: typeof b.showKey === "string" ? b.showKey : undefined, itemId: typeof b.itemId === "string" ? b.itemId : undefined }, rating);
    if (!ok) return json(res, 400, { error: "Say which show (showKey) or file (itemId)." });
    scheduleRebuild();
    return json(res, 200, { ok: true, rating });
  }
  if (p === "/api/channels" && m === "GET") {
    const l = lineup();
    return json(res, 200, { channels: l.allChannels().map((c) => ({ ...channelView(c), hidden: l.hidden().includes(c.meta.ruleKey),
      items: c.revisions[c.revisions.length - 1]!.itemIds.length, ordering: c.revisions[c.revisions.length - 1]!.ordering })), custom: l.custom() });
  }
  let settingsNote = "";
  const chSettings = /^\/api\/channels\/([\w-]+)\/settings$/.exec(p);
  if (chSettings) {
    const l = lineup();
    const ch = l.allChannels().find((c) => c.id === chSettings[1]);
    if (!ch) return json(res, 404, { error: "no such channel" });
    if (m === "PUT" || m === "POST") {
      const b = body as Record<string, unknown>;
      // Locking a channel is always allowed; turning one off or changing what airs needs the PIN while the guard is up.
      if (b.locked === true && !pin.pinSet()) return json(res, 409, { error: "Set a parental PIN first (Settings, Privacy).", pinRequired: true });
      const free = new Set(["favorite", "locked"]);
      if (guarded() && (b.locked === false || Object.keys(b).some((k) => !free.has(k)))) return json(res, 403, PIN_NEEDED);
      const logo = b.logo === null ? null : b.logo === undefined ? undefined : cleanLogo(b.logo);
      if (b.logo != null && !logo) return json(res, 400, { error: "A logo is up to 6 letters (badge or text), or an inline image (data: URL). No outside images." });
      const restrictedHours = b.restrictedHours === undefined ? undefined : cleanRestricted(b.restrictedHours);
      if (restrictedHours === null) return json(res, 400, { error: "Restricted hours need from/to as HH:MM and a rating G, PG, PG-13, R or NC-17." });
      const slots = b.slots === undefined ? undefined : cleanSlots(b.slots);
      if (slots === null) return json(res, 400, { error: "Each time slot needs days 1-7, from/to as HH:MM and a source (dates, if any, as MM-DD)." });
      const weights = b.weights === undefined ? undefined : cleanWeights(b.weights);
      if (weights === null) return json(res, 400, { error: "Weights are 0 to 100 per show." });
      const exclude = b.exclude === undefined ? undefined : cleanExclusions(b.exclude);
      if (exclude === null) return json(res, 400, { error: "Exclusions are lists of show keys and genre names." });
      const season = b.season === undefined || b.season === null ? b.season : cleanDates(b.season);
      if (season === null && b.season !== null) return json(res, 400, { error: "A season is {from, to} as MM-DD, like 10-01 to 10-31." });
      const r = l.updateSettings(ch.meta.ruleKey, {
        name: typeof b.name === "string" || b.name === null ? (b.name as string | null) : undefined,
        number: typeof b.number === "number" ? b.number : undefined,
        favorite: typeof b.favorite === "boolean" ? b.favorite : undefined,
        logo: logo as never,
        kid: typeof b.kid === "boolean" ? b.kid : undefined,
        restrictedHours,
        slots,
        specials: typeof b.specials === "boolean" ? b.specials : undefined,
        weights: weights ?? undefined,
        balance: b.balance === "time" || b.balance === "episodes" ? b.balance : undefined,
        marathons: typeof b.marathons === "boolean" ? b.marathons : undefined,
        premieres: typeof b.premieres === "boolean" ? b.premieres : undefined,
        watched: b.watched === "all" || b.watched === "unwatched" || b.watched === "resume" ? b.watched : undefined,
        exclude: exclude ?? undefined,
        locked: typeof b.locked === "boolean" ? b.locked : undefined,
        season: season as { from: string; to: string } | null | undefined,
      });
      lockGen++;
      if (!r.ok) return json(res, 409, { error: r.error });
      scheduleRebuild();
      if (r.swappedWith) settingsNote = `Swapped numbers with ${r.swappedWith}.`;
    }
    const c = l.allChannels().find((x) => x.id === chSettings[1])!;
    const st = l.settingsFor(c.meta.ruleKey);
    return json(res, 200, { name: c.name, number: c.number, favorite: !!st.favorite, logo: st.logo ?? null,
      kid: !!st.kid, restrictedHours: st.restrictedHours ?? [], slots: st.slots ?? [],
      specials: !!st.specials, specialsAvailable: specialsOf(c),
      weights: st.weights ?? {}, balance: st.balance ?? "episodes", marathons: !!st.marathons, premieres: !!st.premieres,
      watched: st.watched ?? "all", exclude: st.exclude ?? {}, groups: channelGroups(c), season: seasonView(st.season),
      // The clock enforces all three; changes start once the program on now ends (C7).
      enforced: true, timeZone: stationTimeZone(), ratings: ratingCoverage(c), ...lockView(st), pinSet: pin.pinSet(), alsoOn: alsoOn(c),
      ...(settingsNote ? { note: settingsNote } : {}) });
  }
  const refresh = /^\/api\/channels\/([\w-]+)\/refresh$/.exec(p);
  if (refresh && m === "POST") {
    // N-10: a fresh shuffle, starting when the program on now ends.
    const l = lineup();
    const ch = l.allChannels().find((c) => c.id === refresh[1]);
    if (!ch) return json(res, 404, { error: "no such channel" });
    l.updateSettings(ch.meta.ruleKey, { reshuffle: true });
    rebuild();
    const cur = l.allChannels().find((c) => c.id === ch.id)!;
    return json(res, 200, { ok: true, fromMs: cur.revisions[cur.revisions.length - 1]!.effectiveFromMs });
  }
  if (p === "/api/exclusions") {
    // N-09b: shows and genres kept off every channel.
    if (m === "POST" || m === "PUT") {
      const ex = cleanExclusions(body);
      if (!ex) return json(res, 400, { error: "Exclusions are lists of show keys and genre names." });
      lineup().setExclusions(ex);
      scheduleRebuild();
    }
    // Choices for the dialog: every show and genre in the library, with how many files each has.
    const shows = new Map<string, { key: string; name: string; count: number }>();
    const genres = new Map<string, { name: string; count: number }>();
    for (const it of allItems()) {
      if (!it.present || it.parsed.kind === "other") continue;
      if (it.parsed.kind === "episode") {
        const sh = shows.get(it.parsed.showKey) ?? { key: it.parsed.showKey, name: it.parsed.show, count: 0 };
        sh.count++;
        shows.set(it.parsed.showKey, sh);
      }
      for (const g of it.meta?.genres ?? (it.genre ? [it.genre] : [])) {
        const k = g.toLowerCase();
        const gg = genres.get(k) ?? { name: g, count: 0 };
        gg.count++;
        genres.set(k, gg);
      }
    }
    return json(res, 200, { ...lineup().exclusions(), options: {
      shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)),
      genres: [...genres.values()].sort((a, b) => a.name.localeCompare(b.name)) } });
  }
  if (p === "/api/groups" && m === "GET") return json(res, 200, groupsView());
  if (p === "/api/groups" && m === "POST") {
    // N-07: create or change a content group. Changing one changes what airs, so the PIN guard applies.
    if (guarded()) return json(res, 403, PIN_NEEDED);
    const id = typeof body.id === "string" && body.id ? body.id : undefined;
    const g = cleanGroup(body, id);
    if (!g) return json(res, 400, { error: "A group needs a name (up to 40 letters) and a list of shows ({kind:'show', key}) and films ({kind:'movie', id})." });
    lineup().saveGroup(g);
    rebuild();
    return json(res, 200, { ok: true, group: groupsView().groups.find((x) => x.id === g.id) });
  }
  if (p === "/api/presets" && m === "GET") return json(res, 200, { presets: presetsView() });
  if (p === "/api/presets" && m === "POST") {
    // N-02a: add (or refresh) a seasonal preset as a content group with its own channel and dates.
    if (guarded()) return json(res, 403, PIN_NEEDED);
    const preset = SEASONAL_PRESETS.find((x) => x.id === body.id);
    if (!preset) return json(res, 404, { error: "No such preset." });
    const found = presetMatches(preset, usableLibrary(allItems(), idsOf).usable);
    if (!found.entries.length) return json(res, 409, { error: `Nothing in your library fits ${preset.name} yet.` });
    const l = lineup();
    l.saveGroup({ id: preset.id, name: l.groups().find((g) => g.id === preset.id)?.name ?? preset.name, description: preset.description,
      entries: found.entries, ordering: preset.ordering, channel: true });
    rebuild();
    const r = l.updateSettings(`group:${preset.id}`, { season: preset.season });
    if (r.ok) rebuild();
    return json(res, 200, { ok: true, preset: presetsView().find((x) => x.id === preset.id) });
  }
  if (p === "/api/groups/delete" && m === "POST") {
    if (guarded()) return json(res, 403, PIN_NEEDED);
    if (!lineup().deleteGroup(String(body.id ?? ""))) return json(res, 404, { error: "No such group." });
    rebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/hide" && m === "POST") {
    lineup().setHidden(String(body.ruleKey), !!body.hidden);
    lockGen++;
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/custom" && m === "POST") {
    if (guarded()) return json(res, 403, PIN_NEEDED);
    const c = body as unknown as CustomChannel;
    const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : null);
    const showKeys = list(c.showKeys), movieIds = list(c.movieIds), groupIds = list(c.groupIds);
    if (!c.name || !showKeys || !movieIds || !groupIds || !(showKeys.length + movieIds.length + groupIds.length)) return json(res, 400, { error: "bad channel" });
    const known = new Set(lineup().groups().map((g) => g.id));
    if (groupIds.some((g) => !known.has(g))) return json(res, 400, { error: "No such content group." });
    lineup().saveCustom({ id: c.id || Math.random().toString(36).slice(2, 9), name: String(c.name).slice(0, 40), showKeys, movieIds,
      ordering: ORDERINGS.includes(c.ordering) ? c.ordering : "block-shuffle", slotMinutes: typeof c.slotMinutes === "number" ? c.slotMinutes : 30,
      ...(groupIds.length ? { groupIds: groupIds.slice(0, 50) } : {}) });
    rebuild();
    return json(res, 200, { ok: true });
  }
  if (p === "/api/channels/custom/delete" && m === "POST") {
    if (guarded()) return json(res, 403, PIN_NEEDED);
    lineup().deleteCustom(String(body.id));
    rebuild();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "no route" });
}

function serveStatic(res: http.ServerResponse, p: string) {
  const rel = p === "/" ? "index.html" : p.slice(1);
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) return json(res, 404, { error: "not found" });
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(readFileSync(file));
}

// ---------------------------------------------------------------- content groups (N-07)

/** Each group's programs as the channels see them (usable, deduplicated library); recomputed per rebuild. */
let groupSets: { gen: number; l: Lineup; sets: Map<string, string[]> } | null = null;
function groupPrograms(): Map<string, string[]> {
  const l = lineup();
  if (!groupSets || groupSets.gen !== lockGen || groupSets.l !== l) {
    const rules = autoRules(allItems(), l.custom(), l.groups(), idsOf);
    const sets = new Map<string, string[]>();
    for (const g of l.groups()) sets.set(g.id, rules.find((r) => r.key === `group:${g.id}`)?.itemIds ?? []);
    groupSets = { gen: lockGen, l, sets };
  }
  return groupSets.sets;
}
/** Groups a channel draws on: its own, those a custom channel includes, and those its slots air. */
function groupsOf(c: StationChannel): string[] {
  const l = lineup();
  const out = new Set<string>();
  if (c.meta.ruleKey.startsWith("group:")) out.add(c.meta.ruleKey.slice(6));
  if (c.meta.ruleKey.startsWith("custom:")) for (const g of l.custom().find((x) => `custom:${x.id}` === c.meta.ruleKey)?.groupIds ?? []) out.add(g);
  for (const sl of l.settingsFor(c.meta.ruleKey).slots ?? []) if (sl.source.startsWith("group:")) out.add(sl.source.slice(6));
  return [...out];
}
/** The group an airing comes from, for the guide's description: the first of the channel's groups that holds it. */
function groupForAiring(c: StationChannel): (itemId: string) => { id: string; name: string; description?: string } | undefined {
  const ids = groupsOf(c);
  if (!ids.length) return () => undefined;
  const progs = groupPrograms();
  const groups = lineup().groups().filter((g) => ids.includes(g.id));
  return (itemId) => {
    const g = groups.find((x) => progs.get(x.id)?.includes(itemId));
    return g ? { id: g.id, name: g.name, ...(g.description ? { description: g.description } : {}) } : undefined;
  };
}
/** Seasonal presets the library has enough for, and the ones already added (N-02a). Local facts only. */
function presetsView() {
  const l = lineup();
  const usable = usableLibrary(allItems(), idsOf).usable;
  return SEASONAL_PRESETS.flatMap((p) => {
    const found = presetMatches(p, usable);
    const channel = l.allChannels().find((c) => c.meta.ruleKey === `group:${p.id}`);
    const added = l.groups().some((g) => g.id === p.id);
    const enough = found.shows + found.films >= PRESET_MIN_TITLES && found.hours >= PRESET_MIN_HOURS;
    if (!enough && !added) return [];
    return [{
      id: p.id, name: p.name, description: p.description, season: seasonView(p.season), shows: found.shows, films: found.films, hours: found.hours, added,
      ...(channel ? { channel: { id: channel.id, number: channel.number, name: channel.name } } : {}),
    }];
  });
}

function groupsView() {
  const l = lineup();
  const progs = groupPrograms();
  // One row per way a channel uses the group: its own channel, inside a custom channel, or in a time slot.
  const usedBy = (id: string) => l.allChannels().flatMap((c) => {
    const hows = [
      c.meta.ruleKey === `group:${id}` && "own",
      c.meta.ruleKey.startsWith("custom:") && l.custom().find((x) => `custom:${x.id}` === c.meta.ruleKey)?.groupIds?.includes(id) && "custom",
      l.settingsFor(c.meta.ruleKey).slots?.some((sl) => sl.source === `group:${id}`) && "slot",
    ].filter((h): h is string => !!h);
    return hows.map((how) => ({ id: c.id, number: c.number, name: c.name, how }));
  });
  const items = allItems().filter((i) => i.present && i.parsed.kind !== "other");
  const shows = new Map<string, { key: string; name: string; episodes: number }>();
  const movies: Array<{ id: string; title: string; year?: number }> = [];
  for (const i of items) {
    if (i.parsed.kind === "episode") {
      const sh = shows.get(i.parsed.showKey) ?? { key: i.parsed.showKey, name: i.parsed.show, episodes: 0 };
      sh.episodes++;
      shows.set(i.parsed.showKey, sh);
    } else if (i.parsed.kind === "movie") movies.push({ id: i.id, title: i.parsed.title, ...(i.parsed.year ? { year: i.parsed.year } : {}) });
  }
  return {
    groups: l.groups().map((g) => {
      const ids = progs.get(g.id) ?? [];
      const ms = ids.reduce((n, id) => n + (itemById(id)?.durationMs ?? 0), 0);
      return { ...g, description: g.description ?? "", channel: !!g.channel, ruleKey: `group:${g.id}`, programs: ids.length, hours: Math.round(ms / 360_000) / 10, usedBy: usedBy(g.id) };
    }),
    options: { shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)), movies: movies.sort((a, b) => a.title.localeCompare(b.title)) },
  };
}

/** On Demand reads the library and history only: 0 provider calls, 0 bytes (N-30). */
function onDemandDeps(): OnDemandDeps {
  const manual = library.manualRatings();
  const items = allItems().filter((i) => i.present);
  const copies = copiesById(items);
  return {
    items,
    ids: idsOf,
    seenMs: (id) => ledger.seenMs(id),
    furthestMs: (id) => ledger.furthestMs(id),
    watched: (id, d) => isWatched(id, d),
    locked: (id) => lockedItem(id),
    extra: (it) => ({
      rating: effectiveRating(it, manual)?.rating ?? null,
      description: it.meta?.plot ?? online.text(it)?.overview,
      ...availabilityView(it),
      art: artView(it),
      codecs: { container: it.container, video: it.video, audio: it.audio, ...mediaBadges(it) },
      // Every place this title lives, the copy that plays first (N-01d).
      sources: copies.get(it.id)?.map((c) => c.provider) ?? [it.provider],
    }),
  };
}

function historyRow(r: HistoryState["recent"][number], h: HistoryState) {
  const it = itemById(r.itemId);
  return { ...r, title: it ? displayTitle(it) : "Removed item", seenMs: ledger.seenMs(r.itemId), durationMs: it?.durationMs ?? null,
    watched: isWatched(r.itemId, it?.durationMs), manual: h.manual?.[r.itemId] ?? null };
}

// Keep channels in step as time passes (rules may add items as scans finish).
const tick = opts.timers === false ? null : setInterval(() => (scheduleRebuild(), dailyBackup()), 5 * MIN);
if (opts.timers !== false) setTimeout(dailyBackup, 10_000).unref();
tick?.unref();

return {
  server,
  library,
  meters,
  get port() {
    return port;
  },
  listen(): Promise<number> {
    return new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        port = (server.address() as AddressInfo).port;
        lan.start(server, port).then(() => resolveListen(port), reject);
      });
    });
  },
  close(): Promise<void> {
    if (tick) clearInterval(tick);
    if (rebuildTimer) clearTimeout(rebuildTimer);
    library.stopScan("Shutting down");
    silenceJob.halt();
    online.stop();
    return lan.stop().then(() => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }));
  },
  isDemo,
  lan,
  ffmpeg: !!ffmpeg,
};
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function download(res: http.ServerResponse, name: string, body: unknown) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="${name}"` });
  res.end(JSON.stringify(body, null, 1));
}

function detectFfmpeg(): string | null {
  return detect([process.env.FFMPEG, "ffmpeg"]);
}
function detectFfprobe(ffmpeg: string): string | null {
  // ffprobe ships next to ffmpeg in every common Windows/macOS/Linux build.
  const sibling = /ffmpeg(\.exe)?$/i.test(ffmpeg) ? ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe")) : null;
  return detect([process.env.FFPROBE, sibling, "ffprobe"]);
}
function detect(list: Array<string | null | undefined>): string | null {
  const candidates = list.filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["-version"], { timeout: 4000 });
      if (r.status === 0) return c;
    } catch {}
  }
  return null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = await app.listen();
  console.log(`\n  📺  DebridTV is on the air:  http://${HOST}:${port}\n`);
  console.log(`  Mode: ${app.isDemo() ? "demo (connect a source in Settings)" : "your library"}`);
  console.log(`  Compatibility mode (ffmpeg): ${app.ffmpeg ? "available" : "not found — some files may not play in the browser"}`);
  console.log(`  Home network: ${app.lan.enabled ? "on (paired TVs and phones can open it)" : "off (turn on at http://" + HOST + ":" + port + "/lan)"}`);
  console.log(`  Data folder: ${dataDir()}\n`);
}
