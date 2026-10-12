// Skip intro / Skip credits (Lean-back pack): which parts the chapter titles name.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: a browser module with no types
import { kindOf, skipParts, partAt } from "../app/public/js/skips.js";

const MIN = 60_000;

test("Lean-back: chapter titles that mean intro, recap, credits or preview, and ones that don't", () => {
  for (const t of ["Intro", "OP", "Opening", "Opening Credits", "02 - Opening Theme", "Chapter 1: Intro", "Title Sequence", "Main Titles", "Theme Song", "OP2"])
    assert.equal(kindOf(t), "intro", t);
  for (const t of ["Recap", "Previously", "Previously on Harbor Lights", "Story So Far"]) assert.equal(kindOf(t), "recap", t);
  for (const t of ["Credits", "End Credits", "Ending", "ED", "Closing Credits", "Outro", "Ending Theme", "End Titles"]) assert.equal(kindOf(t), "credits", t);
  for (const t of ["Preview", "Next Episode", "Next Episode Preview", "Next time on Harbor Lights"]) assert.equal(kindOf(t), "preview", t);
  for (const t of ["Cold open", "Prologue", "Act 1", "Chapter 2", "Part 3", "Introducing Mr. Pink", "The Credits Roll Twice", "", null])
    assert.equal(kindOf(t), null, String(t));
});

test("Lean-back: skip parts run to the next chapter; credits and a preview join; mislabelled spots are ignored", () => {
  const ms = [0, 60_000, 150_000, 20 * MIN, 21 * MIN + 30_000];
  const names = ["Recap", "Opening", "Act 1", "Ending", "Preview"];
  assert.deepEqual(skipParts(ms, names, 22 * MIN), [
    { kind: "recap", from: 0, to: 60_000 },
    { kind: "intro", from: 60_000, to: 150_000 },
    { kind: "credits", from: 20 * MIN, to: 22 * MIN },
  ]);
  // "Credits" in the first half or an intro in the second half isn't trusted; nor is a 7-minute intro or a 3-second one.
  assert.deepEqual(skipParts([0, 3000, 10 * MIN, 30 * MIN, 40 * MIN], ["Intro", "Credits", "Act", "Intro", "Credits"], 44 * MIN), [
    { kind: "credits", from: 40 * MIN, to: 44 * MIN },
  ]);
  assert.deepEqual(skipParts([0, 7 * MIN], ["Intro", "Act 1"], 22 * MIN), []);
  // The list may leave out the first chapter's 0; names must line up, else nothing.
  assert.deepEqual(skipParts([90_000], ["Intro", "Act 1"], 22 * MIN), [{ kind: "intro", from: 0, to: 90_000 }]);
  assert.deepEqual(skipParts([0, 90_000], ["Intro"], 22 * MIN), []);
  assert.deepEqual(skipParts([0, 90_000], [], 22 * MIN), []);
  // With no known length, credits run to the end of the file.
  assert.deepEqual(skipParts([0, 20 * MIN], ["Act 1", "Credits"], 0), [{ kind: "credits", from: 20 * MIN, to: Infinity }]);
});

test("Lean-back: the button shows inside a part until 2 s before its end", () => {
  const parts = [{ kind: "intro", from: 10_000, to: 70_000 }];
  assert.equal(partAt(parts, 9_000), null);
  assert.equal(partAt(parts, 10_000)?.kind, "intro");
  assert.equal(partAt(parts, 67_999)?.kind, "intro");
  assert.equal(partAt(parts, 68_000), null);
});
