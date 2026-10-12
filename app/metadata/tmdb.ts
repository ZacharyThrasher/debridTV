// Online posters, backdrops and descriptions from TMDB (themoviedb.org), off until
// the viewer enters their own free TMDB key on this PC.
//
// What goes out: a show's or film's title and year, and a season number. Never
// file names, folders, provider links, accounts or viewing history. The key is kept
// in tmdb-key.json in the local data folder (owner-only), is never exported, logged
// or sent to the browser, and goes to TMDB only.
//
// What comes back is cached on disk (metadata/tmdb.json and metadata/img/), so each
// title costs TMDB a handful of requests once: a search, the logo list for a show,
// one request per season the library has, and the pictures. The guide, the player
// and the art route only ever read that cache; they never wait on TMDB.
//
// Local Kodi artwork and .nfo text always win: TMDB fills only what the viewer's
// own files don't have. Items that only PIN-locked channels carry are never looked up.

import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { JsonFile, dataDir } from "../store.ts";
import type { ArtKind, LibItem } from "../library.ts";

export const TMDB_ATTRIBUTION = "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p";
const DAY = 86_400_000;
/** A title TMDB didn't know is asked about again after this long (someone may have added it). */
const MISS_TTL = 30 * DAY;
/** A failed request (network, 5xx) is tried again after this long. */
const ERROR_BACKOFF = 15 * 60_000;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

type Media = "tv" | "movie";
/** Which TMDB picture fills which DebridTV art slot. Episode stills are not fetched. */
type OnlineKind = Extract<ArtKind, "poster" | "fanart" | "logo">;
const SIZES: Record<OnlineKind, string> = { poster: "w500", fanart: "w1280", logo: "w500" };

export interface OnlineTitle {
  id: number;
  media: Media;
  name: string;
  year?: number;
  overview?: string;
  /** File names under metadata/img once downloaded. */
  images: Partial<Record<OnlineKind, string>>;
  /** TMDB paths not downloaded yet (a failed or interrupted fetch). */
  pending?: Partial<Record<OnlineKind, string>>;
  /** Seasons fetched (episode names and overviews), or a time to try again. */
  seasons?: Record<string, { at: number; episodes: Record<string, { name?: string; overview?: string }> } | { at: number; missing: true }>;
  at: number;
}
interface CacheState {
  v: 1;
  /** "tv|the office|2005" → TMDB id, or null when TMDB had nothing. */
  lookups: Record<string, { id: number | null; at: number }>;
  titles: Record<string, OnlineTitle>;
  /** Air dates per TMDB show id, for "What's missing" (showSchedule). */
  shows?: Record<string, ShowSchedule>;
}
/** How long a show's air dates are kept before asking TMDB again. */
const SCHEDULE_TTL = 12 * 3_600_000;

export interface AirEpisode {
  season: number;
  episode: number;
  /** YYYY-MM-DD, as TMDB lists it. */
  airDate: string;
  name?: string;
}
/** What TMDB says has aired and is coming, for one show. */
export interface ShowSchedule {
  id: number;
  name: string;
  /** Every season TMDB lists (0 is specials), with its episode count so far. */
  seasons: Array<{ season: number; episodeCount: number; airDate?: string }>;
  lastAired: AirEpisode | null;
  nextAir: AirEpisode | null;
  /** Episode air dates and names, only for the season on the air now (and the one before, around a premiere). */
  episodes: Record<string, Array<{ episode: number; airDate?: string; name?: string }>>;
  at: number;
}
interface KeyState {
  key?: string;
  language?: string;
}

export interface OnlineStatus {
  enabled: boolean;
  keySet: boolean;
  /** Plain words on what is going on, for the settings card. */
  state: "off" | "idle" | "working" | "paused" | "rejected";
  message: string;
  titles: number;
  withPictures: number;
  waiting: number;
  requests: number;
  bytes: number;
  lastError?: string;
  attribution: string;
}

export interface OnlineOptions {
  apiBase?: string;
  imageBase?: string;
  /** Gap between requests. TMDB allows far more; DebridTV stays gentle. */
  spacingMs?: number;
  /** Called after new text or pictures land, so views can refresh. */
  onChange?: () => void;
  log?: (detail: string) => void;
}

interface Want {
  key: string;
  media: Media;
  title: string;
  year?: number;
  seasons: Set<number>;
}

export class OnlineMetadata {
  private readonly keyFile = new JsonFile<KeyState>("tmdb-key.json", () => ({}));
  private readonly cache: JsonFile<CacheState>;
  private readonly imgDir: string;
  private readonly apiBase: string;
  private readonly imageBase: string;
  private readonly spacingMs: number;
  private readonly onChange: () => void;
  private readonly log: (detail: string) => void;
  private running: Promise<void> | null = null;
  private again: { items: LibItem[]; skip: (id: string) => boolean } | null = null;
  private stopped = false;
  private lastRequest = 0;
  private pausedUntil = 0;
  private rejected = false;
  private waiting = 0;
  private errors = new Map<string, number>();
  requests = 0;
  bytes = 0;
  lastError: string | undefined;

  constructor(opts: OnlineOptions = {}) {
    const dir = join(dataDir(), "metadata");
    mkdirSync(join(dir, "img"), { recursive: true });
    this.cache = new JsonFile<CacheState>(join("metadata", "tmdb.json"), () => ({ v: 1, lookups: {}, titles: {} }));
    this.imgDir = join(dir, "img");
    this.apiBase = (opts.apiBase ?? process.env.DEBRIDTV_TMDB_API ?? API).replace(/\/$/, "");
    this.imageBase = (opts.imageBase ?? process.env.DEBRIDTV_TMDB_IMAGES ?? IMAGES).replace(/\/$/, "");
    this.spacingMs = opts.spacingMs ?? 250;
    this.onChange = opts.onChange ?? (() => {});
    this.log = opts.log ?? (() => {});
  }

  enabled(): boolean {
    return !!this.keyFile.get().key && !this.rejected;
  }

  /**
   * Save a key after TMDB accepts it (one request), or null to switch online
   * metadata off. Off hides everything from TMDB but keeps the cache on disk, so
   * switching back on costs no requests.
   */
  async setKey(key: string | null): Promise<{ ok: boolean; error?: string }> {
    if (key == null || !key.trim()) {
      this.keyFile.set({}, { secret: true });
      this.rejected = false;
      this.again = null;
      return { ok: true };
    }
    const k = key.trim();
    if (k.length > 2000 || /\s/.test(k)) return { ok: false, error: "That doesn't look like a TMDB key." };
    const r = await this.request("/configuration", {}, k).catch((e: Error) => ({ status: 0, error: e.message }) as const);
    if ("error" in r) return { ok: false, error: `Couldn't reach TMDB: ${r.error}` };
    if (r.status === 401) return { ok: false, error: "TMDB didn't accept this key. Use the API key (v3) or the read access token from themoviedb.org → Settings → API." };
    if (r.status !== 200) return { ok: false, error: `TMDB answered ${r.status}. Try again later.` };
    this.keyFile.set({ key: k, language: this.keyFile.get().language }, { secret: true });
    this.rejected = false;
    this.pausedUntil = 0;
    this.errors.clear();
    this.lastError = undefined;
    return { ok: true };
  }

  /** Text for an item, when the viewer's own .nfo has none. Reads the cache only. */
  text(it: LibItem | undefined): { overview?: string; name?: string } | undefined {
    const t = this.titleFor(it);
    if (!t || !it) return undefined;
    const p = it.parsed;
    if (p.kind === "episode") {
      const s = t.seasons?.[String(p.season)];
      const ep = s && "episodes" in s ? s.episodes[String(p.episode)] : undefined;
      return { overview: ep?.overview || t.overview, name: ep?.name };
    }
    return { overview: t.overview };
  }

  /** The TMDB id the cache matched to an item's film or show (dedupe, N-01d). Reads the cache only. */
  tmdbId(it: LibItem | undefined): string | undefined {
    const t = this.titleFor(it);
    return t ? String(t.id) : undefined;
  }

  /** Which picture kinds the cache has for an item. */
  kinds(it: LibItem | undefined): OnlineKind[] {
    const t = this.titleFor(it);
    return t ? (Object.keys(t.images) as OnlineKind[]) : [];
  }

  /** Absolute path of a cached picture, for the art route. */
  imageFile(it: LibItem | undefined, kind: ArtKind): string | undefined {
    const f = this.titleFor(it)?.images[kind as OnlineKind];
    if (!f) return undefined;
    const p = join(this.imgDir, f);
    return existsSync(p) ? p : undefined;
  }

  status(): OnlineStatus {
    const keySet = !!this.keyFile.get().key;
    const titles = Object.values(this.cache.get().titles);
    const state: OnlineStatus["state"] = !keySet ? "off" : this.rejected ? "rejected" : Date.now() < this.pausedUntil ? "paused" : this.running ? "working" : "idle";
    const message = {
      off: "Off. Nothing is sent to TMDB.",
      idle: "Up to date.",
      working: "Looking up titles…",
      paused: "TMDB asked DebridTV to slow down; resuming shortly.",
      rejected: "TMDB stopped accepting this key. Enter a new one.",
    }[state];
    return {
      enabled: this.enabled(), keySet, state, message,
      titles: titles.length, withPictures: titles.filter((t) => Object.keys(t.images).length).length,
      waiting: this.waiting, requests: this.requests, bytes: this.bytes,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      attribution: TMDB_ATTRIBUTION,
    };
  }

  /** Delete the key, the cache and every downloaded picture ("Forget everything"). */
  forget(): void {
    this.again = null;
    this.keyFile.set({}, { secret: true });
    this.cache.set({ v: 1, lookups: {}, titles: {} });
    rmSync(this.imgDir, { recursive: true, force: true });
    mkdirSync(this.imgDir, { recursive: true });
    this.rejected = false;
    this.errors.clear();
    this.lastError = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.again = null;
  }

  /**
   * Look up whatever the library lacks. Runs in the background, one request at a
   * time; a call while a run is going queues one more pass with the newest list.
   * `skip` names items to leave alone (PIN-locked ones).
   */
  sync(items: LibItem[], skip: (id: string) => boolean = () => false): Promise<void> {
    if (!this.enabled() || this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = { items, skip };
      return this.running;
    }
    this.running = (async () => {
      let next: { items: LibItem[]; skip: (id: string) => boolean } | null = { items, skip };
      while (next && this.enabled() && !this.stopped) {
        this.again = null;
        await this.pass(next.items, next.skip);
        next = this.again;
      }
    })().finally(() => {
      this.running = null;
      this.waiting = 0;
    });
    return this.running;
  }

  // ------------------------------------------------------------ internals

  private titleFor(it: LibItem | undefined): OnlineTitle | undefined {
    // Switched off means nothing from TMDB shows; the cache stays so switching back on is free.
    if (!this.keyFile.get().key) return undefined;
    const q = it ? queryFor(it) : undefined;
    if (!q) return undefined;
    const c = this.cache.get();
    const hit = c.lookups[q.key];
    return hit?.id != null ? c.titles[`${q.media}:${hit.id}`] : undefined;
  }

  /** What to ask for: one entry per show or film, with the seasons whose episodes lack text. */
  wants(items: LibItem[], skip: (id: string) => boolean): Want[] {
    const now = Date.now();
    const c = this.cache.get();
    const out = new Map<string, Want>();
    for (const it of items) {
      if (it.provider === "demo" || !it.present || skip(it.id)) continue;
      const q = queryFor(it);
      if (!q) continue;
      const hit = c.lookups[q.key];
      const t = hit?.id != null ? c.titles[`${q.media}:${hit.id}`] : undefined;
      const local = it.provider === "local" ? it.art ?? {} : {};
      const needsArt = !local.poster || !local.fanart || (q.media === "tv" && !local.logo);
      const needsText = !it.meta?.plot;
      if (!needsArt && !needsText) continue;
      if ((this.errors.get(q.key) ?? 0) > now) continue;
      if (hit && hit.id == null && now - hit.at < MISS_TTL) continue;
      let w = out.get(q.key);
      const add = () => (w ??= (out.set(q.key, { key: q.key, media: q.media, title: q.title, year: q.year, seasons: new Set() }), out.get(q.key)!));
      if (!hit || (hit.id == null && now - hit.at >= MISS_TTL) || (t && needsArt && t.pending && Object.keys(t.pending).length)) add();
      if (it.parsed.kind === "episode" && needsText) {
        const s = t?.seasons?.[String(it.parsed.season)];
        const retry = s && "missing" in s && now - s.at >= MISS_TTL;
        if (!t || !s || retry) add().seasons.add(it.parsed.season);
      }
    }
    return [...out.values()];
  }

  private async pass(items: LibItem[], skip: (id: string) => boolean): Promise<void> {
    const list = this.wants(items, skip);
    this.waiting = list.length;
    let changed = false;
    for (const w of list) {
      if (!this.enabled() || this.stopped) break;
      try {
        changed = (await this.fill(w)) || changed;
      } catch (e) {
        const msg = (e as Error).message;
        this.lastError = msg;
        if (this.rejected) {
          this.log("TMDB stopped accepting the key; online lookups are paused until a new one is entered");
          break;
        }
        this.errors.set(w.key, Date.now() + ERROR_BACKOFF);
        this.log(`TMDB lookup for "${w.title}" failed: ${msg}`);
      }
      this.waiting = Math.max(0, this.waiting - 1);
      if (changed) {
        // Let the guide pick up new pictures as they land, not only at the end.
        this.onChange();
        changed = false;
      }
    }
  }

  /** One show or film: search if needed, then its seasons and pictures. Returns whether anything new landed. */
  private async fill(w: Want): Promise<boolean> {
    const c = this.cache.get();
    let hit = c.lookups[w.key];
    const before = this.requests;
    let found = false;
    if (!hit || hit.id == null) {
      const params: Record<string, string> = { query: w.title, include_adult: "false" };
      if (w.year) params[w.media === "tv" ? "first_air_date_year" : "year"] = String(w.year);
      const r = await this.getJson<{ results?: TmdbResult[] }>(`/search/${w.media}`, params);
      const best = pick(r.results ?? [], w);
      this.cache.update((s) => {
        s.lookups[w.key] = { id: best?.id ?? null, at: Date.now() };
        if (best) {
          const id = `${w.media}:${best.id}`;
          const prev = s.titles[id];
          const date = best.first_air_date || best.release_date;
          s.titles[id] = {
            id: best.id, media: w.media, name: best.name ?? best.title ?? w.title,
            ...(date && /^\d{4}/.test(date) ? { year: Number(date.slice(0, 4)) } : {}),
            ...(best.overview ? { overview: best.overview } : {}),
            images: prev?.images ?? {},
            pending: { ...(best.poster_path ? { poster: best.poster_path } : {}), ...(best.backdrop_path ? { fanart: best.backdrop_path } : {}) },
            ...(prev?.seasons ? { seasons: prev.seasons } : {}),
            at: Date.now(),
          };
        }
      });
      hit = this.cache.get().lookups[w.key]!;
      if (!best) {
        this.log(`TMDB: no match for "${w.title}"${w.year ? ` (${w.year})` : ""}`);
        return false;
      }
      found = true;
      if (w.media === "tv") {
        // Clear logos for show channels and banners; English or language-free.
        const imgs = await this.getJson<{ logos?: Array<{ file_path?: string; iso_639_1?: string | null }> }>(`/tv/${best.id}/images`, { include_image_language: `${this.language().slice(0, 2)},null` });
        const logo = (imgs.logos ?? []).find((l) => l.file_path && /\.png$/i.test(l.file_path));
        if (logo?.file_path) this.cache.update((s) => void (s.titles[`tv:${best.id}`]!.pending!.logo = logo.file_path!));
      }
    }
    const key = `${w.media}:${hit.id}`;
    for (const season of w.seasons) {
      const t = this.cache.get().titles[key];
      const s = t?.seasons?.[String(season)];
      if (s && !("missing" in s && Date.now() - s.at >= MISS_TTL)) continue;
      const r = await this.getJson<{ episodes?: Array<{ episode_number?: number; name?: string; overview?: string }> } | null>(`/tv/${hit.id}/season/${season}`, {}, true);
      const episodes: Record<string, { name?: string; overview?: string }> = {};
      for (const e of r?.episodes ?? []) if (e.episode_number != null) episodes[String(e.episode_number)] = { ...(e.name ? { name: e.name } : {}), ...(e.overview ? { overview: e.overview } : {}) };
      this.cache.update((st) => {
        const tt = st.titles[key];
        if (tt) (tt.seasons ??= {})[String(season)] = r ? { at: Date.now(), episodes } : { at: Date.now(), missing: true };
      });
    }
    // Pictures: each fetched once, stored by TMDB id.
    const pending = this.cache.get().titles[key]?.pending ?? {};
    for (const [kind, path] of Object.entries(pending) as Array<[OnlineKind, string]>) {
      const file = await this.download(`${SIZES[kind]}${path}`, `${w.media}-${hit.id}-${kind}`);
      this.cache.update((st) => {
        const tt = st.titles[key];
        if (!tt) return;
        if (file) tt.images[kind] = file;
        delete tt.pending?.[kind];
      });
    }
    const n = this.requests - before;
    if (n) this.log(`TMDB: ${found ? "found" : "updated"} "${w.title}" (${n} request${n === 1 ? "" : "s"}; title${w.year ? " and year" : ""}${w.seasons.size ? " and season" : ""} sent)`);
    return n > 0;
  }

  private language(): string {
    return this.keyFile.get().language ?? "en-US";
  }

  private async pace(): Promise<void> {
    const wait = Math.max(this.lastRequest + this.spacingMs, this.pausedUntil) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
  }

  private async request(path: string, params: Record<string, string>, key = this.keyFile.get().key ?? ""): Promise<{ status: number; body?: unknown; retryAfter?: number }> {
    await this.pace();
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!url.searchParams.has("language") && path !== "/configuration" && !path.endsWith("/images")) url.searchParams.set("language", this.language());
    // A v4 read access token is a JWT and goes in a header; a v3 key is a query parameter.
    const headers: Record<string, string> = { accept: "application/json" };
    if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
    else url.searchParams.set("api_key", key);
    this.requests++;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    this.bytes += text.length;
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {}
    const ra = Number(res.headers.get("retry-after"));
    return { status: res.status, body, ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: ra } : {}) };
  }

  /** GET with TMDB's answers handled: 429 waits and tries once more, 401 stops everything. */
  private async getJson<T>(path: string, params: Record<string, string>, allow404 = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.request(path, params);
      if (r.status === 200) return (r.body ?? {}) as T;
      if (r.status === 404 && allow404) return null as T;
      if (r.status === 401) {
        this.rejected = true;
        throw new Error("TMDB didn't accept the key");
      }
      if (r.status === 429 && attempt === 0) {
        this.pausedUntil = Date.now() + Math.min(60, r.retryAfter ?? 10) * 1000;
        continue;
      }
      throw new Error(`TMDB answered ${r.status}`);
    }
  }

  private async download(path: string, stem: string): Promise<string | undefined> {
    await this.pace();
    this.requests++;
    const res = await fetch(`${this.imageBase}/${path.replace(/^\//, "")}`, { signal: AbortSignal.timeout(30_000) });
    const ext = IMAGE_TYPES[(res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()];
    if (!res.ok || !ext) {
      await res.body?.cancel();
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    this.bytes += buf.length;
    if (!buf.length || buf.length > IMAGE_MAX_BYTES) return undefined;
    const name = `${stem}${ext}`;
    const tmp = join(this.imgDir, `${name}.tmp`);
    writeFileSync(tmp, buf);
    renameSync(tmp, join(this.imgDir, name));
    return name;
  }

  /**
   * Air dates for a show the cache already matched, for "What's missing". Sends only
   * the TMDB id: one /tv/{id} request, plus the season on the air now (and the one
   * before, around a premiere) for episode dates and names. Kept 12 hours; when TMDB
   * can't be reached the last answer is used.
   */
  async showSchedule(tmdbId: number): Promise<ShowSchedule | null> {
    if (!this.enabled() || this.stopped || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    const id = String(tmdbId);
    const cached = this.cache.get().shows?.[id];
    if (cached && Date.now() - cached.at < SCHEDULE_TTL) return cached;
    type Ep = { season_number?: number; episode_number?: number; air_date?: string | null; name?: string } | null | undefined;
    const ref = (e: Ep): AirEpisode | null =>
      e?.season_number != null && e.episode_number != null && e.air_date
        ? { season: e.season_number, episode: e.episode_number, airDate: e.air_date, ...(e.name ? { name: e.name } : {}) }
        : null;
    const before = this.requests;
    try {
      const d = await this.getJson<{
        name?: string;
        seasons?: Array<{ season_number?: number; episode_count?: number; air_date?: string | null }>;
        last_episode_to_air?: Ep;
        next_episode_to_air?: Ep;
      } | null>(`/tv/${id}`, {}, true);
      if (!d) return null;
      const lastAired = ref(d.last_episode_to_air);
      const nextAir = ref(d.next_episode_to_air);
      // Only a show on the air now needs per-episode dates; an ended one is answered by the counts.
      const want = new Set<number>();
      if (nextAir) want.add(nextAir.season);
      if (lastAired && (nextAir || Date.now() - Date.parse(lastAired.airDate) < 30 * DAY)) {
        want.add(lastAired.season);
        if (lastAired.episode === 1 && lastAired.season > 1) want.add(lastAired.season - 1);
      }
      const episodes: ShowSchedule["episodes"] = {};
      for (const n of want) {
        const r = await this.getJson<{ episodes?: Array<{ episode_number?: number; air_date?: string | null; name?: string }> } | null>(`/tv/${id}/season/${n}`, {}, true);
        if (!r) continue;
        episodes[String(n)] = (r.episodes ?? []).filter((e) => e.episode_number != null).map((e) => ({
          episode: e.episode_number!, ...(e.air_date ? { airDate: e.air_date } : {}), ...(e.name ? { name: e.name } : {}),
        }));
      }
      const out: ShowSchedule = {
        id: tmdbId,
        name: d.name ?? this.cache.get().titles[`tv:${id}`]?.name ?? "",
        seasons: (d.seasons ?? []).filter((s) => s.season_number != null).map((s) => ({
          season: s.season_number!, episodeCount: s.episode_count ?? 0, ...(s.air_date ? { airDate: s.air_date } : {}),
        })),
        lastAired, nextAir, episodes, at: Date.now(),
      };
      this.cache.update((st) => void ((st.shows ??= {})[id] = out));
      const n = this.requests - before;
      this.log(`TMDB: air dates for "${out.name}" (${n} request${n === 1 ? "" : "s"}; show id${want.size ? " and season" : ""} sent)`);
      return out;
    } catch (e) {
      this.lastError = (e as Error).message;
      if (cached) return cached;
      throw e;
    }
  }
}

interface TmdbResult {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  overview?: string;
  first_air_date?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  popularity?: number;
}

/** The search key for an item: a show by its name (and year if the file names carry one), a film by title and year. */
export function queryFor(it: LibItem): { key: string; media: Media; title: string; year?: number } | undefined {
  const p = it.parsed;
  if (p.kind === "episode") {
    const title = p.show;
    return { key: `tv|${norm(title)}|${p.year ?? ""}`, media: "tv", title, ...(p.year ? { year: p.year } : {}) };
  }
  if (p.kind === "movie") {
    const nfo = it.meta?.kind === "movie" ? it.meta : undefined;
    const title = nfo?.title?.trim() || p.title;
    const year = nfo?.year ?? p.year;
    return { key: `movie|${norm(title)}|${year ?? ""}`, media: "movie", title, ...(year ? { year } : {}) };
  }
  return undefined;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** TMDB ranks by relevance; prefer an exact title match, then the year, then its order. */
export function pick(results: TmdbResult[], w: { title: string; year?: number }): TmdbResult | undefined {
  const want = norm(w.title);
  const score = (r: TmdbResult, i: number) => {
    const names = [r.name, r.title, r.original_name, r.original_title].filter(Boolean).map((n) => norm(n!));
    const y = Number((r.first_air_date || r.release_date || "").slice(0, 4)) || undefined;
    return (names.includes(want) ? 100 : 0) + (w.year && y === w.year ? 50 : 0) - i;
  };
  let best: TmdbResult | undefined;
  let top = -Infinity;
  results.slice(0, 10).forEach((r, i) => {
    const s = score(r, i);
    if (s > top) [best, top] = [r, s];
  });
  // Without an exact name, only trust TMDB's first answer.
  return best && (top >= 90 || best === results[0]) ? best : undefined;
}
