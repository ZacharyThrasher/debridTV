// Auto sign-off (parity N-17b). A viewer who falls asleep shouldn't stream all
// night: after `signOffHours` without a key, click or touch (default 4, 0 = never)
// the station asks "Still watching?" for a minute, then signs off. Signing off
// drops every stream, so nothing more is fetched from a provider until the viewer
// comes back. Any key or click puts the station back on the air, live.

import { pref, fmtTime, now } from "./util.js";

const DEFAULT_HOURS = 4;
const ACTIVITY = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];

let hooks = null; // { stop(), resume() } from the player
let lastActivity = performance.now();
let state = "on"; // "on" | "asking" | "off"
let promptAt = 0;
let timer = 0;
let el = null;

/** Hours of no input before asking; 0 or a bad value turns sign-off off. */
export function signOffMs() {
  const h = Number(pref("signOffHours") ?? DEFAULT_HOURS);
  return Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0;
}

/** How long the prompt waits for an answer (60 s; tests shorten it). */
const promptMs = () => (Number(pref("signOffPromptSec")) || 60) * 1000;

export const signedOff = () => state === "off";

export function initSignOff(h) {
  hooks = h;
  // Capture phase, so the key that answers the prompt doesn't also change the channel.
  for (const type of ACTIVITY) addEventListener(type, onActivity, { capture: true, passive: type !== "keydown" && type !== "pointerdown" });
  schedule();
}

function onActivity(e) {
  lastActivity = performance.now();
  if (state === "on") return;
  // A drifting mouse shouldn't wake a station that has signed off; a key or click does.
  if (state === "off" && (e.type === "pointermove" || e.type === "wheel")) return;
  if (e.cancelable && (e.type === "keydown" || e.type === "pointerdown")) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  const wasOff = state === "off";
  state = "on";
  hide();
  if (wasOff) hooks?.resume();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const limit = signOffMs();
  if (!limit || state !== "on") return;
  const due = lastActivity + limit - performance.now();
  timer = setTimeout(() => {
    if (state !== "on") return;
    // Activity since the timer was set just moves the deadline.
    if (performance.now() - lastActivity < signOffMs() - 50) return schedule();
    ask();
  }, Math.max(1000, Math.min(due, 2 ** 31 - 1)));
}

function ask() {
  state = "asking";
  promptAt = performance.now();
  render();
  const tick = () => {
    if (state !== "asking") return;
    const left = promptMs() - (performance.now() - promptAt);
    if (left <= 0) return signOff();
    const c = el?.querySelector("[data-left]");
    if (c) c.textContent = String(Math.ceil(left / 1000));
    el?.querySelector(".so-num")?.style.setProperty("--p", String(left / promptMs()));
    timer = setTimeout(tick, 250);
  };
  tick();
}

function signOff() {
  state = "off";
  hooks?.stop();
  render();
}

// ------------------------------------------------------------------ view

const css = `
#signoff { position: fixed; inset: 0; z-index: 60; pointer-events: none; font-family: var(--body); color: var(--ink); }
#signoff .so-ask { pointer-events: auto; position: absolute; left: 50%; bottom: calc(var(--u)*5); transform: translateX(-50%);
  width: min(92vw, calc(var(--u)*34)); padding: calc(var(--u)*1.4) calc(var(--u)*1.8); border-radius: var(--radius);
  background: var(--panel); border: 1px solid var(--line-strong); box-shadow: 0 calc(var(--u)*1) calc(var(--u)*3) rgba(0,0,0,.55);
  display: grid; grid-template-columns: auto 1fr; gap: calc(var(--u)*.4) calc(var(--u)*1.4); align-items: center; animation: so-rise .5s var(--ease); }
#signoff .so-num { position: relative; grid-row: span 3; width: calc(var(--u)*4.6); aspect-ratio: 1; display: grid; place-items: center;
  font-family: var(--mono); font-size: calc(var(--u)*2.2); color: var(--amber); }
#signoff .so-num::before { content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(var(--amber) calc(var(--p, 1) * 360deg), var(--line) 0);
  -webkit-mask: radial-gradient(circle, transparent 60%, #000 62%); mask: radial-gradient(circle, transparent 60%, #000 62%); }
#signoff .so-kicker { font-family: var(--display); text-transform: uppercase; letter-spacing: .14em; font-size: calc(var(--u)*.9); color: var(--dim); }
#signoff .so-title { font-family: var(--display); font-weight: 800; font-size: calc(var(--u)*2.1); line-height: 1; }
#signoff .so-why { font-size: calc(var(--u)*.95); color: var(--dim); }
#signoff .so-off { pointer-events: auto; position: absolute; inset: 0; display: grid; grid-template-rows: 2fr .3fr 1fr; background: #000; cursor: pointer; animation: so-fade 1.2s ease; }
#signoff .so-bars { display: grid; grid-template-columns: repeat(7, 1fr); filter: saturate(.7) brightness(.55); }
#signoff .so-bars i:nth-child(1) { background: #c0c0c0; } #signoff .so-bars i:nth-child(2) { background: #c0c000; }
#signoff .so-bars i:nth-child(3) { background: #00c0c0; } #signoff .so-bars i:nth-child(4) { background: #00c000; }
#signoff .so-bars i:nth-child(5) { background: #c000c0; } #signoff .so-bars i:nth-child(6) { background: #c00000; }
#signoff .so-bars i:nth-child(7) { background: #0000c0; }
#signoff .so-mid { display: grid; grid-template-columns: repeat(7, 1fr); filter: brightness(.55); }
#signoff .so-mid i:nth-child(odd) { background: #111; } #signoff .so-mid i:nth-child(1) { background: #0000c0; }
#signoff .so-mid i:nth-child(3) { background: #c000c0; } #signoff .so-mid i:nth-child(5) { background: #00c0c0; } #signoff .so-mid i:nth-child(7) { background: #c0c0c0; }
#signoff .so-msg { background: #050505; display: grid; place-content: center; text-align: center; gap: calc(var(--u)*.5); padding: calc(var(--u)*1); }
#signoff .so-msg .so-title { font-size: calc(var(--u)*3); color: #fff; }
#signoff .so-msg .so-why { color: rgba(255,255,255,.7); font-size: calc(var(--u)*1.1); }
#signoff .so-msg .so-kicker { color: rgba(255,255,255,.55); }
#signoff .so-key { display: inline-block; margin-top: calc(var(--u)*.6); font-family: var(--mono); font-size: calc(var(--u)*1.4); color: var(--osd); animation: so-blink 1.6s steps(2, start) infinite; }
@keyframes so-rise { from { opacity: 0; transform: translate(-50%, calc(var(--u)*1.5)); } }
@keyframes so-fade { from { opacity: 0; } }
@keyframes so-blink { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { #signoff * { animation: none !important; } }
`;

function mount() {
  if (el) return el;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  el = document.createElement("div");
  el.id = "signoff";
  el.hidden = true;
  document.body.append(el);
  return el;
}

function render() {
  mount();
  el.hidden = false;
  if (state === "asking") {
    const hours = Math.round((signOffMs() / 3_600_000) * 10) / 10;
    el.innerHTML = `<div class="so-ask" role="alertdialog" aria-live="assertive" aria-labelledby="so-t" aria-describedby="so-d">
      <div class="so-num"><span data-left>${Math.round(promptMs() / 1000)}</span></div>
      <div class="so-kicker">Still there?</div>
      <div class="so-title" id="so-t">Are you still watching?</div>
      <div class="so-why" id="so-d">No buttons pressed in ${hours} ${hours === 1 ? "hour" : "hours"}. Press any key to keep watching, or the station signs off to stop streaming.</div>
    </div>`;
  } else if (state === "off") {
    el.innerHTML = `<div class="so-off" role="dialog" aria-live="polite" aria-labelledby="so-t">
      <div class="so-bars">${"<i></i>".repeat(7)}</div>
      <div class="so-mid">${"<i></i>".repeat(7)}</div>
      <div class="so-msg">
        <div class="so-kicker">Signed off at ${fmtTime(now())}</div>
        <div class="so-title" id="so-t">DebridTV has signed off</div>
        <div class="so-why">Nothing is streaming, so no data is used while you're away.</div>
        <div class="so-key">Press any key to come back on the air</div>
      </div>
    </div>`;
  }
}

function hide() {
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
}
