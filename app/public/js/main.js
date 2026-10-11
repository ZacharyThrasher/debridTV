// DebridTV front end: wires the remote (keyboard, mouse, touch) to the tuner,
// guide and settings, and keeps the clock ticking.

import "./spatial.js"; // first, so the remote's keys reach it before any other handler
import { api, whereAmI } from "./api.js";
import { html, raw, pref, setPref, applyPrefs, syncClock, toast } from "./util.js";
import { tv, tune, channelStep, lastChannel, byNumber, togglePause, applyVolume } from "./player.js";
import * as player from "./player.js"; // applyAspect comes from workstream A
import { openGuide, closeGuide, guideOpen, guideKey } from "./guide.js";
import { initPanel, openPanel, closePanel, panelOpen } from "./panel.js";
import { toggleBanner, tickBanner, osd, liveAiring } from "./ui.js";
import { tickCard, pinPromptOpen, pinKey } from "./cards.js";
import { unlockAudio } from "./static.js";
import { editorOpen, exclusionsOpen } from "./channel-editor.js";
import { themeEditorOpen } from "./theme.js";
import { openOnDemand, onDemandOpen, watchFilm } from "./ondemand.js";
import { groupsOpen } from "./groups.js";
import "./bezel.js";

applyPrefs();
// A paired phone or TV can't change sources or the PIN; those controls hide (html[data-where="device"]).
whereAmI().then((w) => (document.documentElement.dataset.where = w));
applyVolume();
// The demo picture draws text on a canvas, which only uses fonts already loaded.
for (const f of ['800 20px "Barlow Condensed"', "20px VT323", "600 20px Inter"]) document.fonts?.load(f).catch(() => {});

let boot = null;

async function bootstrap({ keepChannel = true } = {}) {
  const sent = Date.now();
  boot = await api.get("/api/bootstrap");
  syncClock(boot.now, sent);
  const before = tv.current?.id;
  const wasDemo = tv.demo;
  tv.channels = boot.channels;
  tv.ffmpeg = boot.ffmpeg;
  tv.demo = boot.demo;
  document.body.classList.toggle("demo", boot.demo);
  if (wasDemo !== undefined && wasDemo !== boot.demo) toast(boot.demo ? "Showing the demo channels." : "Your library is on the air!");
  else if (wasDemo === undefined && boot.waiting) toast(waitingText(boot.waiting));
  let target = keepChannel && before ? tv.channels.find((c) => c.id === before) : null;
  if (!target) {
    let saved = null;
    try {
      saved = localStorage.getItem("debridtv.lastChannel");
    } catch {}
    // Startup choice (N-14): "last" channel (default), "guide", or a fixed "ch:<id>".
    const start = String(pref("startup") ?? "last");
    if (start.startsWith("ch:")) saved = start.slice(3);
    target = tv.channels.find((c) => c.id === saved) ?? tv.channels[0];
  }
  if (!tv.channels.length) return;
  if (!tv.current || tv.current.id !== target.id || wasDemo !== boot.demo) await tune(target);
}

/** Why the demo is still on although a source is connected. */
function waitingText(w) {
  if (w.scanning) return "Your library is connected and being scanned. These are demo channels; yours replace them as soon as the first one is ready.";
  if (w.needed) return "Your library is connected, but its files need a scan before they can air. These are demo channels; start the scan in Settings.";
  return "Your library is connected, but nothing in it can fill a channel yet. These are demo channels.";
}

/** Called after settings change the lineup (connect, scan, hide, new channel). */
async function lineupChanged() {
  await new Promise((r) => setTimeout(r, 400)); // the server debounces rebuilds
  await bootstrap();
}

// ------------------------------------------------------------------ remote

let digits = "";
let digitTimer = 0;

function enterDigit(d) {
  digits = (digits + d).slice(-3);
  osd(digits.padEnd(2, "-"), "", 0);
  clearTimeout(digitTimer);
  const go = () => {
    const ch = byNumber(Number(digits));
    digits = "";
    if (ch) tune(ch);
    else {
      osd("--", "No such channel", 1500);
    }
  };
  // Tune as soon as the number can't grow into another channel.
  const n = Number(digits);
  const longer = tv.channels.some((c) => String(c.number).startsWith(digits) && c.number !== n);
  if (!longer && byNumber(n)) return go();
  digitTimer = setTimeout(go, 1200);
}

addEventListener("keydown", (e) => {
  unlockAudio();
  if (pref("muted") === false && document.getElementById("video").muted && tv.route !== "demo") applyVolume();
  if (e.target.matches?.("input, textarea, select")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || editorOpen() || exclusionsOpen() || themeEditorOpen() || onDemandOpen() || groupsOpen()) return;
  const k = e.key;
  if (!document.getElementById("welcome").hidden) {
    if (k === "Enter" || k === "Escape" || k === " ") closeWelcome();
    e.preventDefault();
    return;
  }
  if (panelOpen()) {
    if (k === "Escape" || k === "s" || k === "S") closePanel();
    return;
  }
  if (guideOpen()) {
    if (k === "Escape" || k === "g" || k === "G" || k === "Backspace") closeGuide();
    else if (k === "s" || k === "S") {
      closeGuide();
      openPanel();
    } else if (k === "o" || k === "O") {
      closeGuide();
      openOnDemand();
    } else if (!guideKey(e)) return;
    e.preventDefault();
    return;
  }
  // A locked channel's PIN pad takes digits, Backspace and Enter; channel keys still work.
  if (pinPromptOpen() && pinKey(k)) return void e.preventDefault();
  // A meanwhile chip on an off-air card has focus: Left/Right move between chips, OK tunes.
  if (chipKey(e)) return void e.preventDefault();
  // Watching from On Demand: Left/Right skip, Back returns to the live channel.
  if (tv.onDemand && onDemandKey(k)) return void e.preventDefault();
  switch (k) {
    case "ArrowUp": case "PageUp": case "+": case "=": case "ChannelUp": channelStep(1); break;
    case "ArrowDown": case "PageDown": case "-": case "_": case "ChannelDown": channelStep(-1); break;
    case "g": case "G": case "Enter": case "Guide": openGuide(); break;
    case "s": case "S": case "ContextMenu": case "Settings": openPanel(); break;
    case "o": case "O": case "MediaTopMenu": case "VOD": openOnDemand(); break;
    case "i": case "I": case "Info": toggleBanner(); break;
    case "w": case "W": if (!watchFilm(liveAiring())) return; break; // a trailer's film, when it's in the library
    case "ArrowRight": case "ArrowLeft": if (!focusChips(k)) toggleBanner(); break;
    case "Backspace": case "l": case "L": case "LastChannel": lastChannel(); break;
    case " ": case "k": case "K": case "MediaPlayPause": case "MediaPlay": case "MediaPause": case "Pause": case "Play": togglePause(); break;
    case "m": case "M": toggleMute(); break;
    case "f": case "F": toggleFull(); break;
    case "z": case "Z": cycleAspect(); break;
    case "a": case "A": player.cycleAudio?.(); break; // audio track (workstream A shows the OSD)
    case "c": case "C": player.cycleCaptions?.(); break; // captions
    case "?": showWelcome(); break;
    default:
      if (/^[0-9]$/.test(k)) enterDigit(k);
      else return;
  }
  e.preventDefault();
});

// The "Meanwhile, on now" chips on an unavailable or off-air card are buttons; a remote
// reaches them with Left/Right (which otherwise show the banner) and presses OK to tune.
const chips = () => [...document.querySelectorAll("#card:not([hidden]) .chip[data-ch]")];
function focusChips(k) {
  const list = chips();
  if (!list.length) return false;
  (k === "ArrowLeft" ? list.at(-1) : list[0]).focus({ focusVisible: true });
  return true;
}
function chipKey(e) {
  const list = chips();
  const i = list.indexOf(document.activeElement);
  if (i < 0) return false;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const j = i + (e.key === "ArrowRight" ? 1 : -1);
    if (j < 0 || j >= list.length) document.activeElement.blur();
    else list[j].focus({ focusVisible: true });
    return true;
  }
  if (e.key === "Enter") {
    document.activeElement.click();
    return true;
  }
  if (e.key === "Escape" || e.key === "Backspace") {
    document.activeElement.blur();
    return true;
  }
  return false;
}

function onDemandKey(k) {
  if (k === "ArrowLeft" || k === "ArrowRight" || k === "MediaRewind" || k === "MediaFastForward") {
    const d = k === "ArrowLeft" || k === "MediaRewind" ? -10_000 : 30_000;
    if (typeof player.seekBy !== "function") return false;
    player.seekBy(d);
    osd(d < 0 ? "◀◀ 10 s" : "30 s ▶▶", "", 900);
    return true;
  }
  if (k === "Escape" || k === "Backspace" || k === "l" || k === "L" || k === "LastChannel") {
    player.backToLive?.();
    return true;
  }
  return false;
}

function toggleMute() {
  setPref("muted", !pref("muted"));
  applyVolume();
  osd(pref("muted") ? "MUTE" : `VOL ${Math.round(pref("volume") * 100)}`, "", 1500);
  document.querySelector('[data-act="mute"]').textContent = pref("muted") ? "🔇" : "🔊";
}

// Picture shape (parity N-12): Z cycles; player.js applies it to the video.
const ASPECTS = { auto: "Normal", fill: "Stretch", "4:3": "4:3", zoom: "Zoom" };
function cycleAspect() {
  const keys = Object.keys(ASPECTS);
  const next = keys[(keys.indexOf(pref("aspect") ?? "auto") + 1) % keys.length];
  setPref("aspect", next);
  player.applyAspect?.();
  osd(ASPECTS[next].toUpperCase(), "Picture", 1500);
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

// Mouse and touch: show the dock while the pointer moves, hide it when it rests.
let pointerTimer = 0;
addEventListener("pointermove", () => {
  document.body.classList.add("pointer");
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove("pointer"), 2600);
});
addEventListener("pointerdown", () => {
  unlockAudio();
  applyVolume();
});
document.getElementById("dock").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  ({ up: () => channelStep(1), down: () => channelStep(-1), guide: openGuide, ondemand: () => openOnDemand(), settings: () => openPanel(), mute: toggleMute, full: toggleFull })[act]?.();
});
document.getElementById("stage").addEventListener("click", (e) => {
  if (e.target.closest("#card, #video, #synth, #crt, #static")) toggleBanner();
});
let touchY = null;
addEventListener("touchstart", (e) => (touchY = e.touches[0].clientY), { passive: true });
addEventListener("touchend", (e) => {
  if (touchY == null || guideOpen() || panelOpen()) return;
  const dy = e.changedTouches[0].clientY - touchY;
  if (Math.abs(dy) > 60) channelStep(dy < 0 ? 1 : -1);
  touchY = null;
});

// ------------------------------------------------------------------ welcome

function showWelcome() {
  const el = document.getElementById("welcome");
  const demo = boot?.demo;
  el.innerHTML = html`<div class="welcome-card">
    <div class="brand" style="justify-content:center"><span class="brand-mark"></span>DebridTV</div>
    <h1>Your library,<br><span>always on the air.</span></h1>
    <p>Channels play around the clock, like cable. Flip around, check the guide, and drop into whatever's on.
      ${demo ? (boot.waiting ? waitingText(boot.waiting) : "You're watching demo channels with made-up shows. Connect TorBox, Real-Debrid or a folder in Settings to put your own library on the air.") : ""}</p>
    <div class="keys tv-only">
      <div><span class="kk"><kbd>▲</kbd><kbd>▼</kbd></span><span>change channel</span></div>
      <div><span class="kk"><kbd>OK</kbd></span><span>program guide</span></div>
      <div><span class="kk"><kbd>0-9</kbd></span><span>go to a number</span></div>
      <div><span class="kk"><kbd>◀</kbd><kbd>▶</kbd></span><span>what's on</span></div>
      <div><span class="kk"><kbd>Back</kbd></span><span>last channel</span></div>
      <div><span class="kk"><kbd>▲</kbd></span><span>in the guide: On Demand, settings</span></div>
    </div>
    <div class="keys kb-only">
      <div><span class="kk"><kbd>↑</kbd><kbd>↓</kbd></span><span>change channel</span></div>
      <div><span class="kk"><kbd>G</kbd></span><span>program guide</span></div>
      <div><span class="kk"><kbd>0-9</kbd></span><span>go to a number</span></div>
      <div><span class="kk"><kbd>I</kbd></span><span>what's on</span></div>
      <div><span class="kk"><kbd>L</kbd></span><span>last channel</span></div>
      <div><span class="kk"><kbd>O</kbd></span><span>On Demand</span></div>
      <div><span class="kk"><kbd>Space</kbd></span><span>pause</span></div>
      <div><span class="kk"><kbd>M</kbd></span><span>mute</span></div>
      <div><span class="kk"><kbd>F</kbd></span><span>full screen</span></div>
      ${typeof player.applyAspect === "function" ? raw('<div><span class="kk"><kbd>Z</kbd></span><span>picture shape</span></div>') : ""}
      ${typeof player.cycleAudio === "function" ? raw('<div><span class="kk"><kbd>A</kbd></span><span>audio track</span></div>') : ""}
      ${typeof player.cycleCaptions === "function" ? raw('<div><span class="kk"><kbd>C</kbd></span><span>captions</span></div>') : ""}
      <div><span class="kk"><kbd>S</kbd></span><span>settings</span></div>
    </div>
    <button class="btn primary" data-start>Start watching</button>
    ${demo ? html`<button class="btn" data-sources style="margin-left:.5em">${boot.waiting ? "See scan progress" : "Connect my library"}</button>` : ""}
  </div>`;
  el.hidden = false;
  el.querySelector("[data-start]").focus();
  el.querySelector("[data-start]").onclick = closeWelcome;
  const s = el.querySelector("[data-sources]");
  if (s) s.onclick = () => {
    closeWelcome();
    openPanel("sources");
  };
}

function closeWelcome() {
  document.getElementById("welcome").hidden = true;
  setPref("welcomed", true);
  unlockAudio();
  applyVolume();
}

// ------------------------------------------------------------------ start

initPanel(lineupChanged);
setInterval(() => {
  tickCard();
  tickBanner();
}, 1000);
// Pick up lineup changes made elsewhere (a scan finishing adds channels).
setInterval(() => !panelOpen() && !guideOpen() && api.get("/api/bootstrap").then((b) => {
  const sig = (x) => x.channels.map((c) => c.id + c.number).join() + x.demo;
  if (boot && sig(b) !== sig(boot)) bootstrap();
}).catch(() => {}), 60_000);

bootstrap()
  .then(() => pref("startup") === "guide" && pref("welcomed") && !guideOpen() && openGuide())
  .catch((e) => toast(`Couldn't start: ${e.message}`, 8000));
if (!pref("welcomed")) showWelcome();
