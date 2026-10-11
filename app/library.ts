// The library: what the account holder has chosen to connect, what each file is,
// how long it runs, and whether it can be fetched right now. These are separate
// facts (handoff §1.3, §5.4) and are kept separate here:
//
//   listed     the provider's inventory has it
//   ready      the provider says it has finished storing it (its own words, kept verbatim)
//   timed      we know its exact running time
//   playable   a playback link was obtained recently
//   refused    the provider refused it (policy) — never retried, never fetched elsewhere
//
// Nothing in this module adds, selects or deletes anything at a provider. It reads
// inventories and account status, asks for playback links, and reads a few header
// bytes to learn exact durations — each step metered, and the scan runs only when
// the viewer starts it.

import { createHash } from "node:crypto";
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join, relative, extname, dirname, basename } from "node:path";
import type { Availability, MediaItem, ProviderId } from "../src/clock/types.ts";
import { parseName, type Parsed } from "../src/library/parse.ts";
import { parseNfo, withShow, type NfoMeta } from "../src/library/nfo.ts";
import { RATINGS, type Rating } from "../src/clock/ratings.ts";
import { probe, type RangeReader, type Track } from "../src/library/probe.ts";
import { RealDebridClient, TorBoxClient } from "../src/providers/clients.ts";
import { ProviderError, providerReady, type AccountInfo, type InventoryFile, type ProviderClient } from "../src/providers/types.ts";
import { GrantCache } from "../src/tuner/grants.ts";
import { JsonFile } from "./store.ts";
import type { Meters } from "./meters.ts";

export type RemoteProvider = "torbox" | "realdebrid";

export interface LibItem {
  id: string;
  provider: ProviderId;
  ref: string;
  name: string;
  bytes: number;
  /** The provider's own readiness wording, verbatim. */
  providerState: string;
  /** The provider says the file is finished and stored. False: never resolved or scanned. */
  ready?: boolean;
  parsed: Parsed;
  durationMs: number | null;
  container?: string;
  video?: string;
  audio?: string[];
  /** Every track (audio/subtitle languages for the track picker). */
  tracks?: Track[];
  /** Chapter starts from the file header, in file time. */
  chaptersMs?: number[];
  probe?: { at: number; bytes: number; error?: string };
  availability: Availability;
  availabilityReason?: string;
  availabilityAt?: number;
  /** Last time a playback link or media read actually worked. */
  playableAt?: number;
  /** Still present in the provider's inventory at the last refresh. */
  present: boolean;
  /** When it went missing from the inventory. */
  goneAt?: number;
  /** RD torrent this file was expanded from (multi-file packs only). */
  packId?: string;
  /** Media host's ETag and full size as last seen (edition evidence, see ETag notes). */
  etag?: string;
  /** Times the host sent a different ETag for the same reference (observed, not acted on). */
  etagChanges?: number;
  /** The viewer chose to keep this file off every channel. */
  excluded?: boolean;
  /** Episode title or similar, when known (demo library, or a local .nfo). */
  subtitle?: string;
  genre?: string;
  /** What the file's own .nfo (and its show's tvshow.nfo) says. Local folders only. */
  meta?: NfoMeta;
}

export interface AccountState extends Partial<AccountInfo> {
  /** Why the last account check failed, in plain words. */
  error?: string;
  errorKind?: ProviderError["kind"];
  checkedAtMs: number;
}

interface LibraryState {
  items: Record<string, LibItem>;
  refreshedAt: Partial<Record<ProviderId, number>>;
  /** RD multi-file torrents not yet expanded into per-file entries. */
  rdPacks: Record<string, { name: string; status: string }>;
  accounts?: Partial<Record<RemoteProvider, AccountState>>;
  /** Age ratings the viewer set by hand; they win over .nfo ratings. */
  ratings?: ManualRatings;
}

export interface ManualRatings {
  shows: Record<string, Rating>;
  items: Record<string, Rating>;
}

export interface Config {
  torboxKey?: string;
  rdToken?: string;
  localDirs?: string[];
  /** Duration-scan pace (items per minute). */
  scanPerMinute?: number;
}

export interface ScanState {
  running: boolean;
  done: number;
  total: number;
  current?: string;
  lastError?: string;
  stoppedReason?: string;
  /** Set while the scan waits out a provider's "slow down". */
  pausedUntil?: number;
}

export interface ProviderBases {
  realdebrid: string;
  torbox: string;
}

export const PROVIDER_NAMES: Record<ProviderId, string> = { torbox: "TorBox", realdebrid: "Real-Debrid", local: "This PC", demo: "Demo" };

const VIDEO_EXT = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv"]);
const RATE_LIMIT_PAUSE_MS = 60_000;

export class Library {
  private readonly file = new JsonFile<LibraryState>("library.json", () => ({ items: {}, refreshedAt: {}, rdPacks: {}, accounts: {} }));
  /** Replaced (not cleared) on disconnect so no link from an old key is reused. */
  grants = new GrantCache();
  scan: ScanState = { running: false, done: 0, total: 0 };
  private scanStop = false;
  private wake: (() => void) | null = null;
  private readonly config: () => Config;
  private readonly meters: Meters;
  private readonly bases: ProviderBases;
  private changed: () => void;
  /** Exposed for tests: how long the scan waits after a 429. */
  rateLimitPauseMs = RATE_LIMIT_PAUSE_MS;

  constructor(config: () => Config, meters: Meters, onChange: () => void, bases?: Partial<ProviderBases>) {
    this.config = config;
    this.meters = meters;
    this.changed = onChange;
    this.bases = { realdebrid: "https://api.real-debrid.com", torbox: "https://api.torbox.app", ...bases };
  }

  items(): LibItem[] {
    return Object.values(this.file.get().items);
  }

  get(id: string): LibItem | undefined {
    return this.file.get().items[id];
  }

  refreshedAt() {
    return this.file.get().refreshedAt;
  }

  pendingPacks(): number {
    return Object.keys(this.file.get().rdPacks).length;
  }

  account(provider: RemoteProvider): AccountState | undefined {
    return this.file.get().accounts?.[provider];
  }

  /** False only when we know paid access has ended (links then fail). */
  accountUsable(provider: ProviderId): boolean {
    if (provider !== "torbox" && provider !== "realdebrid") return true;
    const a = this.account(provider);
    return !(a && (a.premium === false || a.errorKind === "auth"));
  }

  client(provider: ProviderId): ProviderClient | null {
    const c = this.config();
    if (provider === "torbox" && c.torboxKey) return new TorBoxClient(this.bases.torbox, c.torboxKey, this.meters.api);
    if (provider === "realdebrid" && c.rdToken) return new RealDebridClient(this.bases.realdebrid, c.rdToken, this.meters.api);
    return null;
  }

  /** Stable identity: provider + provider reference. Survives restarts and re-scans. */
  static idFor(provider: ProviderId, ref: string): string {
    return `${provider[0]}${createHash("sha1").update(`${provider}|${ref}`).digest("hex").slice(0, 12)}`;
  }

  /** Read plan and premium end (one call). Failure is recorded, not thrown, unless it's the key. */
  async checkAccount(provider: RemoteProvider): Promise<AccountState> {
    const client = this.client(provider);
    if (!client) throw new Error(`${PROVIDER_NAMES[provider]} is not connected`);
    let a: AccountState;
    try {
      a = await client.account();
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : "unknown";
      a = { checkedAtMs: Date.now(), errorKind: kind, error: kind === "auth" ? `${PROVIDER_NAMES[provider]} no longer accepts this key` : plainError(e) };
      if (kind === "auth") {
        this.saveAccount(provider, a);
        throw e;
      }
    }
    this.saveAccount(provider, a);
    return a;
  }

  private saveAccount(provider: RemoteProvider, a: AccountState): void {
    this.file.update((s) => {
      s.accounts = { ...s.accounts, [provider]: a };
    });
    this.changed();
  }

  /** Forget everything learned from one provider's account (on disconnect). */
  forgetAccount(provider: RemoteProvider): void {
    this.grants = new GrantCache();
    this.file.update((s) => {
      if (s.accounts) delete s.accounts[provider];
    });
  }

  /** Read one provider's inventory and merge it in. One or a few API calls. */
  async refresh(provider: RemoteProvider): Promise<{ added: number; removed: number; total: number; notReady: number }> {
    const client = this.client(provider);
    if (!client) throw new Error(`${PROVIDER_NAMES[provider]} is not connected`);
    const files = await client.inventory();
    this.meters.log("api", `${PROVIDER_NAMES[provider]} library list: ${files.length} entries`);
    const state = this.file.get();
    const seen = new Set<string>();
    const seenPacks = new Set<string>();
    const expanded = new Set(Object.values(state.items).flatMap((i) => (i.packId ? [i.packId] : [])));
    let added = 0;
    let notReady = 0;
    for (const f of files) {
      if (f.ref.startsWith("pack:")) {
        const tid = f.ref.slice(5);
        seenPacks.add(tid);
        if (!expanded.has(tid)) state.rdPacks[tid] = { name: f.name, status: f.providerState };
        continue;
      }
      const r = this.upsert(state, f);
      if (r.added) added++;
      if (!state.items[r.id]!.ready) notReady++;
      seen.add(r.id);
    }
    for (const tid of Object.keys(state.rdPacks)) if (provider === "realdebrid" && !seenPacks.has(tid)) delete state.rdPacks[tid];
    // Files from expanded packs are not in the flat inventory; they stay present
    // while their pack is still listed.
    let removed = 0;
    for (const it of Object.values(state.items)) {
      if (it.provider !== provider || seen.has(it.id) || (it.packId && seenPacks.has(it.packId))) continue;
      // A "still downloading" placeholder that vanished has usually just finished
      // (it reappears under its real link). It was never ours to remember.
      if (it.ref.startsWith("torrent:")) {
        delete state.items[it.id];
        continue;
      }
      if (it.present) {
        it.present = false;
        it.goneAt = Date.now();
        it.availability = "unavailable";
        it.availabilityReason = `No longer in your ${PROVIDER_NAMES[provider]} library`;
        it.availabilityAt = Date.now();
        removed++;
      }
    }
    state.refreshedAt[provider] = Date.now();
    this.file.set(state);
    this.changed();
    return { added, removed, total: files.length, notReady };
  }

  private upsert(state: LibraryState, f: InventoryFile): { id: string; added: boolean } {
    const id = Library.idFor(f.provider, f.ref);
    const prev = state.items[id];
    const parsed = parseName(f.name);
    const ready = !f.ref.startsWith("torrent:") && providerReady(f.provider, f.providerState);
    const it: LibItem = {
      ...(prev ?? { durationMs: null, availability: "listed" as Availability }),
      id,
      provider: f.provider,
      ref: f.ref,
      name: f.name,
      bytes: f.bytes,
      providerState: f.providerState,
      ready,
      parsed,
      present: true,
    };
    if (prev && !prev.present) {
      it.availability = "listed";
      it.availabilityReason = undefined;
      it.goneAt = undefined;
    }
    // Same reference, different size: a different file now sits behind it. Its
    // running time must be learned again rather than assumed (gate D4).
    if (prev && prev.bytes !== f.bytes && prev.durationMs != null) {
      it.durationMs = null;
      it.probe = undefined;
      this.meters.log("probe", `${f.name.slice(0, 40)}: size changed, running time will be re-read`);
    }
    state.items[id] = it;
    return { id, added: !prev };
  }

  /** Walk local folders the viewer chose. No network. */
  refreshLocal(): number {
    const dirs = this.config().localDirs ?? [];
    const state = this.file.get();
    const seen = new Set<string>();
    let n = 0;
    const shows = new Map<string, NfoMeta | null>();
    for (const dir of dirs) {
      for (const path of walk(dir, 6)) {
        const st = statSync(path);
        const name = relative(dir, path);
        const { id } = this.upsert(state, { provider: "local", ref: path, name, bytes: st.size, providerState: "on disk" });
        seen.add(id);
        const it = state.items[id]!;
        const meta = localMeta(path, dir, it.parsed.kind, shows);
        if (meta) it.meta = meta;
        else delete it.meta;
        n++;
      }
    }
    for (const it of Object.values(state.items))
      if (it.provider === "local" && it.present && !seen.has(it.id)) {
        it.present = false;
        it.goneAt = Date.now();
        it.availability = "unavailable";
        it.availabilityReason = "No longer in your folders";
        it.availabilityAt = Date.now();
      }
    state.refreshedAt.local = Date.now();
    this.file.set(state);
    this.changed();
    return n;
  }

  /** Items that still need an exact duration, most useful first. */
  private scanQueue(): LibItem[] {
    const items = this.items().filter(
      (i) =>
        i.present &&
        i.ready !== false &&
        !i.excluded &&
        i.parsed.kind !== "other" &&
        i.durationMs == null &&
        !i.probe?.error &&
        i.availability !== "policy-blocked" &&
        this.accountUsable(i.provider) &&
        (i.provider === "local" || !!this.client(i.provider)),
    );
    const showSize = new Map<string, number>();
    for (const i of items) if (i.parsed.kind === "episode") showSize.set(i.parsed.showKey, (showSize.get(i.parsed.showKey) ?? 0) + 1);
    const weight = (i: LibItem) => (i.provider === "local" ? 1e6 : i.parsed.kind === "episode" ? showSize.get(i.parsed.showKey)! : 3);
    return items.sort((a, b) => weight(b) - weight(a));
  }

  needsScan(): number {
    return this.scanQueue().length + (this.client("realdebrid") ? this.pendingPacks() : 0);
  }

  stopScan(reason = "Stopped"): void {
    if (!this.scan.running) return;
    this.scanStop = true;
    this.scan.stoppedReason = reason;
    this.wake?.();
  }

  /** Forget earlier probe failures so a new scan tries those files again (explicit, viewer-started). */
  retryFailedProbes(): number {
    let n = 0;
    this.file.update((s) => {
      for (const it of Object.values(s.items))
        if (it.probe?.error && it.probe.error !== "policy" && it.durationMs == null) {
          it.probe = undefined;
          n++;
        }
    });
    return n;
  }

  /**
   * Learn exact durations by reading container headers (~64 KB–3 MB per file).
   * Explicit, paced, and stoppable. A policy refusal marks the file and moves on;
   * it is never retried or fetched another way (gate E6). An auth failure stops.
   * A rate limit pauses for a minute once; a second one in a row stops (B7).
   */
  async runScan(): Promise<void> {
    if (this.scan.running) return;
    this.scanStop = false;
    const perMinute = Math.max(1, Math.min(120, this.config().scanPerMinute ?? 30));
    const gap = 60_000 / perMinute;
    this.scan = { running: true, done: 0, total: this.needsScan() };
    this.changed();
    try {
      await this.expandPacks(gap);
      const queue = this.scanQueue();
      this.scan.total = this.scan.done + queue.length;
      let limitedInARow = 0;
      for (let i = 0; i < queue.length; i++) {
        const it = queue[i]!;
        if (this.scanStop) break;
        const t0 = Date.now();
        this.scan.current = it.parsed.kind === "episode" ? it.parsed.show : it.parsed.kind === "movie" ? it.parsed.title : it.name;
        const outcome = await this.probeOne(it);
        if (outcome === "rate-limited") {
          if (++limitedInARow >= 2) {
            this.scan.stoppedReason = `${PROVIDER_NAMES[it.provider]} asked DebridTV to slow down twice. Try again later or pick a slower pace.`;
            break;
          }
          this.scan.pausedUntil = Date.now() + this.rateLimitPauseMs;
          this.meters.log("api", `${PROVIDER_NAMES[it.provider]} said slow down; pausing the scan for ${Math.round(this.rateLimitPauseMs / 1000)} s`);
          this.changed();
          await this.pause(this.rateLimitPauseMs);
          this.scan.pausedUntil = undefined;
          i--; // the same file, once more, after the pause
          continue;
        }
        limitedInARow = 0;
        if (outcome === "auth") {
          this.scan.stoppedReason = `${PROVIDER_NAMES[it.provider]} rejected the key`;
          break;
        }
        this.scan.done++;
        this.changed();
        if (this.scanStop) break;
        if (it.provider !== "local") await this.pause(Math.max(0, gap - (Date.now() - t0)));
      }
    } catch (e) {
      this.scan.lastError = plainError(e);
      if (e instanceof ProviderError && e.kind === "auth") this.scan.stoppedReason = "The provider rejected the key";
    } finally {
      this.scan.running = false;
      this.scan.current = undefined;
      this.scan.pausedUntil = undefined;
      this.changed();
    }
  }

  /** A sleep that Stop can cut short. */
  private pause(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.wake = null;
        r();
      }
      this.wake = done;
    });
  }

  private async expandPacks(gap: number): Promise<void> {
    const state = this.file.get();
    const rd = this.client("realdebrid") as RealDebridClient | null;
    if (!rd || !this.accountUsable("realdebrid")) return;
    for (const [tid, pack] of Object.entries(state.rdPacks)) {
      if (this.scanStop) return;
      this.scan.current = pack.name;
      const files = await rd.expand(tid);
      for (const f of files) state.items[this.upsert(state, f).id]!.packId = tid;
      delete state.rdPacks[tid];
      this.file.set(state);
      this.scan.done++;
      this.changed();
      await this.pause(gap);
    }
  }

  /**
   * Read one file's header for its running time and codecs. Returns what happened
   * so the scan can pace itself; the item itself records the facts.
   */
  async probeOne(it: LibItem): Promise<"ok" | "failed" | "policy" | "rate-limited" | "auth"> {
    const state = this.file.get();
    const target = state.items[it.id]!;
    let outcome: "ok" | "failed" | "policy" | "rate-limited" | "auth" = "ok";
    try {
      let read: RangeReader;
      if (it.provider === "local") {
        read = async (start, length) => readLocal(it.ref, start, length);
      } else {
        const client = this.client(it.provider);
        if (!client) throw new Error(`${PROVIDER_NAMES[it.provider]} not connected`);
        const grant = await this.grants.get(client, it.ref);
        let first = true;
        read = async (start, length) => {
          const res = await fetch(grant.url, { headers: { range: `bytes=${start}-${start + length - 1}` } });
          if (res.status === 403 || res.status === 404 || res.status === 410) this.grants.invalidate(client, it.ref);
          if (!res.ok) throw new Error(`media host said ${res.status}`);
          if (first) {
            first = false;
            this.noteHost(target, res.headers);
          }
          const buf = new Uint8Array(await res.arrayBuffer());
          this.meters.add("probe", buf.byteLength);
          return buf;
        };
      }
      const r = await probe(read, it.bytes);
      if (it.provider !== "local") {
        target.availability = "playable";
        target.availabilityReason = undefined;
        target.availabilityAt = target.playableAt = Date.now();
      }
      target.durationMs = r.durationMs;
      target.container = r.container;
      target.video = r.video;
      target.audio = r.audio;
      target.tracks = r.tracks;
      target.chaptersMs = r.chaptersMs;
      target.probe = { at: Date.now(), bytes: r.bytesRead, ...(r.durationMs == null ? { error: "No running time in the file header" } : {}) };
      if (r.durationMs == null) outcome = "failed";
      this.meters.log("probe", `${r.container} ${r.durationMs ? Math.round(r.durationMs / 60000) + " min" : "no duration"}, ${Math.round(r.bytesRead / 1024)} KB`);
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : null;
      if (kind === "policy") {
        target.availability = "policy-blocked";
        target.availabilityReason = `${PROVIDER_NAMES[it.provider]} refused this file`;
        target.availabilityAt = Date.now();
        target.probe = { at: Date.now(), bytes: 0, error: "policy" };
        outcome = "policy";
      } else if (kind === "auth") {
        outcome = "auth";
      } else if (kind === "rate-limited") {
        outcome = "rate-limited"; // not the file's fault: nothing recorded against it
      } else if (kind === "not-ready") {
        target.ready = false;
        target.availabilityReason = `${PROVIDER_NAMES[it.provider]} says it isn't ready yet`;
        outcome = "failed";
      } else {
        target.probe = { at: Date.now(), bytes: 0, error: plainError(e) };
        outcome = "failed";
      }
      this.meters.log("error", `${it.name.slice(0, 40)}: ${kind ?? plainError(e)}`);
    }
    this.file.set(state);
    return outcome;
  }

  /**
   * What the media host says about the file behind a link. The ETag is kept as
   * evidence; a change alone is only counted, because whether ETags are stable
   * across CDN nodes and links is still being measured (live-probe ETAG mode).
   * A changed total size is unambiguous: the running time is learned again.
   */
  noteHost(target: LibItem, headers: Headers): void {
    const etag = headers.get("etag") ?? undefined;
    const total = Number(/\/(\d+)$/.exec(headers.get("content-range") ?? "")?.[1] ?? NaN);
    if (etag && target.etag && etag !== target.etag) {
      target.etagChanges = (target.etagChanges ?? 0) + 1;
      this.meters.log("probe", `${target.name.slice(0, 40)}: media host sent a different ETag`);
    }
    if (etag) target.etag = etag;
    if (Number.isFinite(total) && total > 0 && total !== target.bytes) {
      this.meters.log("probe", `${target.name.slice(0, 40)}: host reports ${total} bytes, library said ${target.bytes}`);
      target.bytes = total;
      if (target.durationMs != null) {
        target.durationMs = null;
        target.probe = undefined;
      }
    }
  }

  /** Same as noteHost, for a playback response, saved straight away. */
  notePlayback(id: string, headers: Headers): void {
    this.file.update((s) => {
      const it = s.items[id];
      if (!it) return;
      const before = it.durationMs;
      this.noteHost(it, headers);
      it.availability = "playable";
      it.availabilityReason = undefined;
      it.availabilityAt = it.playableAt = Date.now();
      if (before != null && it.durationMs == null) this.changed();
    });
  }

  /** Record what the media host said when we tried to play (fact, not schedule input). */
  markAvailability(id: string, availability: Availability, reason?: string): void {
    this.file.update((s) => {
      const it = s.items[id];
      if (!it) return;
      it.availability = availability;
      it.availabilityReason = reason;
      it.availabilityAt = Date.now();
      if (availability === "playable") it.playableAt = it.availabilityAt;
    });
  }

  /** Keep a file off (or back on) every channel. A channel changes only after what's airing ends. */
  setExcluded(id: string, excluded: boolean): boolean {
    let ok = false;
    this.file.update((s) => {
      const it = s.items[id];
      if (!it) return;
      it.excluded = excluded || undefined;
      ok = true;
    });
    if (ok) this.changed();
    return ok;
  }

  /** Delete every library fact (not the keys, not history). */
  clear(): void {
    this.grants = new GrantCache();
    this.file.set({ items: {}, refreshedAt: {}, rdPacks: {}, accounts: {} });
    this.changed();
  }

  manualRatings(): ManualRatings {
    return this.file.get().ratings ?? { shows: {}, items: {} };
  }

  /** Set or clear (null) a hand-picked rating for a whole show or one file. */
  setRating(target: { showKey?: string; itemId?: string }, rating: Rating | null): boolean {
    if (rating !== null && !RATINGS.includes(rating)) return false;
    const key = target.showKey ? "shows" : target.itemId ? "items" : null;
    const id = target.showKey ?? target.itemId;
    if (!key || !id) return false;
    this.file.update((s) => {
      const r = s.ratings ?? { shows: {}, items: {} };
      if (rating) r[key][id] = rating;
      else delete r[key][id];
      s.ratings = r;
    });
    this.changed();
    return true;
  }

  /** Merge exported hand-picked ratings back in. */
  importRatings(x: unknown): number {
    if (!x || typeof x !== "object") return 0;
    let n = 0;
    this.file.update((s) => {
      const r = s.ratings ?? { shows: {}, items: {} };
      for (const key of ["shows", "items"] as const) {
        const src = (x as Record<string, unknown>)[key];
        if (src && typeof src === "object")
          for (const [k, v] of Object.entries(src as Record<string, unknown>))
            if (RATINGS.includes(v as Rating)) (r[key][k.slice(0, 300)] = v as Rating), n++;
      }
      s.ratings = r;
    });
    if (n) this.changed();
    return n;
  }

  /** Clock-facing view: identity, timing and age rating. Availability is not included on purpose. */
  mediaItems(): MediaItem[] {
    const manual = this.manualRatings();
    return this.items().flatMap((i) => {
      if (i.parsed.kind === "other") return [];
      return [{
        id: i.id,
        title: displayTitle(i),
        showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined,
        season: i.parsed.kind === "episode" ? i.parsed.season : undefined,
        episode: i.parsed.kind === "episode" ? i.parsed.episode : undefined,
        durationMs: i.durationMs,
        breakpointsMs: breakpoints(i),
        rating: effectiveRating(i, manual)?.rating,
        source: { provider: i.provider, ref: i.ref },
      }];
    });
  }
}

/** The rating the clock uses and where it came from: the viewer's pick, then the .nfo. */
export function effectiveRating(i: LibItem, manual: ManualRatings): { rating: Rating; from: "you" | "nfo" | "demo" } | null {
  const byItem = manual.items[i.id];
  if (byItem) return { rating: byItem, from: "you" };
  const byShow = i.parsed.kind === "episode" ? manual.shows[i.parsed.showKey] : undefined;
  if (byShow) return { rating: byShow, from: "you" };
  if (i.meta?.rating) return { rating: i.meta.rating, from: i.provider === "demo" ? "demo" : "nfo" };
  return null;
}

const NFO_MAX_BYTES = 512 * 1024;

function readNfo(path: string): NfoMeta | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > NFO_MAX_BYTES) return null;
    return parseNfo(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Metadata for one local video from Kodi-style .nfo files beside it: its own
 * "<name>.nfo", else "movie.nfo" in its folder for a movie; for an episode, the
 * nearest "tvshow.nfo" up to two folders above (Show/Season 1/episode.mkv) fills
 * in what the episode's own file leaves out. Never looks above the chosen folder.
 */
export function localMeta(path: string, root: string, kind: Parsed["kind"], showCache = new Map<string, NfoMeta | null>()): NfoMeta | null {
  const dir = dirname(path);
  const own = readNfo(join(dir, `${basename(path, extname(path))}.nfo`)) ?? (kind === "movie" ? readNfo(join(dir, "movie.nfo")) : null);
  if (kind !== "episode" && own?.kind !== "episode") return own && own.kind !== "show" ? own : null;
  let show: NfoMeta | null = null;
  let d = dir;
  for (let up = 0; up < 3; up++) {
    if (!showCache.has(d)) {
      const m = readNfo(join(d, "tvshow.nfo"));
      showCache.set(d, m?.kind === "show" ? m : null);
    }
    show = showCache.get(d)!;
    if (show || relative(root, d) === "" || relative(root, d).startsWith("..")) break;
    d = dirname(d);
  }
  return withShow(own?.kind === "episode" ? own : null, show);
}

/**
 * Where a station break may go inside a program: chapter starts from the file
 * itself, never guessed (handoff §6.1). Not in the first or last 3 minutes, at
 * least 5 minutes apart, at most 3 per program.
 */
export function breakpoints(i: { durationMs: number | null; chaptersMs?: number[] }): number[] {
  const d = i.durationMs;
  if (!d || !i.chaptersMs?.length) return [];
  const MIN3 = 3 * 60_000;
  const out: number[] = [];
  for (const c of i.chaptersMs) {
    if (c < MIN3 || c > d - MIN3) continue;
    if (out.length && c - out[out.length - 1]! < 5 * 60_000) continue;
    out.push(c);
    if (out.length === 3) break;
  }
  return out;
}

// ---------------------------------------------------------------- status

export type FileStatus = "ready" | "needs-scan" | "not-ready" | "refused" | "gone" | "account" | "problem" | "excluded" | "other";

/** Real-Debrid torrent states that mean "this won't finish by itself". */
const FAILED_STATES = new Set(["magnet_error", "error", "virus", "dead"]);

export const STATUS_ORDER: FileStatus[] = ["ready", "needs-scan", "not-ready", "refused", "account", "problem", "gone", "excluded", "other"];

/**
 * One file's state in plain words. Each failure has its own message (gate D5):
 * removed from the library, account no longer paid up, refused by the provider,
 * not finished at the provider, or a host error — never one generic "unavailable".
 */
export function fileStatus(it: LibItem, account?: AccountState): { status: FileStatus; message: string } {
  const who = PROVIDER_NAMES[it.provider];
  if (!it.present)
    return { status: "gone", message: it.provider === "local" ? "No longer in your folders." : `No longer in your ${who} library. DebridTV keeps its history but won't schedule it.` };
  if (it.availability === "policy-blocked")
    return { status: "refused", message: `${who} refused this file. DebridTV won't retry it or fetch it from anywhere else.` };
  if (it.excluded) return { status: "excluded", message: "You kept this off the air." };
  if (it.parsed.kind === "other") return { status: "other", message: "Not recognised as an episode or a movie, so no channel uses it." };
  if (it.ready === false)
    return {
      status: "not-ready",
      message: FAILED_STATES.has(it.providerState)
        ? `${who} reports this one failed (it says "${it.providerState}"). DebridTV won't try to repair it.`
        : `${who} hasn't finished storing this (it says "${it.providerState}"). DebridTV never asks a provider to download anything.`,
    };
  if (account && (account.premium === false || account.errorKind === "auth"))
    return {
      status: "account",
      message: account.errorKind === "auth"
        ? `${who} no longer accepts your key. Reconnect it in Sources.`
        : `Your ${who} premium ${account.premiumUntilMs ? `ended ${new Date(account.premiumUntilMs).toLocaleDateString()}` : "has ended"}. Links won't work until it's renewed.`,
    };
  if (it.availability === "unavailable" || (it.probe?.error && it.durationMs == null))
    return { status: "problem", message: `${it.availabilityReason ?? it.probe?.error ?? "Couldn't be read"}.`.replace(/\.\.$/, ".") };
  if (it.durationMs == null) return { status: "needs-scan", message: "Running time not known yet. A scan reads a few KB from the start of the file." };
  return { status: "ready", message: "Ready to air." };
}

export function displayTitle(i: { parsed: Parsed; name: string }): string {
  const p = i.parsed;
  if (p.kind === "episode") {
    const ep = p.absolute ? `#${p.episode}` : `S${String(p.season).padStart(2, "0")}E${String(p.episode).padStart(2, "0")}`;
    return `${p.show} · ${ep}`;
  }
  if (p.kind === "movie") return p.year ? `${p.title} (${p.year})` : p.title;
  return i.name;
}

export function plainError(e: unknown): string {
  if (e instanceof ProviderError) {
    const known: Partial<Record<ProviderError["kind"], string>> = {
      "rate-limited": "The provider asked DebridTV to slow down",
      auth: "The provider rejected the key",
      "not-found": "The provider doesn't have this any more",
      "not-ready": "The provider says it isn't ready yet",
      policy: "The provider refused this file",
      transient: `The provider had a problem (HTTP ${e.status})`,
    };
    return known[e.kind] ?? `The provider said HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function* walk(dir: string, depth: number): Generator<string> {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else if (e.isFile() && VIDEO_EXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

function readLocal(path: string, start: number, length: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  } finally {
    closeSync(fd);
  }
}
