// Adding to the viewer's own TorBox or Real-Debrid account (the acquisition gate).
// Off until the viewer turns on "Allow adding" in Settings → Add. After that, only
// an explicit Add press, or a file the viewer drops into their watched folder,
// sends anything. Nothing here searches on its own, retries a refusal without
// saying so, or deletes anything in an account.
//
// Pacing and refusals follow what Debrid Media Manager measured on live accounts
// (facts only; their code is AGPL and none is copied): Real-Debrid allows about
// 30 adds a minute per account, and a 451 on an add is usually RD pausing every
// add on the account for 21 s to about 5 minutes, unless the torrent's own name
// carries a tag RD always refuses.

import { readdirSync, readFileSync, renameSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { JsonFile } from "./store.ts";
import { ProviderError, rdRefusedTag } from "../src/providers/types.ts";
import { RealDebridWriter, TorBoxWriter, type RdTorrentInfo } from "../src/providers/writers.ts";
import { hashToMagnet, isMagnet, parseMagnet, parseTorrent } from "../src/acquire/torrent.ts";
import { AUDIO_EXT } from "../src/library/audio.ts";

export type AddProvider = "torbox" | "realdebrid";

export type AddInput =
  | { kind: "magnet"; magnet: string }
  | { kind: "torrent-file"; bytes: Uint8Array; name: string }
  /** A .torrent link from a search result; DebridTV fetches it (it may redirect to a magnet). */
  | { kind: "torrent-url"; url: string }
  /** A plain http(s) link: a TorBox web download. */
  | { kind: "web"; url: string }
  | { kind: "nzb-url"; url: string }
  | { kind: "nzb-file"; bytes: Uint8Array; name: string };

export type JobState = "waiting" | "adding" | "added" | "failed";

export interface AddJob {
  id: string;
  at: number;
  via: "search" | "paste" | "folder";
  title: string;
  provider: AddProvider;
  state: JobState;
  /** Plain words: what happened, or why not. */
  message?: string;
  providerId?: string;
  infoHash?: string;
  doneAt?: number;
}

export interface AcquireDeps {
  /** Credentials and settings, read fresh each time. */
  config: () => { torboxKey?: string; rdToken?: string; allowAdding?: boolean; addTo?: AddProvider; watchDir?: string };
  bases: { realdebrid: string; torbox: string };
  counter: { add(name: string): void };
  log: (detail: string) => void;
  /** Called once adds settle, so the library list is read again. */
  onAdded: (provider: AddProvider) => void;
  /** Tests shorten the waits. */
  timing?: Partial<typeof TIMING>;
  fetch?: typeof fetch;
}

const TIMING = {
  /** Spacing between adds on one account. RD: 30 a minute (measured); TorBox: 50 a minute (DMM's budget). */
  rdSpacingMs: 2_000,
  tbSpacingMs: 1_200,
  /** Holds before each further try after an unexplained RD 451: 30 s, 90 s, then 3 minutes. */
  rdHoldsMs: [30_000, 90_000, 180_000],
  /** RD turns a magnet into a file list first; how often and how long to look. */
  rdPollMs: 3_000,
  rdPollTries: 10,
  /** How long after the last add the library list is read again. */
  refreshAfterMs: 15_000,
};

const VIDEO_EXT = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".wmv"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KEEP_JOBS = 100;

/** Adds are off until the viewer allows them; every add route checks this first. */
export class AddingOffError extends Error {
  constructor() {
    super("Adding is off. Turn on \"Allow adding\" in Settings → Add first.");
  }
}

export class Acquirer {
  private readonly deps: AcquireDeps;
  private readonly t: typeof TIMING;
  private readonly file = new JsonFile<{ jobs: AddJob[] }>("adds.json", () => ({ jobs: [] }));
  private readonly queue: Array<{ job: AddJob; input: AddInput; done?: (j: AddJob) => void }> = [];
  private running = false;
  private readonly lastAdd: Record<AddProvider, number> = { torbox: 0, realdebrid: 0 };
  private readonly refreshTimers: Partial<Record<AddProvider, ReturnType<typeof setTimeout>>> = {};
  /** Folder files queued this run, so a slow add isn't queued twice. */
  private readonly folderSeen = new Set<string>();
  private seq = 0;

  constructor(deps: AcquireDeps) {
    this.deps = deps;
    this.t = { ...TIMING, ...deps.timing };
  }

  jobs(): AddJob[] {
    const live = this.queue.map((q) => q.job);
    const saved = this.file.get().jobs.filter((j) => !live.some((l) => l.id === j.id));
    return [...live, ...saved].sort((a, b) => b.at - a.at);
  }

  /** Which providers can take an add right now. */
  targets(): AddProvider[] {
    const c = this.deps.config();
    return [...(c.torboxKey ? ["torbox" as const] : []), ...(c.rdToken ? ["realdebrid" as const] : [])];
  }

  defaultTarget(): AddProvider | null {
    const t = this.targets();
    const want = this.deps.config().addTo;
    return want && t.includes(want) ? want : (t[0] ?? null);
  }

  /**
   * Queue one add. Refuses at once (no request) when adding is off, the provider
   * isn't connected, or it can't take this kind of input.
   */
  add(input: AddInput, opts: { provider?: AddProvider; title?: string; via: AddJob["via"] }, done?: (j: AddJob) => void): AddJob {
    if (!this.deps.config().allowAdding) throw new AddingOffError();
    const provider = opts.provider ?? this.defaultTarget();
    if (!provider || !this.targets().includes(provider)) throw new Error("Connect TorBox or Real-Debrid in Sources first.");
    if (provider === "realdebrid" && (input.kind === "web" || input.kind === "nzb-url" || input.kind === "nzb-file"))
      throw new Error(input.kind === "web" ? "Real-Debrid can't take web links here. Pick TorBox for links." : "Only TorBox takes Usenet (.nzb).");
    const facts = input.kind === "magnet" ? parseMagnet(input.magnet) : input.kind === "torrent-file" ? safeParse(input.bytes) : null;
    const job: AddJob = {
      id: `a${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      at: Date.now(),
      via: opts.via,
      title: (opts.title || facts?.name || titleFromInput(input)).slice(0, 300),
      provider,
      state: "waiting",
      infoHash: facts?.infoHash ?? undefined,
    };
    this.queue.push({ job, input, done });
    this.deps.log(`Add queued for ${providerName(provider)}: ${job.title.slice(0, 60)}`);
    void this.pump();
    return job;
  }

  /** Read the watched folder once and queue what's new in it. Returns how many were queued. */
  scanFolder(): number {
    const c = this.deps.config();
    if (!c.allowAdding || !c.watchDir || !existsSync(c.watchDir)) return 0;
    let n = 0;
    for (const name of readdirSync(c.watchDir)) {
      const path = join(c.watchDir, name);
      const ext = extname(name).toLowerCase();
      if (![".torrent", ".magnet", ".txt", ".nzb"].includes(ext) || this.folderSeen.has(path)) continue;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      // A file still being written: wait for the next look.
      if (Date.now() - st.mtimeMs < 2_000) continue;
      const bytes = new Uint8Array(readFileSync(path));
      let input: AddInput | null = null;
      if (ext === ".torrent") input = { kind: "torrent-file", bytes, name };
      else if (ext === ".nzb") input = { kind: "nzb-file", bytes, name };
      else {
        const text = new TextDecoder().decode(bytes).trim().split(/\s+/)[0] ?? "";
        const magnet = isMagnet(text) ? text : hashToMagnet(text);
        if (magnet) input = { kind: "magnet", magnet };
      }
      if (!input) continue;
      this.folderSeen.add(path);
      const provider = input.kind === "nzb-file" ? "torbox" : undefined;
      try {
        this.add(input, { via: "folder", provider, title: basename(name, ext) }, (j) => this.fileAway(path, j.state === "added"));
        n++;
      } catch (e) {
        this.deps.log(`Watched folder: ${name}: ${(e as Error).message}`);
        this.fileAway(path, false);
      }
    }
    return n;
  }

  /** Done files move into "added" or "failed" next to them, so the folder shows what happened. */
  private fileAway(path: string, ok: boolean): void {
    try {
      const dir = join(path, "..", ok ? "added" : "failed");
      mkdirSync(dir, { recursive: true });
      renameSync(path, join(dir, basename(path)));
    } catch {}
    this.folderSeen.delete(path);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const next = this.queue[0]!;
        await this.run(next.job, next.input);
        this.queue.shift();
        this.save(next.job);
        next.done?.(next.job);
      }
    } finally {
      this.running = false;
    }
  }

  private save(job: AddJob): void {
    this.file.update((s) => {
      s.jobs = [job, ...s.jobs.filter((j) => j.id !== job.id)].slice(0, KEEP_JOBS);
    });
  }

  private async run(job: AddJob, input: AddInput): Promise<void> {
    job.state = "adding";
    try {
      if (!this.deps.config().allowAdding) throw new AddingOffError();
      // A search result's .torrent link is fetched here, by DebridTV, then sent on as a file or magnet.
      if (input.kind === "torrent-url") input = await this.fetchTorrent(input.url);
      if (input.kind === "torrent-file") {
        const f = safeParse(input.bytes);
        if (!f) throw new Error("That file isn't a valid .torrent.");
        job.infoHash ??= f.infoHash ?? undefined;
      }
      if (job.provider === "realdebrid") await this.addRd(job, input);
      else await this.addTb(job, input);
      job.state = "added";
      this.deps.log(`Added to ${providerName(job.provider)}: ${job.title.slice(0, 60)}`);
      this.refreshSoon(job.provider);
    } catch (e) {
      job.state = "failed";
      job.message = plainFailure(e, job.provider);
      this.deps.log(`Add failed (${providerName(job.provider)}): ${job.message}`);
    }
    job.doneAt = Date.now();
  }

  private async space(p: AddProvider): Promise<void> {
    const gap = p === "realdebrid" ? this.t.rdSpacingMs : this.t.tbSpacingMs;
    const wait = this.lastAdd[p] + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAdd[p] = Date.now();
  }

  private async addRd(job: AddJob, input: AddInput): Promise<void> {
    const c = this.deps.config();
    const rd = new RealDebridWriter(this.deps.bases.realdebrid, c.rdToken!, this.deps.counter);
    const rootName = input.kind === "torrent-file" ? safeParse(input.bytes)?.name : input.kind === "magnet" ? parseMagnet(input.magnet).name : null;
    let added: { id: string } | null = null;
    for (let attempt = 0; !added; attempt++) {
      await this.space("realdebrid");
      try {
        added = input.kind === "magnet" ? await rd.addMagnet(input.magnet) : await rd.addTorrent((input as { bytes: Uint8Array }).bytes);
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === "policy")) throw e;
        // A refused name is refused every time; anything else is usually the account's pause.
        const tag = rootName ? rdRefusedTag(rootName) : null;
        if (tag) throw new FriendlyError(`Real-Debrid refuses torrents with "${tag}" in the name. Try adding it to TorBox instead.`);
        const hold = this.t.rdHoldsMs[attempt];
        if (hold == null)
          throw new FriendlyError("Real-Debrid is still refusing adds on your account, so this is most likely not about this torrent. Adds from other apps on the same account count too. Try again in a few minutes.");
        job.message = `Real-Debrid is pausing adds on your account. Trying again in ${Math.round(hold / 1000)} s…`;
        this.lastAdd.realdebrid = Date.now() + hold - this.t.rdSpacingMs; // every add on this account waits too
        await sleep(hold);
      }
    }
    job.providerId = added.id;
    job.message = undefined;
    // RD turns a magnet into a file list first, then keeps nothing until files are chosen.
    let info: RdTorrentInfo | null = null;
    for (let i = 0; i < this.t.rdPollTries; i++) {
      info = await rd.info(added.id);
      if (info.status !== "magnet_conversion" && info.status !== "queued") break;
      await sleep(this.t.rdPollMs);
    }
    if (!info) return;
    if (info.hash) job.infoHash = info.hash.toLowerCase();
    if (info.status === "waiting_files_selection") {
      await rd.selectFiles(added.id, pickFiles(info.files));
      info = await rd.info(added.id);
    }
    job.message = info.status === "downloaded"
      ? "Ready. It joins your channels after the next scan."
      : info.status === "magnet_conversion"
        ? "Real-Debrid is still reading the magnet. Pick its files on real-debrid.com if it doesn't continue."
        : `Real-Debrid is fetching it (${info.status}). It joins your channels when it's finished.`;
  }

  private async addTb(job: AddJob, input: AddInput): Promise<void> {
    const c = this.deps.config();
    const tb = new TorBoxWriter(this.deps.bases.torbox, c.torboxKey!, this.deps.counter);
    await this.space("torbox");
    const r =
      input.kind === "magnet" ? await tb.createTorrent({ magnet: input.magnet })
      : input.kind === "torrent-file" ? await tb.createTorrent({ file: input.bytes, name: input.name.endsWith(".torrent") ? input.name : `${input.name}.torrent` })
      : input.kind === "web" ? await tb.createWebDownload(input.url)
      : input.kind === "nzb-url" ? await tb.createUsenetDownload({ link: input.url })
      : input.kind === "nzb-file" ? await tb.createUsenetDownload({ file: input.bytes, name: input.name })
      : (() => { throw new Error("unsupported"); })();
    job.providerId = r.id;
    if (r.hash) job.infoHash = r.hash;
    job.message = "Added to TorBox. It joins your channels when TorBox has finished it and a scan has timed it.";
  }

  /** Fetch a .torrent link, following redirects by hand: indexers often redirect to a magnet. */
  private async fetchTorrent(url: string): Promise<AddInput> {
    const f = this.deps.fetch ?? fetch;
    let at = url;
    for (let hop = 0; hop < 5; hop++) {
      if (isMagnet(at)) return { kind: "magnet", magnet: at };
      if (!/^https?:\/\//i.test(at)) throw new FriendlyError("The search result's link isn't a web address.");
      const res = await f(at, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        at = new URL(loc, at).toString().startsWith("magnet:") ? loc : new URL(loc, at).toString();
        continue;
      }
      if (!res.ok) throw new FriendlyError(`The .torrent link answered HTTP ${res.status}.`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_FILE_BYTES) throw new FriendlyError("That .torrent file is too big.");
      if (buf[0] !== 0x64 /* d */ || !safeParse(buf)) throw new FriendlyError("The link didn't give a .torrent file.");
      return { kind: "torrent-file", bytes: buf, name: decodeURIComponent(new URL(at).pathname.split("/").pop() || "download.torrent") };
    }
    throw new FriendlyError("The .torrent link redirected too many times.");
  }

  private refreshSoon(p: AddProvider): void {
    clearTimeout(this.refreshTimers[p]);
    this.refreshTimers[p] = setTimeout(() => this.deps.onAdded(p), this.t.refreshAfterMs);
  }

  /** For shutdown and tests. */
  stop(): void {
    for (const t of Object.values(this.refreshTimers)) clearTimeout(t);
  }
}

class FriendlyError extends Error {}

/** Video (and music) files, without samples; everything when nothing matches. */
export function pickFiles(files: RdTorrentInfo["files"]): number[] | "all" {
  const keep = files.filter((f) => {
    const ext = extname(f.path).toLowerCase();
    if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) return false;
    return !/(^|[\/._ -])sample([\/._ -]|$)/i.test(f.path);
  });
  return keep.length ? keep.map((f) => f.id) : "all";
}

function safeParse(bytes: Uint8Array) {
  try {
    return parseTorrent(bytes);
  } catch {
    return null;
  }
}

function titleFromInput(input: AddInput): string {
  if (input.kind === "torrent-file" || input.kind === "nzb-file") return input.name;
  if (input.kind === "magnet") return parseMagnet(input.magnet).infoHash ?? "Magnet link";
  try {
    return decodeURIComponent(new URL(input.url).pathname.split("/").pop() || input.url);
  } catch {
    return input.url;
  }
}

const providerName = (p: AddProvider) => (p === "torbox" ? "TorBox" : "Real-Debrid");

function plainFailure(e: unknown, p: AddProvider): string {
  if (e instanceof FriendlyError || e instanceof AddingOffError) return e.message;
  const who = providerName(p);
  if (e instanceof ProviderError) {
    if (e.kind === "auth") return `${who} didn't accept your key. Reconnect it in Sources.`;
    if (e.kind === "account") return `${who} refused your account (locked, or premium ended).`;
    if (e.kind === "rate-limited") return `${who} asked DebridTV to slow down. Try again in a few minutes.`;
    if (e.kind === "transient") return `${who} is having trouble right now (HTTP ${e.status}). Try again later.`;
    let detail = "";
    try {
      const b = JSON.parse(e.message) as { error?: string; detail?: string };
      detail = b.detail || b.error || "";
    } catch {}
    return `${who} didn't take it${detail ? `: ${detail}` : ` (HTTP ${e.status})`}.`;
  }
  return (e as Error)?.message || String(e);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the viewer pasted, one add per line: magnet links, bare info hashes,
 * .torrent links, .nzb links, and (TorBox only) any other web link.
 * Lines that are none of those are returned in `skipped`.
 */
export function parsePaste(text: string): { inputs: AddInput[]; skipped: string[] } {
  const inputs: AddInput[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const magnet = isMagnet(line) ? line : hashToMagnet(line);
    if (magnet) {
      inputs.push({ kind: "magnet", magnet });
      continue;
    }
    let u: URL | null = null;
    try {
      u = /^https?:\/\//i.test(line) ? new URL(line) : null;
    } catch {}
    if (!u) {
      skipped.push(line.slice(0, 120));
      continue;
    }
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".torrent")) inputs.push({ kind: "torrent-url", url: line });
    else if (path.endsWith(".nzb") || /[?&]t=get\b/.test(u.search)) inputs.push({ kind: "nzb-url", url: line });
    else inputs.push({ kind: "web", url: line });
  }
  return { inputs, skipped };
}
