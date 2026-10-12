import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: a browser module with no types
import { rankOutputs, AUDIO_FAILED } from "../app/public/js/audio-output.js";

// Zachary's PC, 2026-10-12: VoiceMeeter held the FiiO, the Windows default.
const pc = [
  { name: "auto", description: "Autoselect device" },
  { name: "wasapi/{a}", description: "Speakers (4- FiiO K7)" },
  { name: "wasapi/{b}", description: "Odyssey G85SB (NVIDIA High Definition Audio)" },
  { name: "wasapi/{c}", description: "Steam Streaming Speakers (Steam Streaming Speakers)" },
  { name: "wasapi/{d}", description: "VoiceMeeter Aux Input (VB-Audio VoiceMeeter AUX VAIO)" },
  { name: "wasapi/{e}", description: "Headphones (Samson Q2U Microphone)" },
  { name: "wasapi/{f}", description: "Line 1 (Virtual Audio Cable)" },
  { name: "wasapi/{g}", description: "VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)" },
];
const names = (l: { name: string }[]) => l.map((d) => d.name);

describe("sound output fallback", () => {
  it("tries VoiceMeeter's input first, then the other real outputs, display and streaming sinks last", () => {
    assert.deepEqual(names(rankOutputs(pc, ["auto"])), ["wasapi/{g}", "wasapi/{d}", "wasapi/{a}", "wasapi/{e}", "wasapi/{b}", "wasapi/{c}", "wasapi/{f}"]);
  });
  it("skips outputs that failed and puts last time's choice first", () => {
    assert.deepEqual(names(rankOutputs(pc, ["wasapi/{g}", "wasapi/{d}"], "wasapi/{e}")).slice(0, 2), ["wasapi/{e}", "wasapi/{a}"]);
    assert.deepEqual(rankOutputs([{ name: "auto" }], ["auto"]), []);
    assert.deepEqual(rankOutputs(null), []);
  });
  it("recognises mpv's errors for an output that won't open", () => {
    for (const line of ["Error initializing device: AUDCLNT_E_DEVICE_IN_USE (0x8889000a)", "Failed to initialize audio driver 'wasapi'", "Could not open/initialize audio device -> no sound."])
      assert.match(line, AUDIO_FAILED);
    assert.doesNotMatch("Audio device underrun detected.", AUDIO_FAILED);
  });
});
