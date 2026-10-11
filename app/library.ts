// The library: what the account holder has chosen to connect, what each file is,
// how long it runs, and whether it can be fetched right now. These are separate
// facts (handoff §1.3, §5.4) and are kept separate here.
//
// Nothing in this module adds, selects or deletes anything at a provider. It reads
// inventories, asks for playback links, and reads a few header bytes to learn exact
// durations — each step metered, and the scan runs only when the viewer starts it.

import { createHash } from "node:crypto";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, extname } from "node:path";
import type { Availability, MediaItem, ProviderId } from "../src/clock/types.ts";
import { parseName, type Parsed } from "../src/library/parse.ts";
import { probe, type RangeReader } from "../src/library/probe.ts";
import { RealDebridClient, TorBoxClient } from "../src/providers/clients.ts";
import { ProviderError, type InventoryFile, type ProviderClient } from "../src/providers/types.ts";
import { GrantCache } from "../src/tuner/grants.ts";
import { JsonFile } from "./store.ts";
import type { Meters } from "./meters.ts";

export interface LibItem {
  id: string;
  provider: ProviderId;
  ref: string;
  name: string;
  bytes: number;
  providerState: string;
  parsed: Parsed;
  durationMs: number | null;
  container?: string;
  video?: string;
  audio?: string[];
  probe?: { at: number; bytes: number; error?: string };
  availability: Availability;
  availabilityReason?: string;
  availabilityAt?: number;
  /** Still present in the provider's inventory at the last refresh. */
  present: boolean;
  /** RD torrent this file was expanded from (multi-file packs only). */
  packId?: string;
  /** Episode title or similar, when known (demo library only, for now). */
  subtitle?: string;
  genre?: string;
}

interface LibraryState {
  items: Record<string, LibItem>;
  refreshedAt: Partial<Record<ProviderId, number>>;
  /** RD multi-file torrents not yet expanded into per-file entries. */
  rdPacks: Record<string, { name: string; status: string }>;
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
}

const VIDEO_EXT = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv"]);

export class Library {
  private readonly file = new JsonFile<LibraryState>("library.json", () => ({ items: {}, refreshedAt: {}, rdPacks: {} }));
  readonly grants = new GrantCache();
  scan: ScanState = { running: false, done: 0, total: 0 };
  private scanStop = false;
  private readonly config: () => Config;
  private readonly meters: Meters;
  private changed: () => void;

  constructor(config: () => Config, meters: Meters, onChange: () => void) {
    this.config = config;
    this.meters = meters;
    this.changed = onChange;
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

  client(provider: ProviderId): ProviderClient | null {
    const c = this.config();
    if (provider === "torbox" && c.torboxKey) return new TorBoxClient("https://api.torbox.app", c.torboxKey, this.meters.api);
    if (provider === "realdebrid" && c.rdToken) return new RealDebridClient("https://api.real-debrid.com", c.rdToken, this.meters.api);
    return null;
  }

  /** Stable identity: provider + provider reference. Survives restarts and re-scans. */
  static idFor(provider: ProviderId, ref: string): string {
    return `${provider[0]}${createHash("sha1").update(`${provider}|${ref}`).digest("hex").slice(0, 12)}`;
  }

  /** Read one provider's inventory and merge it in. One or a few API calls. */
  async refresh(provider: "torbox" | "realdebrid"): Promise<{ added: number; removed: number; total: number }> {
    const client = this.client(provider);
    if (!client) throw new Error(`${provider} is not connected`);
    const files = await client.inventory();
    this.meters.log("api", `${provider} inventory: ${files.length} entries`);
    const state = this.file.get();
    const seen = new Set<string>();
    const seenPacks = new Set<string>();
    const expanded = new Set(Object.values(state.items).flatMap((i) => (i.packId ? [i.packId] : [])));
    let added = 0;
    for (const f of files) {
      if (f.ref.startsWith("pack:")) {
        const tid = f.ref.slice(5);
        seenPacks.add(tid);
        if (!expanded.has(tid)) state.rdPacks[tid] = { name: f.name, status: f.providerState };
        continue;
      }
      const id = this.upsert(state, f);
      if (id.added) added++;
      seen.add(id.id);
    }
    // Files from expanded packs are not in the flat inventory; they stay present
    // while their pack is still listed.
    let removed = 0;
    for (const it of Object.values(state.items)) {
      if (it.provider !== provider || seen.has(it.id) || (it.packId && seenPacks.has(it.packId))) continue;
      if (it.present) {
        it.present = false;
        it.availability = "unavailable";
        it.availabilityReason = "No longer in your library";
        it.availabilityAt = Date.now();
        removed++;
      }
    }
    state.refreshedAt[provider] = Date.now();
    this.file.set(state);
    this.changed();
    return { added, removed, total: files.length };
  }

  private upsert(state: LibraryState, f: InventoryFile): { id: string; added: boolean } {
    const id = Library.idFor(f.provider, f.ref);
    const prev = state.items[id];
    const parsed = parseName(f.name);
    state.items[id] = {
      ...(prev ?? { durationMs: null, availability: "listed" as Availability }),
      id,
      provider: f.provider,
      ref: f.ref,
      name: f.name,
      bytes: f.bytes,
      providerState: f.providerState,
      parsed,
      present: true,
    } as LibItem;
    if (prev && !prev.present) state.items[id]!.availability = "listed";
    return { id, added: !prev };
  }

  /** Walk local folders the viewer chose. No network. */
  refreshLocal(): number {
    const dirs = this.config().localDirs ?? [];
    const state = this.file.get();
    let n = 0;
    for (const dir of dirs) {
      for (const path of walk(dir, 6)) {
        const st = statSync(path);
        const name = relative(dir, path);
        this.upsert(state, { provider: "local", ref: path, name, bytes: st.size, providerState: "on disk" });
        n++;
      }
    }
    state.refreshedAt.local = Date.now();
    this.file.set(state);
    this.changed();
    return n;
  }

  /** Items that still need an exact duration, most useful first. */
  private scanQueue(): LibItem[] {
    const items = this.items().filter(
      (i) => i.present && i.parsed.kind !== "other" && i.durationMs == null && !i.probe?.error && i.availability !== "policy-blocked",
    );
    const showSize = new Map<string, number>();
    for (const i of items) if (i.parsed.kind === "episode") showSize.set(i.parsed.showKey, (showSize.get(i.parsed.showKey) ?? 0) + 1);
    const weight = (i: LibItem) => (i.provider === "local" ? 1e6 : i.parsed.kind === "episode" ? showSize.get(i.parsed.showKey)! : 3);
    return items.sort((a, b) => weight(b) - weight(a));
  }

  needsScan(): number {
    return this.scanQueue().length + this.pendingPacks();
  }

  stopScan(reason = "Stopped"): void {
    this.scanStop = true;
    this.scan.stoppedReason = reason;
  }

  /**
   * Learn exact durations by reading container headers (~64 KB–3 MB per file).
   * Explicit, paced, and stoppable. A policy refusal marks the file and moves on;
   * it is never retried or fetched another way (gate E6). An auth failure stops.
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
      for (const it of queue) {
        if (this.scanStop) break;
        const t0 = Date.now();
        this.scan.current = it.parsed.kind === "episode" ? it.parsed.show : it.parsed.kind === "movie" ? it.parsed.title : it.name;
        await this.probeOne(it);
        this.scan.done++;
        this.changed();
        if (this.scanStop) break;
        if (it.provider !== "local") await sleep(Math.max(0, gap - (Date.now() - t0)));
      }
    } catch (e) {
      this.scan.lastError = String(e instanceof Error ? e.message : e);
      if (e instanceof ProviderError && e.kind === "auth") this.scan.stoppedReason = "The provider rejected the key";
    } finally {
      this.scan.running = false;
      this.scan.current = undefined;
      this.changed();
    }
  }

  private async expandPacks(gap: number): Promise<void> {
    const state = this.file.get();
    const rd = this.client("realdebrid") as RealDebridClient | null;
    if (!rd) return;
    for (const [tid, pack] of Object.entries(state.rdPacks)) {
      if (this.scanStop) return;
      this.scan.current = pack.name;
      const files = await rd.expand(tid);
      for (const f of files) state.items[this.upsert(state, f).id]!.packId = tid;
      delete state.rdPacks[tid];
      this.file.set(state);
      this.scan.done++;
      this.changed();
      await sleep(gap);
    }
  }

  async probeOne(it: LibItem): Promise<void> {
    const state = this.file.get();
    const target = state.items[it.id]!;
    try {
      let read: RangeReader;
      if (it.provider === "local") {
        read = async (start, length) => readLocal(it.ref, start, length);
      } else {
        const client = this.client(it.provider);
        if (!client) throw new Error(`${it.provider} not connected`);
        const grant = await this.grants.get(client, it.ref);
        target.availability = "playable";
        target.availabilityAt = Date.now();
        read = async (start, length) => {
          const res = await fetch(grant.url, { headers: { range: `bytes=${start}-${start + length - 1}` } });
          if (!res.ok) throw new Error(`media host ${res.status}`);
          const buf = new Uint8Array(await res.arrayBuffer());
          this.meters.add("probe", buf.byteLength);
          return buf;
        };
      }
      const r = await probe(read, it.bytes);
      target.durationMs = r.durationMs;
      target.container = r.container;
      target.video = r.video;
      target.audio = r.audio;
      target.probe = { at: Date.now(), bytes: r.bytesRead, ...(r.durationMs == null ? { error: "No duration in file header" } : {}) };
      this.meters.log("probe", `${r.container} ${r.durationMs ? Math.round(r.durationMs / 60000) + " min" : "no duration"}, ${Math.round(r.bytesRead / 1024)} KB`);
    } catch (e) {
      if (e instanceof ProviderError && e.kind === "policy") {
        target.availability = "policy-blocked";
        target.availabilityReason = "The provider refused this file";
        target.availabilityAt = Date.now();
        target.probe = { at: Date.now(), bytes: 0, error: "policy" };
      } else if (e instanceof ProviderError && e.kind === "auth") {
        throw e;
      } else {
        target.probe = { at: Date.now(), bytes: 0, error: String(e instanceof Error ? e.message : e) };
      }
      this.meters.log("error", `${it.name.slice(0, 40)}: ${target.probe?.error}`);
    }
    this.file.set(state);
  }

  /** Record what the media host said when we tried to play (fact, not schedule input). */
  markAvailability(id: string, availability: Availability, reason?: string): void {
    this.file.update((s) => {
      const it = s.items[id];
      if (!it) return;
      it.availability = availability;
      it.availabilityReason = reason;
      it.availabilityAt = Date.now();
    });
  }

  /** Clock-facing view: only identity and timing. Availability is not included on purpose. */
  mediaItems(): MediaItem[] {
    return this.items().flatMap((i) => {
      if (i.parsed.kind === "other") return [];
      return [{
        id: i.id,
        title: displayTitle(i),
        showId: i.parsed.kind === "episode" ? i.parsed.showKey : undefined,
        season: i.parsed.kind === "episode" ? i.parsed.season : undefined,
        episode: i.parsed.kind === "episode" ? i.parsed.episode : undefined,
        durationMs: i.durationMs,
        source: { provider: i.provider, ref: i.ref },
      }];
    });
  }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
