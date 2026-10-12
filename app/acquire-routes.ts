// Settings → Add: search the viewer's own indexers and the Internet Archive, add
// a result, a paste or a file to TorBox or Real-Debrid, and the watched folder.
// Every route here is PC only (app/lan/access.ts). Searching sends the query to
// the sources the viewer chose; nothing reaches an account until Add is pressed
// (or a file lands in the watched folder) while "Allow adding" is on.
// Stremio addons the viewer added are searched by IMDb id: typed in, or looked up
// on TMDB from the typed title when online artwork is on (src/acquire/stremio.ts).

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonFile } from "./store.ts";
import type { Config } from "./library.ts";
import { Acquirer, AddingOffError, parsePaste, type AddInput, type AddProvider } from "./acquire.ts";
import { indexerCaps, redactUrl, searchArchive, searchIndexer, type Indexer, type SearchQuery, type SearchResult } from "../src/acquire/search.ts";
import { addonBase, addonHost, addonManifest, readQuery, searchAddon, type StremioTarget } from "../src/acquire/stremio.ts";
import type { ImdbMatch } from "./metadata/tmdb.ts";

export interface AcquireRouteDeps {
  config: JsonFile<Config>;
  bases: { realdebrid: string; torbox: string };
  counter: { add(name: string): void };
  log: (detail: string) => void;
  /** Read the provider's list again and rebuild channels. */
  onAdded: (provider: AddProvider) => void;
  /** Title → IMDb id for Stremio addon search (TMDB, when the viewer turned it on). */
  imdbLookup?: (title: string, media?: "tv" | "movie") => Promise<ImdbMatch | null>;
  /** Tests: the Archive's address, shorter waits, and whether the folder is watched on a timer. */
  archiveBase?: string;
  timing?: ConstructorParameters<typeof Acquirer>[0]["timing"];
  timers?: boolean;
}

type Reply = { status: number; body: unknown };
const KEY_STAND_IN = "__DEBRIDTV_KEY__";

/** Indexer download links often hold the API key (apikey=, jackett_apikey=, or in the path); the browser gets a stand-in. */
function hideKey(r: SearchResult, key?: string): SearchResult {
  if (!key) return r;
  const out = { ...r };
  for (const f of ["torrentUrl", "nzbUrl", "infoUrl", "magnet"] as const) {
    const v = out[f];
    if (typeof v === "string") out[f] = v.split(encodeURIComponent(key)).join(KEY_STAND_IN).split(key).join(KEY_STAND_IN);
  }
  return out;
}
const FOLDER_EVERY_MS = 20_000;

export function acquireRoutes(d: AcquireRouteDeps) {
  const acquirer = new Acquirer({
    config: () => d.config.get(),
    bases: d.bases,
    counter: d.counter,
    log: d.log,
    onAdded: d.onAdded,
    timing: d.timing,
  });
  const folderTimer = d.timers === false ? null : setInterval(() => {
    try {
      acquirer.scanFolder();
    } catch (e) {
      d.log(`Watched folder: ${(e as Error).message}`);
    }
  }, FOLDER_EVERY_MS);
  folderTimer?.unref();

  const indexers = () => d.config.get().indexers ?? [];
  /** The browser never sees a key, only whether one is set. */
  const indexerView = (ix: Indexer) => ({
    id: ix.id,
    name: ix.name,
    // An addon address usually holds the viewer's settings and keys in its path: only the host leaves the PC.
    url: ix.kind === "stremio" ? addonHost(ix.url) : redactUrl(ix.url),
    kind: ix.kind,
    enabled: ix.enabled !== false,
    hasKey: !!ix.apiKey,
  });
  const testSource = (ix: Indexer) => (ix.kind === "stremio" ? addonManifest(ix) : indexerCaps(ix));

  /**
   * What to ask the addons for: a typed IMDb id, or the title looked up on TMDB.
   * Shows need an episode; without one, episode 1 of the season (or of season 1).
   */
  async function addonTarget(q: string, type: SearchQuery["type"]): Promise<{ target: StremioTarget; note: string } | { error: string }> {
    const r = readQuery(q);
    const tv = type === "tvsearch" || r.season != null;
    const media = type === "movie" ? "movie" : tv ? "tv" : undefined;
    let imdbId = r.imdbId;
    let name = imdbId ?? "";
    let isTv = media === "tv";
    if (!imdbId) {
      if (!r.title) return { error: "Type a title or an IMDb id (tt…)" };
      if (!d.imdbLookup) return { error: "Type the IMDb id (tt…), or turn on online artwork in Settings so DebridTV can look titles up" };
      let m: ImdbMatch | null;
      try {
        m = await d.imdbLookup(r.title, media);
      } catch (e) {
        return { error: `Couldn't look the title up: ${(e as Error).message}` };
      }
      if (!m) return { error: `No IMDb id found for “${r.title.slice(0, 60)}”. Type the IMDb id (tt…) instead` };
      imdbId = m.imdbId;
      isTv = m.media === "tv";
      name = `${m.name}${m.year ? ` (${m.year})` : ""}`;
    }
    if (!isTv) return { target: { type: "movie", imdbId }, note: name };
    const season = r.season ?? 1;
    const episode = r.episode ?? 1;
    return {
      target: { type: "series", imdbId, season, episode },
      note: `${name}, S${season} E${episode}${r.episode == null ? " (type S2E5 for another episode)" : ""}`,
    };
  }

  function settings() {
    const c = d.config.get();
    return {
      allowAdding: !!c.allowAdding,
      addTo: acquirer.defaultTarget(),
      targets: acquirer.targets(),
      watchDir: c.watchDir ?? "",
      archiveSearch: c.archiveSearch !== false,
      indexers: indexers().map(indexerView),
    };
  }

  async function search(url: URL): Promise<Reply> {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
    if (!q) return { status: 400, body: { error: "Type something to search for." } };
    const type = url.searchParams.get("type");
    const query: SearchQuery = { q, type: type === "tvsearch" || type === "movie" ? type : "search", limit: 100 };
    const season = Number(url.searchParams.get("season"));
    if (query.type === "tvsearch" && season > 0) query.season = season;
    const only = url.searchParams.get("sources")?.split(",").filter(Boolean);
    const want = (id: string) => !only || only.includes(id);
    const jobs: Array<Promise<{ source: string; results: SearchResult[]; error?: string; note?: string }>> = [];
    const addons = indexers().filter((ix) => ix.kind === "stremio" && ix.enabled !== false && want(ix.id));
    if (addons.length) {
      // One lookup for every addon; they all take the same id.
      const look = addonTarget(q, query.type);
      for (const ix of addons) {
        jobs.push(look.then(async (t) => {
          if ("error" in t) return { source: ix.name, results: [], error: t.error };
          try {
            const r = await searchAddon(ix, t.target);
            const left = r.skipped ? ` · ${r.skipped} play-only link${r.skipped === 1 ? "" : "s"} left out` : "";
            return { source: ix.name, results: r.results, note: t.note + left };
          } catch (e) {
            return { source: ix.name, results: [], error: (e as Error).message };
          }
        }));
      }
    }
    for (const ix of indexers()) {
      if (ix.kind === "stremio" || ix.enabled === false || !want(ix.id)) continue;
      jobs.push(searchIndexer(ix, query).then((results) => ({ source: ix.name, results: results.map((r) => hideKey(r, ix.apiKey)) }), (e: Error) => ({ source: ix.name, results: [], error: e.message })));
    }
    if (d.config.get().archiveSearch !== false && want("archive"))
      jobs.push(searchArchive(q, { base: d.archiveBase }).then((results) => ({ source: "Internet Archive", results }), (e: Error) => ({ source: "Internet Archive", results: [], error: e.message })));
    if (!jobs.length) return { status: 409, body: { error: "No search sources are on. Add an indexer or turn on the Internet Archive." } };
    const done = await Promise.all(jobs);
    d.counter.add("search");
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    // The same torrent from two sources shows once (the first source wins).
    for (const r of done.flatMap((x) => x.results)) {
      const key = r.infoHash ? `h:${r.infoHash}` : r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
    }
    results.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1) || (b.size ?? 0) - (a.size ?? 0));
    return { status: 200, body: { q, results: results.slice(0, 200), sources: done.map((x) => ({ source: x.source, count: x.results.length, error: x.error ?? null, ...(x.note ? { note: x.note } : {}) })) } };
  }

  function inputFromResult(r: Partial<SearchResult>): AddInput | null {
    if (typeof r.magnet === "string" && /^magnet:\?/i.test(r.magnet)) return { kind: "magnet", magnet: r.magnet };
    if (typeof r.torrentUrl === "string" && /^https?:\/\//i.test(r.torrentUrl)) return { kind: "torrent-url", url: withKey(r.torrentUrl, r.sourceId) };
    if (typeof r.nzbUrl === "string" && /^https?:\/\//i.test(r.nzbUrl)) return { kind: "nzb-url", url: withKey(r.nzbUrl, r.sourceId) };
    if (typeof r.infoHash === "string" && /^[0-9a-f]{40}$/i.test(r.infoHash)) return { kind: "magnet", magnet: `magnet:?xt=urn:btih:${r.infoHash.toLowerCase()}` };
    return null;
  }
  /** Download links sent to the browser carry a stand-in for the key; put the key back here, on the PC. */
  function withKey(link: string, sourceId?: string): string {
    const ix = indexers().find((i) => i.id === sourceId);
    return ix?.apiKey ? link.split(KEY_STAND_IN).join(encodeURIComponent(ix.apiKey)) : link;
  }

  function add(body: Record<string, unknown>): Reply {
    const provider = body.provider === "torbox" || body.provider === "realdebrid" ? (body.provider as AddProvider) : undefined;
    const inputs: Array<{ input: AddInput; title?: string; via: "search" | "paste" }> = [];
    let skipped: string[] = [];
    if (body.result && typeof body.result === "object") {
      const r = body.result as Partial<SearchResult>;
      const input = inputFromResult(r);
      if (!input) return { status: 400, body: { error: "That result has no link DebridTV can add." } };
      inputs.push({ input, title: typeof r.title === "string" ? r.title : undefined, via: "search" });
    } else if (typeof body.file === "string" && typeof body.name === "string") {
      const bytes = new Uint8Array(Buffer.from(body.file, "base64"));
      const name = body.name.slice(0, 200);
      if (!bytes.byteLength) return { status: 400, body: { error: "That file is empty." } };
      const nzb = /\.nzb$/i.test(name);
      inputs.push({ input: nzb ? { kind: "nzb-file", bytes, name } : { kind: "torrent-file", bytes, name }, via: "paste" });
    } else if (typeof body.text === "string") {
      const p = parsePaste(body.text.slice(0, 200_000));
      skipped = p.skipped;
      for (const input of p.inputs.slice(0, 50)) inputs.push({ input, via: "paste" });
      if (!inputs.length) return { status: 400, body: { error: "Nothing in that looks like a magnet link, info hash, .torrent, .nzb or web link.", skipped } };
    } else return { status: 400, body: { error: "Nothing to add." } };
    const jobs = [];
    const refused: string[] = [];
    for (const x of inputs) {
      try {
        jobs.push(acquirer.add(x.input, { provider: provider ?? (x.input.kind === "nzb-file" || x.input.kind === "nzb-url" ? "torbox" : undefined), title: x.title, via: x.via }));
      } catch (e) {
        if (e instanceof AddingOffError) return { status: 409, body: { error: e.message, addingOff: true } };
        refused.push((e as Error).message);
      }
    }
    if (!jobs.length) return { status: 400, body: { error: refused[0] ?? "Nothing was added.", skipped } };
    return { status: 202, body: { jobs, skipped, refused } };
  }

  function saveSettings(body: Record<string, unknown>): Reply {
    let dir: string | undefined;
    if (typeof body.watchDir === "string" && body.watchDir.trim()) {
      dir = resolve(body.watchDir.trim());
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return { status: 400, body: { error: "That folder doesn't exist on this PC." } };
    }
    d.config.update((c) => {
      if (typeof body.allowAdding === "boolean") c.allowAdding = body.allowAdding;
      if (body.addTo === "torbox" || body.addTo === "realdebrid") c.addTo = body.addTo;
      if (typeof body.archiveSearch === "boolean") c.archiveSearch = body.archiveSearch;
      if ("watchDir" in body) {
        if (dir) c.watchDir = dir;
        else delete c.watchDir;
      }
    });
    if (typeof body.allowAdding === "boolean") d.log(body.allowAdding ? "Adding to your accounts turned on" : "Adding to your accounts turned off");
    return { status: 200, body: settings() };
  }

  async function saveIndexer(body: Record<string, unknown>): Promise<Reply> {
    const kind = body.kind === "newznab" ? "newznab" : body.kind === "stremio" ? "stremio" : "torznab";
    let url = String(body.url ?? "").trim();
    if (kind === "stremio") {
      url = addonBase(url);
      if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) return { status: 400, body: { error: "Enter the addon's address (its manifest.json link, starting with https or stremio)." } };
    } else if (!/^https?:\/\/[^\s]+$/i.test(url)) return { status: 400, body: { error: "Enter the indexer's Torznab or Newznab address (it starts with http)." } };
    const old = indexers().find((i) => i.id === body.id);
    const key = kind === "stremio" ? undefined : typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const ix: Indexer = {
      id: old?.id ?? randomUUID().slice(0, 8),
      name: String(body.name ?? "").trim().slice(0, 60) || new URL(url).hostname,
      url,
      kind,
      enabled: body.enabled === false ? false : true,
      ...(key ? { apiKey: key } : key === "" || kind === "stremio" ? {} : old?.apiKey ? { apiKey: old.apiKey } : {}),
    };
    const test = await testSource(ix);
    if (kind === "stremio" && !String(body.name ?? "").trim() && test.ok && test.title) ix.name = test.title;
    d.config.update((c) => {
      c.indexers = [...(c.indexers ?? []).filter((i) => i.id !== ix.id), ix];
    }, { secret: true });
    d.log(`Search source ${old ? "updated" : "added"}: ${ix.name}${test.ok ? "" : " (it didn't answer the test)"}`);
    return { status: 200, body: { indexer: indexerView(ix), test } };
  }

  return {
    acquirer,
    /** Answers a /api/acquire or /api/indexers request, or null when the path isn't one of them. */
    async handle(p: string, m: string, url: URL, body: Record<string, unknown>): Promise<Reply | null> {
      if (p === "/api/acquire/settings" && m === "GET") return { status: 200, body: settings() };
      if (p === "/api/acquire/settings" && m === "POST") return saveSettings(body);
      if (p === "/api/acquire/search" && m === "GET") return search(url);
      if (p === "/api/acquire/add" && m === "POST") return add(body);
      if (p === "/api/acquire/jobs" && m === "GET") return { status: 200, body: { jobs: acquirer.jobs() } };
      if (p === "/api/acquire/folder" && m === "POST") return { status: 200, body: { queued: acquirer.scanFolder() } };
      if (p === "/api/indexers" && m === "GET") return { status: 200, body: { indexers: indexers().map(indexerView) } };
      if (p === "/api/indexers" && m === "POST") return saveIndexer(body);
      if (p === "/api/indexers/test" && m === "POST") {
        const ix = indexers().find((i) => i.id === body.id);
        return ix ? { status: 200, body: await testSource(ix) } : { status: 404, body: { error: "No such search source." } };
      }
      if (p === "/api/indexers/remove" && m === "POST") {
        d.config.update((c) => {
          c.indexers = (c.indexers ?? []).filter((i) => i.id !== body.id);
        }, { secret: true });
        return { status: 200, body: { indexers: indexers().map(indexerView) } };
      }
      return null;
    },
    stop() {
      if (folderTimer) clearInterval(folderTimer);
      acquirer.stop();
    },
  };
}
