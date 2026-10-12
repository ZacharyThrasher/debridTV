// Sleep timer (Lean-back pack): after 15, 30 or 60 minutes, or at the end of the program
// on screen, the sound fades and the picture dims, then the station signs off the usual
// way (signoff.js): every stream stops, so nothing more is fetched until someone presses
// a key. A key or click while it fades cancels the timer instead. Off unless the viewer
// sets it, and it lasts only until it runs out (it isn't remembered for next time).

import * as player from "./player.js";
import { tv } from "./player.js";
import { signOffNow, signedOff } from "./signoff.js";
import { osd } from "./ui.js";
import { pref, viewNow, toast, fmtTime } from "./util.js";
import * as fx from "./avfx.js";

const video = document.getElementById("video");

/** The menu's choices: minutes, or "end" for the end of the program on screen. */
export const SLEEP_CHOICES = [[0, "Off"], [15, "15 minutes"], [30, "30 minutes"], [60, "60 minutes"], ["end", "End of this program"]];

/** How long the fade lasts (20 s; tests shorten it with pref sleepFadeSec). */
const fadeMs = () => (Number(pref("sleepFadeSec")) || 20) * 1000;

let timer = null; // { mode: 15 | 30 | 60 | "end", at?: Date.now() deadline, itemId?: the program it waits for }
let fade = null; // { t0, volume }

const dim = Object.assign(document.createElement("div"), { id: "sleepdim", hidden: true });
dim.setAttribute("aria-hidden", "true");
document.body.append(dim);

/** Set the timer (minutes or "end"); 0 or null turns it off. */
export function setSleep(mode) {
  cancelFade();
  if (!mode) {
    const had = !!timer;
    timer = null;
    if (had) osd("SLEEP", "Off", 1500);
    return changed();
  }
  if (mode === "end") {
    const t = player.timeline();
    if (!t) return void osd("SLEEP", "Nothing with an end is on right now", 2000);
    timer = { mode, itemId: t.itemId };
    const left = leftMs();
    osd("SLEEP", left != null ? `At the end of this program (${fmtTime(Date.now() + left)})` : "At the end of this program", 2200);
  } else {
    timer = { mode: Number(mode), at: Date.now() + Number(mode) * 60_000 };
    osd("SLEEP", `In ${mode} minutes`, 1800);
  }
  changed();
}

/** { mode, leftMs } while a timer is set, else null. */
export function sleepState() {
  if (!timer) return null;
  return { mode: timer.mode, leftMs: leftMs(), fading: !!fade };
}

/** The timer waits for the end of a program (leanback.js lets it have the end of an On Demand file). */
export const sleepAtEnd = () => timer?.mode === "end";

/** Start the fade now (the program it was waiting for has ended). */
export function sleepNow() {
  if (timer && !fade) startFade();
}

function changed() {
  dispatchEvent(new CustomEvent("debridtv:sleep", { detail: sleepState() }));
}

/** Time until the station signs off, in ms (null when it can't be known yet). */
function leftMs() {
  if (!timer) return null;
  if (timer.at) return Math.max(0, timer.at - Date.now());
  const t = player.timeline();
  if (!t) return null;
  // The program it was waiting for is over (a new one is on, or On Demand went back to live).
  if (t.itemId !== timer.itemId) return 0;
  if (t.durMs > 0) return Math.max(0, (t.durMs - t.posMs) / (player.currentRate?.() || 1));
  const a = tv.info?.airing;
  return a?.end ? Math.max(0, a.end - viewNow()) : null;
}

function startFade() {
  fade = { t0: performance.now(), volume: video.volume };
  dim.hidden = false;
  dim.style.opacity = "0";
  osd("SLEEP", "Signing off. Press any key to keep watching.", 4000);
  changed();
}

function cancelFade() {
  if (!fade) return;
  fade = null;
  dim.hidden = true;
  dim.style.opacity = "0";
  fx.applySound();
}

setInterval(() => {
  if (!timer) return;
  if (signedOff()) return void ((timer = null), cancelFade(), changed());
  if (!fade) {
    const left = leftMs();
    if (left != null && left <= fadeMs()) startFade();
    return;
  }
  const p = Math.min(1, (performance.now() - fade.t0) / fadeMs());
  video.volume = Math.max(0, fade.volume * (1 - p));
  dim.style.opacity = String(0.92 * p);
  if (p < 1) return;
  timer = null;
  signOffNow("sleep");
  cancelFade();
  changed();
}, 250);

// A key or click during the fade keeps the station on: it cancels the timer, and the key
// does nothing else (like answering "Still watching?").
function wake(e) {
  if (!fade) return;
  if (e.cancelable) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  timer = null;
  cancelFade();
  changed();
  toast("Sleep timer off. Keep watching.");
}
addEventListener("keydown", wake, { capture: true });
addEventListener("pointerdown", wake, { capture: true });
