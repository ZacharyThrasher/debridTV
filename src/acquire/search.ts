// Search for releases on the viewer's own Torznab/Newznab indexers (Prowlarr,
// Jackett, NZB sites) and on the Internet Archive's public catalogue.
//
// Nothing here downloads anything: it only turns search answers into a common
// SearchResult shape so the caller can show them and hand one to a debrid
// service. Indexer API keys travel in the query string (that's the Torznab and
// Newznab convention), so every message that could reach a log or the screen
// goes through redactUrl/scrub first.
//
// The RSS parser is hand-written to keep the project dependency-free. It only
// understands what indexer feeds actually send: <item> blocks with flat text
// children, CDATA, the five XML entities plus numeric ones, <enclosure> and
// the torznab:/newznab: attr elements. It is not a general XML parser.

export interface Indexer {
  id: string;
  name: string;
  /** The API endpoint, e.g. https://host/api or a Prowlarr ".../1/api" URL. */
  url: string;
  apiKey?: string;
  kind: "torznab" | "newznab";
  enabled?: boolean;
}

export interface SearchResult {
  /** Stable across searches: source id plus info hash, guid or link. */
  id: string;
  /** Indexer name, or "Internet Archive". */
  source: string;
  /** Indexer id, or "archive". */
  sourceId: string;
  kind: "torrent" | "usenet";
  title: string;
  /** Bytes. */
  size: number | null;
  seeders: number | null;
  peers: number | null;
  /** Lower-case hex, when known. */
  infoHash?: string;
  magnet?: string;
  /** http(s) link to a .torrent file. */
  torrentUrl?: string;
  /** Newznab download link. */
  nzbUrl?: string;
  /** ms since the epoch. */
  published?: number;
  category?: string;
  /** Details page, when the indexer gives one. */
  infoUrl?: string;
}

export interface SearchQuery {
  q: string;
  type?: "search" | "tvsearch" | "movie";
  season?: number;
  episode?: number;
  imdbId?: string;
  limit?: number;
}

export interface FetchOpts {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Default 15 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Search one indexer. Throws a readable Error (never containing the API key) on failure. */
export async function searchIndexer(ix: Indexer, q: SearchQuery, o: FetchOpts = {}): Promise<SearchResult[]> {
  const params: Record<string, string> = { t: q.type ?? "search", extended: "1" };
  if (q.q) params.q = q.q;
  if (q.season != null) params.season = String(q.season);
  if (q.episode != null) params.ep = String(q.episode);
  // The Newznab spec wants the bare number; most indexers reject "tt0111161".
  if (q.imdbId) params.imdbid = q.imdbId.replace(/^tt/i, "");
  if (q.limit != null) params.limit = String(q.limit);
  const xml = await getText(ix, params, o);
  const kind = ix.kind === "newznab" ? "usenet" : "torrent";
  const out: SearchResult[] = [];
  for (const item of parseRss(xml)) {
    const r = toResult(ix, kind, item);
    if (r) out.push(r);
  }
  return out;
}

/** Ask an indexer what it supports (t=caps). Used to test a newly added indexer. */
export async function indexerCaps(
  ix: Indexer,
  o: FetchOpts = {},
): Promise<{ ok: true; title?: string; searchTypes: string[] } | { ok: false; error: string }> {
  try {
    const xml = await getText(ix, { t: "caps" }, o);
    const server = /<server\b([^>]*)>/i.exec(xml);
    const title = server ? attrsOf(server[1]!).title : undefined;
    const searchTypes: string[] = [];
    const searching = /<searching\b[^>]*>([\s\S]*?)<\/searching\s*>/i.exec(xml);
    if (searching) {
      for (const m of searching[1]!.matchAll(/<([A-Za-z][\w.-]*)\b([^>]*?)\/?>/g)) {
        if (attrsOf(m[2]!).available?.toLowerCase() === "yes") searchTypes.push(m[1]!);
      }
    }
    if (!server && !searching) return { ok: false, error: "The indexer's answer doesn't look like a Torznab/Newznab caps document" };
    return { ok: true, ...(title ? { title } : {}), searchTypes };
  } catch (e) {
    return { ok: false, error: scrub((e as Error).message, ix.apiKey) };
  }
}

/**
 * Search the Internet Archive's moving-image collection by title. Every result
 * has a .torrent the Archive itself seeds (plus web seeds), so debrid services
 * can fetch it like any other torrent.
 */
export async function searchArchive(
  q: string,
  o: FetchOpts & { base?: string; rows?: number } = {},
): Promise<SearchResult[]> {
  const base = (o.base ?? "https://archive.org").replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("q", `title:(${escapeLucene(q)}) AND mediatype:(movies)`);
  for (const f of ["identifier", "title", "year", "item_size", "downloads"]) params.append("fl[]", f);
  params.append("sort[]", "downloads desc");
  params.set("rows", String(o.rows ?? 40));
  params.set("output", "json");
  const res = await doFetch(`${base}/advancedsearch.php?${params}`, o, "the Internet Archive");
  if (!res.ok) throw new Error(`Internet Archive said HTTP ${res.status}`);
  const body = (await res.json()) as { response?: { docs?: Array<Record<string, unknown>> } };
  const out: SearchResult[] = [];
  for (const d of body.response?.docs ?? []) {
    const id = typeof d.identifier === "string" ? d.identifier : "";
    if (!id) continue;
    // Some fields come back as one-element arrays depending on the item's metadata.
    const title = String(first(d.title) ?? id);
    const year = first(d.year);
    const size = num(first(d.item_size));
    const enc = encodeURIComponent(id);
    out.push({
      id: `archive:${id}`,
      source: "Internet Archive",
      sourceId: "archive",
      kind: "torrent",
      title: title + (year ? ` (${year})` : ""),
      size,
      seeders: null,
      peers: null,
      torrentUrl: `${base}/download/${enc}/${enc}_archive.torrent`,
      infoUrl: `${base}/details/${enc}`,
    });
  }
  return out;
}

/** Hide the API key in a URL (or any text holding one) before it is logged or shown. */
export function redactUrl(url: string): string {
  return url.replace(/([?&;](?:apikey|api_key|api-key)=)[^&#\s"']*/gi, "$1***");
}

/**
 * Pull the <item>s out of an RSS feed. Each record holds the item's flat text
 * children by tag name (first one wins; `categories` keeps them all),
 * `enclosure` as {url, length, type}, and `attrs` from torznab:attr/newznab:attr.
 */
export function parseRss(xml: string): Array<Record<string, any>> {
  const body = stripCdata(xml.replace(/<!--[\s\S]*?-->/g, ""));
  const items: Array<Record<string, any>> = [];
  for (const m of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const item: Record<string, any> = { attrs: {} as Record<string, string>, categories: [] as string[] };
    for (const el of m[1]!.matchAll(/<([A-Za-z_][\w:.-]*)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g)) {
      const tag = el[1]!.toLowerCase();
      const at = attrsOf(el[2] ?? "");
      if (tag.endsWith(":attr")) {
        const name = at.name?.toLowerCase();
        if (name && at.value != null && !(name in item.attrs)) item.attrs[name] = at.value;
      } else if (tag === "enclosure") {
        if (!item.enclosure) item.enclosure = { url: at.url, length: at.length, type: at.type };
      } else if (el[3] != null) {
        const text = decodeEntities(el[3]).trim();
        if (tag === "category") item.categories.push(text);
        if (!(tag in item)) item[tag] = text;
      }
    }
    items.push(item);
  }
  return items;
}

// ---- internals ----

async function getText(ix: Indexer, params: Record<string, string>, o: FetchOpts): Promise<string> {
  const u = new URL(ix.url);
  // Merge into any query the user pasted (Jackett/Prowlarr URLs sometimes carry one).
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (ix.apiKey) u.searchParams.set("apikey", ix.apiKey);
  let res: Response;
  try {
    res = await doFetch(u.toString(), o, "the indexer");
  } catch (e) {
    throw new Error(scrub((e as Error).message, ix.apiKey));
  }
  if (!res.ok) {
    // Many indexers still send an <error> document with a non-2xx status; it says more.
    const text = await res.text().catch(() => "");
    const err = errorOf(text);
    throw new Error(err ? scrub(err, ix.apiKey) : `Indexer said HTTP ${res.status}`);
  }
  const text = await res.text();
  const err = errorOf(text);
  if (err) throw new Error(scrub(err, ix.apiKey));
  return text;
}

async function doFetch(url: string, o: FetchOpts, who: string): Promise<Response> {
  const ms = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(ms)];
  if (o.signal) signals.push(o.signal);
  try {
    return await (o.fetch ?? fetch)(url, { signal: AbortSignal.any(signals), headers: { accept: "application/xml, application/json, */*" } });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError") throw new Error(`No answer from ${who} within ${Math.round(ms / 1000)} s`);
    if (name === "AbortError") throw new Error("Search cancelled");
    // undici hides the useful part ("ECONNREFUSED", "ENOTFOUND") in `cause`.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`Could not reach ${who}: ${redactUrl(cause?.code ?? cause?.message ?? (e as Error).message)}`);
  }
}

/** The description of a Torznab/Newznab <error> reply, or null if the text isn't one. */
function errorOf(text: string): string | null {
  const m = /^\s*(?:<\?xml[^>]*\?>\s*)?<error\b([^>]*)\/?>/i.exec(text);
  if (!m) return null;
  const a = attrsOf(m[1]!);
  return a.description ? `Indexer said: ${a.description}` : `Indexer returned error ${a.code ?? "(no code)"}`;
}

function toResult(ix: Indexer, kind: SearchResult["kind"], item: Record<string, any>): SearchResult | null {
  const title: string | undefined = item.title;
  if (!title) return null;
  const attrs = item.attrs as Record<string, string>;
  const encUrl: string | undefined = item.enclosure?.url;
  const link: string | undefined = item.link;
  const links = [attrs.magneturl, link, encUrl].filter((s): s is string => !!s);
  const magnet = links.find((s) => /^magnet:/i.test(s));
  const http = [encUrl, link].find((s): s is string => !!s && /^https?:\/\//i.test(s));
  const infoHash = normHash(attrs.infohash) ?? (magnet ? hashFromMagnet(magnet) : undefined);
  const guid: string | undefined = item.guid;
  const r: SearchResult = {
    id: `${ix.id}:${infoHash ?? guid ?? link ?? encUrl ?? title}`,
    source: ix.name,
    sourceId: ix.id,
    kind,
    title,
    size: num(attrs.size) ?? num(item.enclosure?.length) ?? num(item.size),
    seeders: num(attrs.seeders),
    peers: num(attrs.peers),
  };
  if (infoHash) r.infoHash = infoHash;
  if (magnet) r.magnet = magnet;
  if (http) {
    if (kind === "torrent") r.torrentUrl = http;
    else r.nzbUrl = http;
  }
  const published = item.pubdate ? Date.parse(item.pubdate) : NaN;
  if (Number.isFinite(published)) r.published = published;
  const category = attrs.category ?? item.category;
  if (category) r.category = category;
  const details = [item.comments, guid].find((s): s is string => !!s && /^https?:\/\//i.test(s) && s !== http);
  if (details) r.infoUrl = details;
  return r;
}

/** The btih of a magnet link as lower-case hex (base32 hashes are converted). */
function hashFromMagnet(magnet: string): string | undefined {
  const m = /[?&]xt=urn:btih:([A-Za-z0-9]+)/i.exec(magnet);
  return m ? normHash(m[1]!) : undefined;
}

function normHash(h: string | undefined): string | undefined {
  if (!h) return undefined;
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(h)) return base32ToHex(h.toUpperCase());
  return undefined;
}

function base32ToHex(s: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Turn CDATA sections into escaped text so one entity decode later gives the raw content back. */
function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** Backslash-escape Lucene's special characters so a title can't change the query. */
function escapeLucene(s: string): string {
  return s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}

/** Redact key-shaped URL params and, belt and braces, the key itself wherever it appears. */
function scrub(msg: string, apiKey?: string): string {
  let out = redactUrl(msg);
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join("***");
  return out;
}
