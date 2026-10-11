// Filename (+ folder context) -> media identity. Pure, no I/O.

export type Parsed =
  | { kind: "episode"; show: string; showKey: string; season: number; episode: number; episodeEnd?: number; year?: number; absolute?: boolean }
  | { kind: "movie"; title: string; titleKey: string; year?: number }
  | { kind: "other"; reason: "not-video" | "sample" | "extra" | "unknown" };

const VIDEO_EXT = new Set(["mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "wmv"]);

const MAX_YEAR = new Date().getFullYear() + 1;

function isYear(n: number): boolean {
  return n >= 1900 && n <= 2099 && n <= MAX_YEAR;
}

/** Stable grouping key: lowercase, alphanumerics only, single spaces. */
export function titleKeyOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Junk detection (release tags that terminate a title)

const JUNK_RES = [
  /^(\d{3,4}[pi]|[248]k|uhd|fhd|qhd)$/,
  /^(bluray|bdrip|brrip|bdremux|remux|webrip|webdl|webdlrip|hdtv|pdtv|dvdrip|dvdscr|dvd|hdrip|hdcam|telesync|screener|amzn|dsnp|hmax|atvp|pcok)$/,
  /^(x26[45]|h26[45]|hevc|avc|xvid|divx|vp9|av1|10bit|8bit|hi10p|hdr|hdr10|hdr10plus|dovi|sdr)$/,
  /^(aac\d*|ac3|eac3|dts|dtshd|dtsx|ddp\d*|dd\d+|atmos|truehd|flac|lpcm)$/,
  /^(proper|repack|rerip|extended|unrated|uncut|remastered|imax|multi|dubbed|subbed|directors|theatrical|readnfo)$/,
  /^(s\d{1,2}|s\d{1,2}e\d{1,3}|\d{1,2}x\d{2,3})$/,
];

function isJunk(tokens: string[], i: number): boolean {
  const raw = tokens[i].toLowerCase();
  const next = (tokens[i + 1] ?? "").toLowerCase();
  if (raw === "web" && (next === "dl" || next === "rip")) return true;
  if (raw === "blu" && next === "ray") return true;
  if (raw === "season" && /^\d{1,2}$/.test(next)) return true;
  const forms = [raw, raw.replace(/-/g, ""), raw.split("-")[0]];
  return forms.some((f) => f !== "" && JUNK_RES.some((re) => re.test(f)));
}

function splitTokens(s: string): string[] {
  return s.replace(/[._]+/g, " ").split(/\s+/).filter((t) => t !== "");
}

function tidy(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/^[\s\-–]+|[\s\-–]+$/g, "")
    .replace(/\s+/g, " ");
}

interface Cleaned {
  title: string;
  year?: number;
}

/**
 * Turn the portion of a name that holds the title (and maybe a year) into a clean title.
 * `stripYear`: a trailing/embedded year is removed and returned.
 */
function cleanTitle(raw: string): Cleaned {
  let year: number | undefined;
  // bracketed years are authoritative: "Title (2017)" / "Title [2017]"
  let s = raw.replace(/[(\[]\s*((?:19|20)\d\d)\s*[)\]]/g, (_m, y: string) => {
    const n = Number(y);
    if (isYear(n)) year = n;
    return " ";
  });
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/[()]/g, " ");
  const tokens = splitTokens(s);
  let junk = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (isJunk(tokens, i)) {
      junk = i;
      break;
    }
  }
  let end = junk;
  if (year === undefined) {
    // last plausible year after the first token, before the release junk
    for (let i = junk - 1; i >= 1; i--) {
      if (/^(19|20)\d\d$/.test(tokens[i]) && isYear(Number(tokens[i]))) {
        year = Number(tokens[i]);
        end = i;
        break;
      }
    }
  }
  return { title: tidy(tokens.slice(0, end)), year };
}

// ---------------------------------------------------------------------------
// Folder context

const GENERIC_FOLDER = new Set([
  "tv", "tv shows", "tv series", "shows", "series", "movies", "movie", "films", "film", "anime", "downloads",
  "download", "media", "video", "videos", "complete", "specials", "season 0", "torrents", "incoming", "data",
  "mnt", "home", "library", "usr", "storage", "nas", "plex", "jellyfin", "emby",
]);

const EXTRA_FOLDER = new Set([
  "extra", "extras", "featurette", "featurettes", "trailer", "trailers", "behind the scenes", "deleted scenes",
  "bonus", "bonus features", "interviews", "other",
]);

const SAMPLE_FOLDER = new Set(["sample", "samples"]);

interface FolderInfo {
  title: string;
  key: string;
  year?: number;
  season?: number;
}

function isSeasonFolder(name: string): number | undefined {
  const m = /^(?:season|series|saison|staffel|s)[\s._-]*(\d{1,2})$/i.exec(name.trim());
  return m ? Number(m[1]) : undefined;
}

function folderInfo(name: string): FolderInfo {
  const season = isSeasonFolder(name);
  if (season !== undefined) return { title: "", key: "", season };
  const c = cleanTitle(name);
  const title = c.title;
  return { title, key: titleKeyOf(title), year: c.year };
}

function isGenericFolder(name: string): boolean {
  const k = titleKeyOf(name);
  return GENERIC_FOLDER.has(k) || k === "";
}

// ---------------------------------------------------------------------------

interface EpMatch {
  index: number; // where the pattern starts in the normalized name
  season?: number;
  episode: number;
  episodeEnd?: number;
  absolute?: boolean;
  season1Default?: boolean;
}

function matchEpisode(n: string, hadBrackets: boolean): EpMatch | undefined {
  let m = /(?:^|[^a-z0-9])s(\d{1,2})[ ]?e(\d{1,3})((?:[ ]?-?[ ]?e\d{1,3})*)(?:[ ]?-[ ]?(\d{1,3})(?![\dpi]))?/i.exec(n);
  if (m) {
    const lead = m[0].search(/s\d/i);
    const ep = Number(m[2]);
    let end: number | undefined;
    const extra = m[3].match(/\d{1,3}/g);
    if (extra) end = Number(extra[extra.length - 1]);
    if (m[4] !== undefined && Number(m[4]) > (end ?? ep)) end = Number(m[4]);
    return { index: m.index + lead, season: Number(m[1]), episode: ep, episodeEnd: end !== undefined && end > ep ? end : undefined };
  }
  m = /\bseason[ ]?(\d{1,2})[ ,.\-]*episode[ ]?(\d{1,3})\b/i.exec(n);
  if (m) return { index: m.index, season: Number(m[1]), episode: Number(m[2]) };
  m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![a-z0-9])/i.exec(n);
  if (m) {
    const lead = m[0].search(/\d/);
    return { index: m.index + lead, season: Number(m[1]), episode: Number(m[2]) };
  }
  // anime: "Show Name - 12" (group tags were stripped already)
  m = /^(.*?)\s+-\s+(\d{1,4})(?:v\d+)?(?=\s|$)/.exec(n);
  if (m && m[1].trim() !== "") {
    const num = Number(m[2]);
    const fourDigit = m[2].length === 4;
    if (!fourDigit || (hadBrackets && !isYear(num) && !(num >= 1900 && num <= 2099))) {
      return { index: m[1].length, episode: num, absolute: true };
    }
  }
  m = /(?:^|[^a-z0-9])(?:episode|ep|e)[ ]?(\d{1,3})(?![a-z0-9])/i.exec(n);
  if (m) {
    const lead = m[0].search(/[a-z]/i);
    return { index: m.index + lead, episode: Number(m[1]), season1Default: true };
  }
  return undefined;
}

export function parseName(path: string): Parsed {
  const segs = path.split(/[\\/]+/).filter((s) => s !== "");
  if (segs.length === 0) return { kind: "other", reason: "unknown" };
  const file = segs[segs.length - 1];
  const folders = segs.slice(0, -1);

  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
  if (!VIDEO_EXT.has(ext)) return { kind: "other", reason: "not-video" };
  const base = file.slice(0, dot);

  // normalized working copy: separators -> spaces, bracket groups removed
  const hadBrackets = /\[[^\]]*\]/.test(base);
  const norm = base
    .replace(/[(\[]\s*((?:19|20)\d\d)\s*[)\]]/g, " ($1) ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normKey = titleKeyOf(norm);

  // samples
  if (/(?:^| )samples?(?: |$)/.test(normKey) || folders.some((f) => SAMPLE_FOLDER.has(titleKeyOf(f)))) {
    return { kind: "other", reason: "sample" };
  }
  if (folders.some((f) => EXTRA_FOLDER.has(titleKeyOf(f)))) return { kind: "other", reason: "extra" };

  const ep = matchEpisode(norm, hadBrackets);

  if (!ep && /(?:^| )(?:trailers?|featurettes?|behind the scenes|deleted scenes?|bonus features?|extras?)(?: |$)/.test(normKey)) {
    return { kind: "other", reason: "extra" };
  }

  // folder lookups (deepest first)
  const folderSeason = (): number | undefined => {
    for (let i = folders.length - 1; i >= 0; i--) {
      const s = isSeasonFolder(folders[i]);
      if (s !== undefined) return s;
      if (/^specials?$/i.test(folders[i].trim())) return 0;
    }
    return undefined;
  };
  const contextFolder = (): FolderInfo | undefined => {
    for (let i = folders.length - 1; i >= 0; i--) {
      if (isGenericFolder(folders[i])) continue;
      const info = folderInfo(folders[i]);
      if (info.title !== "") return info;
    }
    return undefined;
  };
  const yearFromFolders = (key: string): number | undefined => {
    for (let i = folders.length - 1; i >= 0; i--) {
      const info = folderInfo(folders[i]);
      if (info.key === key && info.year !== undefined) return info.year;
    }
    return undefined;
  };

  if (ep) {
    let head = norm.slice(0, ep.index);
    let season = ep.season;
    if (ep.absolute) {
      // "Show Name S2 - 05" / "Show Name Season 2 - 05"
      const sm = /^(.*?)\s+(?:s|season\s?)(\d{1,2})\s*$/i.exec(head);
      if (sm) {
        head = sm[1];
        season = Number(sm[2]);
      }
    }
    let { title, year } = cleanTitle(head);
    if (title === "") {
      const ctx = contextFolder();
      if (ctx) {
        title = ctx.title;
        year = year ?? ctx.year;
      }
    }
    if (title === "") return { kind: "other", reason: "unknown" };
    if (season === undefined) season = ep.season1Default ? folderSeason() ?? 1 : 1;
    const showKey = titleKeyOf(title);
    year = year ?? yearFromFolders(showKey);
    const out: Parsed = { kind: "episode", show: title, showKey, season, episode: ep.episode };
    if (ep.episodeEnd !== undefined) out.episodeEnd = ep.episodeEnd;
    if (year !== undefined) out.year = year;
    if (ep.absolute && ep.season === undefined && season === 1) out.absolute = true;
    return out;
  }

  // movie
  let { title, year } = cleanTitle(norm);
  const GENERIC_FILE = new Set(["movie", "video", "film", "file", "main", "feature", "title", "disc", "part 1"]);
  if (title === "" || GENERIC_FILE.has(titleKeyOf(title))) {
    const ctx = contextFolder();
    if (ctx) {
      title = ctx.title;
      year = year ?? ctx.year;
    }
  }
  if (title === "") return { kind: "other", reason: "unknown" };
  const titleKey = titleKeyOf(title);
  if (titleKey === "") return { kind: "other", reason: "unknown" };
  year = year ?? yearFromFolders(titleKey);
  const out: Parsed = { kind: "movie", title, titleKey };
  if (year !== undefined) out.year = year;
  return out;
}
