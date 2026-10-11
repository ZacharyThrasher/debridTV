// Content ratings on one scale. Film (MPAA) and US TV ratings are folded onto the
// film scale so one "highest rating" setting covers both. Anything else, including
// "NR", "Unrated" and a missing rating, is unknown, and an unknown rating never
// passes a limit (gate D7: a kid channel must not air something nobody has rated).

export const RATINGS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
export type Rating = (typeof RATINGS)[number];

const TV: Record<string, Rating> = {
  "TV-Y": "G", "TV-Y7": "G", "TV-Y7-FV": "G", "TV-G": "G",
  "TV-PG": "PG", "TV-14": "PG-13", "TV-MA": "R",
};

/** The highest rating a kid channel airs. */
export const KID_MAX: Rating = "PG";

/**
 * A rating as written in the wild ("Rated PG-13", "US:TV-14", "pg13", "TV-MA")
 * mapped onto the film scale, or null when it can't be read with confidence.
 */
export function normalizeRating(raw: string | null | undefined): Rating | null {
  if (!raw) return null;
  // Kodi writes "US:PG-13" or "Rated PG-13"; several countries may be listed with " / ".
  const parts = raw.split(/\s*\/\s*/);
  const us = parts.find((p) => /^us\s*:/i.test(p.trim())) ?? parts[0]!;
  const s = us.replace(/^\s*[a-z]{2}\s*:\s*/i, "").replace(/^rated\s+/i, "").trim().toUpperCase().replace(/\s+/g, "-");
  if (!s) return null;
  const film = s.replace(/^PG-?13$/, "PG-13").replace(/^NC-?17$/, "NC-17");
  if ((RATINGS as readonly string[]).includes(film)) return film as Rating;
  const tv = s.startsWith("TV") ? s.replace(/^TV-?/, "TV-").replace(/^TV-Y-?7/, "TV-Y7") : "";
  return TV[tv] ?? null;
}

/** 0 for G up to 4 for NC-17; Infinity when unknown, so it fails every limit. */
export function ratingRank(raw: string | null | undefined): number {
  const r = normalizeRating(raw);
  return r ? RATINGS.indexOf(r) : Infinity;
}

/** True when an item with this rating may air under the limit (none = anything goes). */
export function allowedUnder(raw: string | null | undefined, limit: Rating | undefined): boolean {
  return limit === undefined || ratingRank(raw) <= RATINGS.indexOf(limit);
}

/** The stricter of two limits. */
export function stricter(a: Rating | undefined, b: Rating | undefined): Rating | undefined {
  if (!a) return b;
  if (!b) return a;
  return RATINGS.indexOf(a) <= RATINGS.indexOf(b) ? a : b;
}
