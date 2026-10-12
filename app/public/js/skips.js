// Which parts of a file its chapter titles name as an intro, a recap, the credits or a
// preview (Lean-back pack). Only the file's own chapter titles count: no guessing from
// the sound or the picture, so a file without named chapters gets no skip button.
// Pure: test/skips.test.ts.

const MIN = 60_000;

/** "02 - Opening Credits", "Chapter 3: Intro", "OP" → "opening credits", "intro", "op". */
export function normTitle(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/^\s*(?:chapter|ch\.?|part)?\s*\d+\s*[-:.)]?\s*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** What a chapter title says the chapter is: "intro" | "recap" | "credits" | "preview" | null. */
export function kindOf(title) {
  const t = normTitle(title);
  if (!t) return null;
  if (/^(?:recap|previously(?: on\b.*)?|last time(?: on\b.*)?|the story so far|story so far)$/.test(t)) return "recap";
  if (/^(?:preview|next episode(?: preview)?|next time(?: on\b.*)?|next on\b.*|coming up next|sneak peek)$/.test(t)) return "preview";
  if (/^(?:op|op ?\d+|intro(?:duction)?(?: (?:song|theme|credits|sequence))?|opening(?: (?:credits|titles|theme|song|sequence))?|title sequence|main titles?|theme(?: song)?|titles)$/.test(t)) return "intro";
  if (/^(?:ed|ed ?\d+|credits|end(?:ing)? credits|closing(?: credits)?|end titles|ending(?: (?:theme|song|credits))?|outro)$/.test(t)) return "credits";
  return null;
}

/**
 * The parts to offer a skip for, in file order: [{ kind, from, to }] in file ms.
 * `to` is the next chapter's start, else the end of the file (Infinity when unknown).
 * An intro or recap has to start in the first half and last under 6 minutes; credits and
 * previews have to start in the second half, so a mislabelled chapter can't skip the show.
 * Credits followed straight by a preview are one part.
 */
export function skipParts(chaptersMs = [], names = [], durMs = 0) {
  const ms = chaptersMs.slice();
  // The first chapter starts at 0 even when the list leaves it out.
  if (names.length === ms.length + 1) ms.unshift(0);
  if (!ms.length || names.length !== ms.length) return [];
  const end = durMs > 0 ? durMs : Infinity;
  const half = durMs > 0 ? durMs / 2 : Infinity;
  const out = [];
  for (let i = 0; i < ms.length; i++) {
    const kind = kindOf(names[i]);
    if (!kind) continue;
    const from = ms[i];
    const to = Math.min(ms[i + 1] ?? end, end);
    if (!(to - from >= 5000)) continue;
    if ((kind === "intro" || kind === "recap") && !(from < half && to - from <= 6 * MIN)) continue;
    if ((kind === "credits" || kind === "preview") && !(durMs > 0 ? from >= half : true)) continue;
    const last = out.at(-1);
    if (last && last.to === from && (last.kind === kind || (last.kind === "credits" && kind === "preview"))) last.to = to;
    else out.push({ kind, from, to });
  }
  return out;
}

/** The part the picture is in at `posMs` (with 2 s left to go at least), else null. */
export function partAt(parts, posMs) {
  return parts.find((p) => posMs >= p.from && posMs < p.to - 2000) ?? null;
}

export const SKIP_LABEL = { intro: "Skip intro", recap: "Skip recap", credits: "Skip credits", preview: "Skip preview" };
