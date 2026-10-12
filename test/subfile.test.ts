// Loading your own subtitle file in the player (docs/parity/player.md).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: a browser module with no types
import { parseSubs } from "../app/public/js/subfile.js";

test("Player: SRT and WebVTT files parse to cues in ms, keeping only <i>/<b>", () => {
  const srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i> <font color=red>there</font>\r\n\r\n2\r\n01:02:03,040 --> 01:02:04,000\r\n{\\an8}Top line\r\nSecond line\r\n";
  assert.deepEqual(parseSubs(srt), [
    { s: 1500, e: 3000, text: "<i>Hello</i> there" },
    { s: 3_723_040, e: 3_724_000, text: "Top line\nSecond line" },
  ]);
  const vtt = "WEBVTT\n\nNOTE skip me\n\n00:05.250 --> 00:06.000 align:start\nShort form\n\nbad --> worse\nnope\n\n00:00:09.000 --> 00:00:08.000\nbackwards\n";
  assert.deepEqual(parseSubs(vtt), [{ s: 5250, e: 6000, text: "Short form" }]);
  assert.deepEqual(parseSubs(""), []);
});
