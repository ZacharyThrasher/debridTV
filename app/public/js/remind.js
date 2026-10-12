// Remind me / Tune me (Lean-back pack). Any program still to come in the guide can get a
// reminder: at its start time a notice says it's on, with Watch now one press away. Or
// "Tune me": the set changes channel by itself when it starts. Kept on this device
// (pref "reminders"). Setting one costs nothing; at start time it is an ordinary tune.

import { html, pref, setPref, now, fmtTime, toast } from "./util.js";
import { tv, tune, timeShift, backToLive } from "./player.js";
import { signedOff } from "./signoff.js";
import { guideOpen, closeGuide } from "./guide.js";
import { panelOpen } from "./panel.js";
import { activeLayer } from "./spatial.js";

const NOTICE_MS = 60_000;

/** [{ ch, start, end, title, episode, mode: "remind" | "tune" }] */
const list = () => (Array.isArray(pref("reminders")) ? pref("reminders") : []);
const save = (l) => setPref("reminders", l.length ? l : null);
const same = (r, chId, start) => r.ch === chId && r.start === start;

/** "remind", "tune" or null for one program. */
export function reminderFor(chId, start) {
  return list().find((r) => same(r, chId, start))?.mode ?? null;
}

/** Set (mode "remind" or "tune") or clear (null) the reminder for a program in the guide. */
export function setReminder(ch, a, mode) {
  const rest = list().filter((r) => !same(r, ch.id, a.start));
  if (mode) rest.push({ ch: ch.id, start: a.start, end: a.end, title: a.title, episode: a.episode ?? null, mode });
  save(rest.sort((x, y) => x.start - y.start));
}

/** None, then Remind me, then Tune me, then none again (the guide's R key). Says what it did. */
export function cycleReminder(ch, a) {
  const cur = reminderFor(ch.id, a.start);
  const nextMode = cur === null ? "remind" : cur === "remind" ? "tune" : null;
  setReminder(ch, a, nextMode);
  sayReminder(ch, a, nextMode);
  return nextMode;
}

/** A toast saying what a program's reminder now does. */
export function sayReminder(ch, a, mode) {
  toast(mode === "remind" ? `You'll get a reminder when ${a.title} starts at ${fmtTime(a.start)}.`
    : mode === "tune" ? `At ${fmtTime(a.start)} the set tunes to ${ch.name} for ${a.title}.`
    : `No reminder for ${a.title}.`);
}

// ------------------------------------------------------------------ at start time

const el = Object.assign(document.createElement("div"), { id: "remind", className: "remind", hidden: true });
el.setAttribute("role", "alert");
document.body.append(el);
let hideTimer = 0;
let showing = null; // the reminder on the notice

function fire() {
  const t = now();
  const due = list().filter((r) => r.start <= t);
  if (!due.length) return;
  save(list().filter((r) => r.start > t));
  // One that came due while the page was closed still counts if the program is on.
  const live = due.filter((r) => r.end > t && tv.channels.some((c) => c.id === r.ch));
  // Nobody is watching after a sign-off, so nothing wakes the set.
  if (!live.length || signedOff()) return;
  const r = live.find((x) => x.mode === "tune") ?? live.at(-1);
  if (r.mode === "tune") return tuneTo(r, true);
  notice(r);
}
setInterval(fire, 1000);

function tuneTo(r, auto = false) {
  const ch = tv.channels.find((c) => c.id === r.ch);
  if (!ch) return;
  if (guideOpen()) closeGuide();
  hideNotice();
  if (auto) toast(`${r.title} is starting. Tuned to ${ch.number} ${ch.name}.`);
  // A tune always goes back to live, so it also leaves On Demand or a time shift.
  if (tv.current?.id !== ch.id || tv.onDemand) tune(ch);
  else if (timeShift()) backToLive();
}

function notice(r) {
  const ch = tv.channels.find((c) => c.id === r.ch);
  if (!ch) return;
  showing = r;
  const late = now() - r.start > 60_000;
  el.innerHTML = html`<div class="rm-when">${late ? `Started at ${fmtTime(r.start)}` : "Starting now"} on <b>${ch.number}</b> ${ch.name}</div>
    <div class="rm-t">${r.title}</div>${r.episode ? html`<div class="rm-s">${r.episode}</div>` : ""}
    <div class="rm-act"><button class="rm-btn main" data-rm="watch">Watch now</button><button class="rm-btn" data-rm="dismiss">Dismiss</button></div>`.html;
  el.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideNotice, NOTICE_MS);
}

function hideNotice() {
  clearTimeout(hideTimer);
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.hidden = true;
  showing = null;
}

el.addEventListener("click", (e) => {
  const act = e.target.closest("[data-rm]")?.dataset.rm;
  if (!act) return;
  e.stopPropagation();
  if (act === "watch" && showing) tuneTo(showing);
  else hideNotice();
});
el.addEventListener("pointerup", (e) => e.stopPropagation());

// OK watches, Back dismisses, while the notice is up over the picture.
addEventListener("keydown", (e) => {
  if (el.hidden || guideOpen() || panelOpen() || activeLayer() || e.ctrlKey || e.metaKey || e.altKey) return;
  const focus = document.activeElement;
  if (focus && focus !== document.body && !el.contains(focus)) return;
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (el.contains(focus) && focus.dataset.rm === "dismiss") hideNotice();
    else if (showing) tuneTo(showing);
  } else if (e.key === "Escape" || e.key === "Backspace") {
    e.preventDefault();
    e.stopImmediatePropagation();
    hideNotice();
  }
}, true);
