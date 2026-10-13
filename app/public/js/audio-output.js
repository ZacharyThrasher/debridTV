// Which sound output the app window's player (mpv) tries when the one it has won't
// open. That happens when another app holds the speakers to itself: VoiceMeeter,
// for one, opens its output device exclusively, and then only VoiceMeeter's own
// inputs make a sound. Pure, so it can be tested on its own.

/** Mixers that take sound and pass it on to the real speakers: the likeliest to be heard. */
const MIXER = /voicemeeter|vb-audio/i;
const MIXER_AUX = /voicemeeter.*\baux\b|\baux\b.*voicemeeter/i;
/** Outputs nobody is likely to be listening to: streaming, cable and display sinks. */
const UNLIKELY = /steam streaming|virtual audio cable|\bcable (in|out)put\b|\bline \d|hdmi|display audio|nvidia|amd high definition|^null$|^pcm$/i;

/**
 * mpv's audio-device-list ([{ name, description }]) in the order to try, leaving
 * out "auto" and the ones that already failed. The output that worked last time
 * (remembered) comes first.
 */
export function rankOutputs(list, failed = [], remembered = null) {
  const bad = new Set(failed);
  const text = (d) => `${d.description ?? ""} ${d.name ?? ""}`;
  const score = (d) => (d.name === remembered ? 0 : MIXER_AUX.test(text(d)) ? 2 : MIXER.test(text(d)) ? 1 : UNLIKELY.test(text(d)) || UNLIKELY.test(d.name ?? "") ? 4 : 3);
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && typeof d.name === "string" && d.name !== "auto" && !bad.has(d.name))
    .map((d, i) => ({ d, i, s: score(d) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.d);
}

/** An mpv log line saying the sound output couldn't be opened. */
export const AUDIO_FAILED = /Could not open\/initialize audio device|Failed to initialize audio driver|Error initializing device|AUDCLNT_E_DEVICE_IN_USE|Failed to init(ialize)? audio output/i;
