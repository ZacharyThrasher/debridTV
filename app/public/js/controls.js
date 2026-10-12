// The control bar (docs/parity/player.md): a YouTube-style strip along the bottom of
// the picture with a scrubber, transport, volume, time, captions, a settings menu,
// picture-in-picture and full screen. It appears when the pointer moves, a key
// reaches it, or the picture is paused, and fades after a few quiet seconds.
//
// The bar reads player.timeline() and calls player.seekTo/seekBy/backToLive; it never
// fetches media itself (only /api/item for chapter marks, a local call).
//
// Remote: Down while the bar shows (or Left/Right on a live channel) puts focus on
// it; Left/Right move along it, OK presses, Up or Back leaves. Touch: tap shows it,
// double-tap the left or right third skips.

import { api } from "./api.js";
import { html, raw, pref, setPref, clamp, fmtClock, toast } from "./util.js";
import * as player from "./player.js";
import { tv, togglePause, channelStep } from "./player.js";
import { openGuide, guideOpen } from "./guide.js";
import { openPanel, panelOpen } from "./panel.js";
import { openOnDemand, onDemandOpen } from "./ondemand.js";
import { osd } from "./ui.js";
import { move } from "./spatial.js";
import * as fx from "./avfx.js";

const video = document.getElementById("video");
const stage = document.getElementById("stage");

// The captions sheet comes from the "Easy subtitle controls" work (captions.js);
// until it is here the CC button cycles tracks with the C key's code.
let captionsMod = null;
import("./captions.js").then((m) => (captionsMod = m), () => {});

// ------------------------------------------------------------------ icons

const P = {
  play: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  back: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  fwd: "M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z",
  volHi: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  volLo: "M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z",
  volOff: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
  full: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  unfull: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  pip: "M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z",
  cc: "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z",
  guide: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
  od: "M4 6H2v14a2 2 0 0 0 2 2h14v-2H4V6zm16-4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-8 12.5v-9l6 4.5-6 4.5z",
  tune: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
  up: "M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  down: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  next: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  prev: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
};
const icon = (d, extra = "") => raw(`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/>${extra}</svg>`);
const num = (n) => `<text x="12" y="16.2" text-anchor="middle" font-size="6.6" font-weight="700" font-family="Inter, system-ui, sans-serif">${n}</text>`;

// ------------------------------------------------------------------ markup

const bar = document.createElement("div");
bar.id = "pbar";
bar.className = "pbar";
bar.setAttribute("role", "toolbar");
bar.setAttribute("aria-label", "Player controls");
bar.innerHTML = html`
  <div class="pb-scrub" tabindex="0" role="slider" aria-label="Seek" aria-valuemin="0">
    <div class="pb-rail"><i class="pb-buf"></i><i class="pb-fill"></i><i class="pb-ab"></i><span class="pb-chaps"></span><i class="pb-livemark"></i></div>
    <i class="pb-knob"></i>
    <div class="pb-tip" hidden><b></b><span></span></div>
  </div>
  <div class="pb-row">
    <div class="pb-left">
      <button class="pb-btn" data-act="play" aria-label="Pause" data-tip="Pause (Space)">${icon(P.pause)}</button>
      <button class="pb-btn pb-seek" data-act="back" aria-label="Back 10 seconds" data-tip="Back 10 s">${icon(P.back, num(10))}</button>
      <button class="pb-btn pb-seek" data-act="fwd" aria-label="Forward 30 seconds" data-tip="Forward 30 s">${icon(P.fwd, num(30))}</button>
      <button class="pb-btn pb-ch" data-act="down" aria-label="Channel down" data-tip="Channel down (↓)">${icon(P.down)}</button>
      <button class="pb-btn pb-ch" data-act="up" aria-label="Channel up" data-tip="Channel up (↑)">${icon(P.up)}</button>
      <div class="pb-vol">
        <button class="pb-btn" data-act="mute" aria-label="Mute" data-tip="Mute (M)">${icon(P.volHi)}</button>
        <input class="pb-volr" type="range" min="0" max="200" step="5" aria-label="Volume" />
      </div>
      <button class="pb-time" data-act="time" aria-label="Elapsed time; press for time left"><span class="pb-now">0:00</span><span class="pb-dur"></span></button>
      <button class="pb-live" data-act="live" aria-label="Live">LIVE</button>
      <div class="pb-title"></div>
    </div>
    <div class="pb-right">
      <button class="pb-btn pb-text" data-act="guide" aria-label="Guide" data-tip="Guide (G)">${icon(P.guide)}<b>Guide</b></button>
      <button class="pb-btn pb-text" data-act="ondemand" aria-label="On Demand" data-tip="On Demand (O)">${icon(P.od)}<b>On Demand</b></button>
      <button class="pb-btn" data-act="captions" aria-label="Subtitles" data-tip="Subtitles (C)">${icon(P.cc)}</button>
      <button class="pb-btn" data-act="menu" aria-label="Player settings" aria-haspopup="menu" data-tip="Player settings">${icon(P.gear)}</button>
      <button class="pb-btn" data-act="settings" aria-label="DebridTV settings" data-tip="DebridTV settings (S)">${icon(P.tune)}</button>
      <button class="pb-btn" data-act="pip" aria-label="Picture in picture" data-tip="Picture in picture (P)">${icon(P.pip)}</button>
      <button class="pb-btn" data-act="full" aria-label="Full screen" data-tip="Full screen (F)">${icon(P.full)}</button>
    </div>
  </div>
  <div class="pb-menu" role="menu" aria-label="Player settings" hidden></div>
  <input class="pb-file" type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden />`.html;
const dock = document.getElementById("dock");
if (dock) dock.replaceWith(bar);
else document.body.append(bar);

const $ = (s) => bar.querySelector(s);
const scrub = $(".pb-scrub"), fill = $(".pb-fill"), buf = $(".pb-buf"), knob = $(".pb-knob"), tip = $(".pb-tip"), chapsEl = $(".pb-chaps");
const liveMark = $(".pb-livemark"), abEl = $(".pb-ab");
const menu = $(".pb-menu"), volr = $(".pb-volr"), fileInput = $(".pb-file");

// A hint bubble over the hovered or focused button, like YouTube's.
const hint = Object.assign(document.createElement("div"), { className: "pb-hint", hidden: true });
bar.append(hint);
bar.addEventListener("pointerover", (e) => showHint(e.target.closest("[data-tip]")));
bar.addEventListener("pointerout", () => (hint.hidden = true));
bar.addEventListener("focusin", (e) => showHint(e.target.closest("[data-tip]")));
bar.addEventListener("focusout", () => (hint.hidden = true));
function showHint(el) {
  if (!el || !menu.hidden) return void (hint.hidden = true);
  hint.textContent = el.dataset.tip;
  hint.hidden = false;
  const r = el.getBoundingClientRect(), b = bar.getBoundingClientRect();
  const w = hint.offsetWidth;
  hint.style.left = `${clamp(r.left + r.width / 2 - b.left - w / 2, 8, b.width - w - 8)}px`;
  hint.style.top = `${r.top - b.top - hint.offsetHeight - 10}px`;
}

// ------------------------------------------------------------------ showing and hiding

let hideTimer = 0;
let shownBy = null; // "pointer" | "key" | null
let hovering = false;
const blocked = () => guideOpen() || panelOpen() || onDemandOpen() || !document.getElementById("welcome").hidden;

export const barShown = () => document.body.classList.contains("pbar-on");

export function showBar(by = "pointer", ms = 3000) {
  if (blocked()) return;
  shownBy = by;
  document.body.classList.add("pbar-on");
  draw();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(maybeHide, ms);
}
function maybeHide() {
  clearTimeout(hideTimer);
  // Stay while paused, while a menu or the pointer is on it, or while the remote is on it.
  if (!menu.hidden || hovering || dragging || bar.contains(document.activeElement)) return void (hideTimer = setTimeout(maybeHide, 1500));
  if (tv.paused && !blocked()) return void (hideTimer = setTimeout(maybeHide, 1500));
  hideBar();
}
export function hideBar() {
  clearTimeout(hideTimer);
  closeMenu();
  if (bar.contains(document.activeElement)) document.activeElement.blur();
  document.body.classList.remove("pbar-on");
  shownBy = null;
}
bar.addEventListener("pointerenter", () => (hovering = true));
bar.addEventListener("pointerleave", () => (hovering = false));
addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  showBar("pointer");
});
// Anything that opens over the picture takes the bar away.
new MutationObserver(() => blocked() && barShown() && hideBar()).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// ------------------------------------------------------------------ drawing

let chapters = { id: null, list: [] };
let showLeft = false; // time display: elapsed (default) or time left
let lastId = null;

async function loadChapters(id) {
  chapters = { id, list: [] };
  chapsEl.innerHTML = "";
  if (!id) return;
  try {
    const it = await api.get(`/api/item?id=${encodeURIComponent(id)}`);
    if (chapters.id !== id) return;
    chapters.list = (it.chaptersMs ?? []).filter((c) => c > 0);
  } catch {}
}

/** The chapter a file time falls in: { n, of, start } or null. */
export function chapterAt(ms) {
  const l = chapters.list;
  if (!l.length) return null;
  let n = 0;
  while (n < l.length && l[n] <= ms) n++;
  return { n: n + 1, of: l.length + 1, start: n ? l[n - 1] : 0 };
}

const pct = (ms, d) => `${(clamp(ms / d, 0, 1) * 100).toFixed(3)}%`;

function draw() {
  if (!barShown()) return;
  const t = player.timeline?.();
  bar.dataset.mode = t?.mode ?? "none";
  const seekable = !!t && t.durMs > 0;
  bar.classList.toggle("can-seek", seekable);
  bar.classList.toggle("is-paused", !!tv.paused);
  const play = $('[data-act="play"]');
  play.innerHTML = icon(tv.paused ? P.play : P.pause).html;
  play.setAttribute("aria-label", tv.paused ? "Play" : "Pause");
  play.dataset.tip = tv.paused ? (t?.mode === "live" ? "Play from live (Space)" : "Play (Space)") : "Pause (Space)";
  const mute = $('[data-act="mute"]');
  const lv = pref("muted") ? 0 : fx.level();
  mute.innerHTML = icon(lv === 0 ? P.volOff : lv < 0.5 ? P.volLo : P.volHi).html;
  mute.classList.toggle("boost", lv > 1);
  if (document.activeElement !== volr) volr.value = String(Math.round(lv * 100));
  volr.style.setProperty("--v", `${(lv / 2) * 100}%`);
  volr.setAttribute("aria-valuetext", `${Math.round(lv * 100)}%${lv > 1 ? " (boosted)" : ""}`);
  const full = $('[data-act="full"]');
  full.innerHTML = icon(document.fullscreenElement ? P.unfull : P.full).html;
  $('[data-act="pip"]').hidden = !document.pictureInPictureEnabled || video.disablePictureInPicture;
  $('[data-act="captions"]').classList.toggle("on", captionsOn());

  const id = t?.itemId ?? null;
  if (id !== lastId) {
    lastId = id;
    loadChapters(id);
  }
  const liveBtn = $('[data-act="live"]');
  const timeEl = $(".pb-time");
  if (!t) {
    fill.style.width = buf.style.width = "0%";
    knob.style.left = "0%";
    liveMark.hidden = true;
    timeEl.hidden = true;
    liveBtn.hidden = true;
    $(".pb-title").textContent = tv.route === "card" ? "" : tv.info?.airing?.title ?? "";
    return;
  }
  const d = t.durMs || Math.max(t.posMs, 1);
  fill.style.width = pct(t.posMs, d);
  knob.style.left = pct(t.posMs, d);
  // Buffered, in file time: the stream's zero is where the file was when it started.
  const zero = t.posMs - video.currentTime * 1000;
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(i));
  buf.style.width = tv.route === "demo" ? "0%" : pct(zero + end * 1000, d);
  if (chapsEl.dataset.id !== `${id}:${chapters.list.length}:${d}`) {
    chapsEl.dataset.id = `${id}:${chapters.list.length}:${d}`;
    chapsEl.innerHTML = chapters.list.filter((c) => c < d).map((c) => `<b style="left:${pct(c, d)}"></b>`).join("");
  }
  const loop = fx.abLoop();
  abEl.hidden = !loop || loop.whole;
  if (loop && !loop.whole) Object.assign(abEl.style, { left: pct(loop.a, d), width: loop.b == null ? "2px" : pct(loop.b - loop.a, d) });
  liveMark.hidden = t.liveMs == null;
  if (t.liveMs != null) liveMark.style.left = pct(t.liveMs, d);
  scrub.setAttribute("aria-valuemax", String(Math.round(d / 1000)));
  scrub.setAttribute("aria-valuenow", String(Math.round(t.posMs / 1000)));
  scrub.setAttribute("aria-valuetext", `${fmtClock(t.posMs)} of ${fmtClock(d)}`);
  timeEl.hidden = false;
  $(".pb-now").textContent = showLeft && t.durMs ? `-${fmtClock(t.durMs - t.posMs)}` : fmtClock(t.posMs);
  $(".pb-dur").textContent = t.durMs ? ` / ${fmtClock(t.durMs)}` : "";
  // At the live point it's a red LIVE label; anywhere else it takes you back.
  const atLive = t.mode === "live" && (t.liveMs == null || Math.abs(t.posMs - t.liveMs) < 4000);
  liveBtn.hidden = !(t.mode === "live" || tv.current);
  liveBtn.classList.toggle("at-live", atLive);
  liveBtn.innerHTML = atLive ? "<i></i>LIVE" : "<i></i>Back to live";
  liveBtn.setAttribute("aria-label", atLive ? "Live" : "Back to live (L)");
  const ch = chapterAt(t.posMs);
  const title = tv.onDemand?.title ?? tv.info?.airing?.title ?? "";
  $(".pb-title").innerHTML = html`<span>${title}</span>${ch ? html`<em>Chapter ${ch.n}</em>` : ""}`.html;
}
setInterval(draw, 250);
for (const ev of ["play", "pause", "volumechange", "loadedmetadata"]) video.addEventListener(ev, draw);
addEventListener("debridtv:ondemand", () => setTimeout(draw, 0));
document.addEventListener("fullscreenchange", draw);

// ------------------------------------------------------------------ seeking

/** Seek to a file time. A live channel can't seek yet, so it opens the program in On Demand there. */
export function seekTo(ms) {
  const t = player.timeline?.();
  if (!t) return false;
  ms = clamp(ms, 0, t.durMs ? t.durMs - 1000 : ms);
  if (t.maxMs > t.minMs) return player.seekTo(ms);
  if (t.mode === "live" && t.durMs && tv.route !== "demo" && player.playOnDemand) {
    // Not the live point any more: play this program from there, off the clock. "Back to live" returns.
    player.playOnDemand(t.itemId, { fromMs: ms, item: { title: tv.info?.airing?.title } });
    return true;
  }
  if (t.mode === "live") toast("This channel is a demo picture: it can't rewind.");
  return false;
}
export function seekRel(deltaMs) {
  const t = player.timeline?.();
  if (!t) return false;
  const ok = seekTo(t.posMs + deltaMs);
  if (ok) osd(deltaMs < 0 ? `◀◀ ${Math.abs(deltaMs) / 1000} s` : `${deltaMs / 1000} s ▶▶`, "", 900);
  showBar("key");
  return ok;
}

let dragging = false;
let dragMs = 0;
function msAt(clientX) {
  const t = player.timeline?.();
  const r = scrub.getBoundingClientRect();
  const d = t?.durMs || 0;
  return d ? clamp((clientX - r.left) / r.width, 0, 1) * d : null;
}
function showTip(clientX, ms) {
  if (ms == null) return void (tip.hidden = true);
  const r = scrub.getBoundingClientRect();
  const t = player.timeline?.();
  const ch = chapterAt(ms);
  tip.querySelector("b").textContent = fmtClock(ms);
  const ahead = t?.liveMs != null && ms > t.liveMs + 2000;
  tip.querySelector("span").textContent = [ch && `Chapter ${ch.n}`, ahead && "ahead of live"].filter(Boolean).join(" · ");
  tip.hidden = false;
  tip.style.left = `${clamp(clientX - r.left, tip.offsetWidth / 2, r.width - tip.offsetWidth / 2)}px`;
}
scrub.addEventListener("pointermove", (e) => {
  const ms = msAt(e.clientX);
  showTip(e.clientX, ms);
  scrub.style.setProperty("--hover", ms == null ? "0%" : `${((e.clientX - scrub.getBoundingClientRect().left) / scrub.getBoundingClientRect().width) * 100}%`);
  if (dragging && ms != null) {
    dragMs = ms;
    const d = player.timeline?.()?.durMs || 1;
    fill.style.width = knob.style.left = pct(ms, d);
  }
});
scrub.addEventListener("pointerleave", () => !dragging && (tip.hidden = true));
scrub.addEventListener("pointerdown", (e) => {
  const ms = msAt(e.clientX);
  if (ms == null) return;
  dragging = true;
  dragMs = ms;
  scrub.setPointerCapture(e.pointerId);
  scrub.classList.add("dragging");
  const d = player.timeline?.()?.durMs || 1;
  fill.style.width = knob.style.left = pct(ms, d);
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  scrub.classList.remove("dragging");
  tip.hidden = true;
  if (e.type === "pointerup") seekTo(dragMs);
};
scrub.addEventListener("pointerup", endDrag);
scrub.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------ actions

function captionsOn() {
  try {
    if (captionsMod?.captionsState) return !!captionsMod.captionsState().on;
  } catch {}
  return [...video.textTracks].some((t) => t.mode === "showing" && (t.cues?.length ?? 0) > 0);
}
function openCaptions() {
  if (captionsMod?.openCaptions) return captionsMod.openCaptions();
  player.cycleCaptions?.();
}

export function toggleMute() {
  setPref("muted", !pref("muted"));
  fx.applySound();
  osd(pref("muted") ? "MUTE" : `VOL ${Math.round(fx.level() * 100)}`, "", 1500);
  draw();
}
export function volumeBy(step) {
  fx.setLevel((pref("muted") ? 0 : fx.level()) + step);
  osd(`VOL ${Math.round(fx.level() * 100)}`, fx.level() > 1 ? "Boosted" : "", 1200);
  showBar("key");
}
export function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
export async function togglePip() {
  try {
    if (document.pictureInPictureElement) return void (await document.exitPictureInPicture());
    if (!video.videoWidth) return toast("Picture in picture needs a playing program.");
    await video.requestPictureInPicture();
  } catch (e) {
    toast(`Picture in picture isn't available here (${e.message}).`);
  }
}
function playPause() {
  togglePause();
  osd(tv.paused ? "❚❚" : "▶", "", 800);
  draw();
}

const ACTIONS = {
  play: playPause,
  back: () => seekRel(-10_000),
  fwd: () => seekRel(30_000),
  up: () => channelStep(1),
  down: () => channelStep(-1),
  mute: toggleMute,
  time: () => ((showLeft = !showLeft), draw()),
  live: () => {
    const t = player.timeline?.();
    if (t?.mode === "live" && (t.liveMs == null || Math.abs(t.posMs - t.liveMs) < 4000) && !tv.paused) return;
    player.backToLive?.();
  },
  guide: () => (hideBar(), openGuide()),
  ondemand: () => (hideBar(), openOnDemand()),
  settings: () => (hideBar(), openPanel()),
  captions: () => openCaptions(),
  menu: () => (menu.hidden ? openMenu() : closeMenu()),
  pip: togglePip,
  full: toggleFull,
};
bar.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !bar.contains(b)) return;
  e.stopPropagation();
  ACTIONS[b.dataset.act]?.();
  showBar(shownBy ?? "pointer");
});
volr.addEventListener("input", () => {
  fx.setLevel(Number(volr.value) / 100);
  draw();
});

// ------------------------------------------------------------------ settings menu

// Pages: the main list, and one page per setting. Each row is a real button so the
// remote, the keyboard and a screen reader all reach it.
let page = "main";
let openedFrom = null;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];
const SHAPES = { auto: "Normal", fill: "Stretch", "4:3": "4:3", zoom: "Zoom to fill" };
const signed = (ms, unit = "ms") => (ms > 0 ? `+${ms} ${unit}` : `${ms} ${unit}`);

function rows() {
  const t = player.timeline?.();
  const offClock = t && t.mode !== "live";
  const p = fx.picture();
  const pictureChanged = p.zoom !== 1 || p.rotate || p.flip || p.brightness !== 1 || p.contrast !== 1 || p.saturation !== 1;
  const loop = fx.abLoop();
  switch (page) {
    case "main":
      return html`
        ${row("speed", "Playback speed", offClock ? `${player.currentRate?.() ?? 1}×` : "Normal (live)")}
        ${row("audio", "Audio track", "…")}
        ${row("async", "Audio sync", signed(fx.audioDelay()))}
        ${row("subs", "Subtitles", captionsOn() ? "On" : "Off")}
        ${row("ssync", "Subtitle sync", signed(fx.subDelay()))}
        ${row("sound", "Sound", [fx.level() > 1 && `${Math.round(fx.level() * 100)}%`, pref("nightMode") && "Night mode"].filter(Boolean).join(" · ") || "Normal")}
        ${row("picture", "Picture", [SHAPES[pref("aspect") ?? "auto"], pictureChanged && "adjusted"].filter(Boolean).join(" · "))}
        ${row("loop", "Loop", loop ? (loop.whole ? "This program" : loop.b == null ? "A set" : "A–B") : "Off")}
        <div class="pm-sep"></div>
        ${act("shot", "Screenshot", "X")}
        ${act("stats", fx.statsOn() ? "Hide stats" : "Stats for nerds", "D")}
        ${act("keys", "Keyboard shortcuts", "?")}`;
    case "speed":
      return html`${head("Playback speed")}${offClock
        ? SPEEDS.map((s) => pick(`rate:${s}`, s === 1 ? "Normal" : `${s}×`, (player.currentRate?.() ?? 1) === s))
        : html`<p class="pm-note">Live channels play at normal speed so they stay on the schedule. Rewind or open the program in On Demand to change speed.</p>${act("odhere", "Watch this program in On Demand")}`}`;
    case "async":
      return html`${head("Audio sync")}${stepper("ad", fx.audioDelay(), "ms")}
        <p class="pm-note">Plus plays the sound later, minus earlier.${fx.audioDelay() < 0 && !tv.ffmpeg ? " Earlier needs ffmpeg on the PC." : fx.audioDelay() < 0 ? " Earlier restarts the stream on the PC at the same point." : ""}</p>
        ${act("ad:0", "Reset")}`;
    case "ssync":
      return html`${head("Subtitle sync")}${stepper("sd", fx.subDelay(), "ms")}
        <p class="pm-note">Plus shows lines later, minus earlier. Works on text subtitles and files you load.</p>
        ${act("sd:0", "Reset")}`;
    case "subs":
      return html`${head("Subtitles")}
        ${act("ccopen", captionsMod?.openCaptions ? "Subtitle options…" : "Next subtitle track (C)")}
        ${act("loadsubs", "Load a subtitle file (.srt, .vtt)…")}
        ${fx.loadedSubs() ? act("clearsubs", `Remove ${fx.loadedSubs().name}`) : ""}
        ${row("ssync", "Subtitle sync", signed(fx.subDelay()))}`;
    case "sound":
      return html`${head("Sound")}
        ${stepper("vol", Math.round(fx.level() * 100), "%")}
        <p class="pm-note">Above 100% boosts quiet files (up to 200%).</p>
        ${toggle("night", "Night mode", !!pref("nightMode"), "Evens out loud and quiet parts")}
        ${stepper("bass", Number(pref("bassDb")) || 0, "dB", "Bass")}
        ${stepper("treble", Number(pref("trebleDb")) || 0, "dB", "Treble")}`;
    case "picture":
      return html`${head("Picture")}
        <div class="pm-chips">${Object.entries(SHAPES).map(([k, v]) => html`<button class="pm-chip ${(pref("aspect") ?? "auto") === k ? "on" : ""}" data-m="shape:${k}" role="menuitemradio" aria-checked="${(pref("aspect") ?? "auto") === k}">${v}</button>`)}</div>
        ${stepper("zoom", Math.round(p.zoom * 100), "%", "Zoom")}
        ${act("rotate", `Rotate (${p.rotate}°)`)}
        ${toggle("flip", "Mirror", !!p.flip)}
        ${stepper("bri", Math.round(p.brightness * 100), "%", "Brightness")}
        ${stepper("con", Math.round(p.contrast * 100), "%", "Contrast")}
        ${stepper("sat", Math.round(p.saturation * 100), "%", "Colour")}
        ${act("picreset", "Reset picture")}`;
    case "loop":
      return html`${head("Loop")}${t && t.maxMs > t.minMs
        ? html`${act("ab", !loop || loop.whole ? "Set A here" : loop.b == null ? "Set B here" : "Clear A–B loop")}
          ${toggle("loopfile", "Loop this program", !!loop?.whole)}`
        : html`<p class="pm-note">Loops work in On Demand.</p>${act("odhere", "Watch this program in On Demand")}`}`;
    case "audio":
      return html`${head("Audio track")}<div class="pm-tracks"><p class="pm-note">Looking up tracks…</p></div>`;
  }
  return "";
}
const row = (k, label, value) => html`<button class="pm-row" data-m="page:${k}" role="menuitem"><span>${label}</span><em>${value}</em>${icon(P.next)}</button>`;
const act = (k, label, key = "") => html`<button class="pm-row" data-m="${k}" role="menuitem"><span>${label}</span>${key ? html`<kbd>${key}</kbd>` : ""}</button>`;
const head = (label) => html`<button class="pm-head" data-m="page:main" aria-label="Back">${icon(P.prev)}<span>${label}</span></button>`;
const pick = (k, label, on) => html`<button class="pm-row pm-pick ${on ? "on" : ""}" data-m="${k}" role="menuitemradio" aria-checked="${on}">${on ? icon(P.check) : raw("<svg></svg>")}<span>${label}</span></button>`;
const toggle = (k, label, on, note = "") => html`<button class="pm-row pm-toggle ${on ? "on" : ""}" data-m="${k}" role="menuitemcheckbox" aria-checked="${on}"><span>${label}${note ? html`<small>${note}</small>` : ""}</span><i></i></button>`;
const stepper = (k, v, unit, label = "") => html`<div class="pm-step">${label ? html`<span>${label}</span>` : ""}
  <button data-m="${k}:-" aria-label="${label || "Less"} down">−</button><output>${unit === "ms" ? signed(v) : `${v} ${unit}`}</output><button data-m="${k}:+" aria-label="${label || "More"} up">+</button></div>`;

function openMenu(to = "main") {
  openedFrom = document.activeElement;
  page = to;
  menu.hidden = false;
  menu.setAttribute("aria-modal", "true"); // the remote's arrows stay inside it (spatial.js)
  renderMenu(true);
  hint.hidden = true;
  showBar(shownBy ?? "pointer");
}
export function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menu.removeAttribute("aria-modal");
  if (menu.contains(document.activeElement)) (openedFrom && bar.contains(openedFrom) ? openedFrom : $('[data-act="menu"]')).focus({ focusVisible: true });
}
function renderMenu(focusFirst = false, keep = null) {
  menu.innerHTML = String(rows());
  menu.dataset.page = page;
  if (page === "audio") fillAudio();
  const again = keep && menu.querySelector(`[data-m="${CSS.escape(keep)}"]`);
  if (again) again.focus({ focusVisible: true });
  else if (focusFirst && (document.documentElement.classList.contains("remote") || bar.contains(document.activeElement)))
    menu.querySelector("button")?.focus({ focusVisible: true });
}

async function fillAudio() {
  const box = menu.querySelector(".pm-tracks");
  const now = player.playing?.();
  if (!now) return void (box.innerHTML = html`<p class="pm-note">${tv.route === "demo" ? "Demo channels have one track." : "Nothing is playing."}</p>`.html);
  let tracks = [];
  try {
    tracks = (await api.get(`/api/item?id=${encodeURIComponent(now.itemId)}`)).tracks ?? [];
  } catch {}
  if (page !== "audio" || menu.hidden) return;
  const { audioTracks, defaultAudio, trackLabel } = await import("./tracks.js");
  const list = audioTracks(tracks);
  if (!list.length) return void (box.innerHTML = html`<p class="pm-note">This file's tracks aren't known yet.</p>`.html);
  const cur = now.sel?.audio ?? defaultAudio(tracks);
  box.innerHTML = html`${list.map((t) => pick(`atrack:${t.index}`, trackLabel(t), t.index === cur))}
    ${list.length > 1 && !tv.ffmpeg ? html`<p class="pm-note">Other tracks need compatibility mode (install ffmpeg on the PC).</p>` : ""}`.html;
  if (bar.contains(document.activeElement) || document.documentElement.classList.contains("remote")) box.querySelector(".on, button")?.focus({ focusVisible: true });
}

const STEP = { ad: 50, sd: 100, vol: 5, bass: 1, treble: 1, zoom: 5, bri: 5, con: 5, sat: 5 };
menu.addEventListener("click", (e) => {
  const b = e.target.closest("[data-m]");
  if (!b) return;
  e.stopPropagation();
  const m = b.dataset.m;
  const [k, v] = m.split(":");
  const t = player.timeline?.();
  const p = fx.picture();
  const dir = v === "+" ? 1 : v === "-" ? -1 : 0;
  switch (k) {
    case "page":
      page = v;
      return renderMenu(true);
    case "rate":
      if (player.setRate?.(Number(v))) osd(`${v}×`, "Speed", 1000);
      page = "main";
      return renderMenu(true);
    case "odhere":
      closeMenu();
      return void (t && seekTo(t.posMs));
    case "atrack":
      player.pickAudio?.(Number(v));
      page = "main";
      return renderMenu(true);
    case "ad":
      fx.setAudioDelay(dir ? fx.audioDelay() + dir * STEP.ad : 0);
      osd("AUDIO SYNC", signed(fx.audioDelay()), 1200);
      break;
    case "sd":
      fx.setSubDelay(dir ? fx.subDelay() + dir * STEP.sd : 0);
      osd("SUBTITLE SYNC", signed(fx.subDelay()), 1200);
      break;
    case "vol":
      fx.setLevel(fx.level() + (dir * STEP.vol) / 100);
      break;
    case "bass":
    case "treble":
      setPref(`${k}Db`, clamp((Number(pref(`${k}Db`)) || 0) + dir * STEP[k], -12, 12) || null);
      fx.applySound();
      break;
    case "night":
      setPref("nightMode", !pref("nightMode"));
      fx.applySound();
      break;
    case "shape":
      setPref("aspect", v);
      player.applyAspect?.();
      break;
    case "zoom":
      fx.setPicture({ zoom: clamp(p.zoom + (dir * STEP.zoom) / 100, 1, 2) });
      break;
    case "rotate":
      fx.setPicture({ rotate: (p.rotate + 90) % 360 });
      break;
    case "flip":
      fx.setPicture({ flip: !p.flip });
      break;
    case "bri":
    case "con":
    case "sat": {
      const key = { bri: "brightness", con: "contrast", sat: "saturation" }[k];
      fx.setPicture({ [key]: clamp(Math.round((p[key] + (dir * STEP[k]) / 100) * 100) / 100, 0.5, 1.5) });
      break;
    }
    case "picreset":
      fx.setPicture({ ...fx.PICTURE });
      setPref("aspect", "auto");
      player.applyAspect?.();
      break;
    case "ab": {
      const l = fx.abLoop();
      fx.markLoop();
      if (l?.whole) fx.markLoop();
      const n = fx.abLoop();
      osd("LOOP", !n ? "Off" : n.b == null ? `A at ${fmtClock(n.a)}` : `${fmtClock(n.a)} – ${fmtClock(n.b)}`, 1500);
      break;
    }
    case "loopfile":
      fx.setLoopFile(!fx.abLoop()?.whole);
      break;
    case "ccopen":
      closeMenu();
      return openCaptions();
    case "loadsubs":
      return fileInput.click();
    case "clearsubs":
      fx.clearLoaded();
      break;
    case "shot":
      closeMenu();
      return void fx.screenshot();
    case "stats":
      fx.toggleStats();
      break;
    case "keys":
      closeMenu();
      return showKeys();
  }
  renderMenu(false, m);
  draw();
});
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (f && (await fx.loadSubtitleFile(f))) renderMenu(true);
});
addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="menu"]')) closeMenu();
});

// ------------------------------------------------------------------ keyboard shortcuts

const KEYS = [
  ["Watching", [["Space / K", "Pause and play"], ["↑ ↓", "Change channel"], ["0–9", "Go to a channel number"], ["L / Backspace", "Last channel, or back to live"],
    ["G / Enter", "Program guide"], ["O", "On Demand"], ["I", "What's on"], ["S", "DebridTV settings"]]],
  ["Seeking", [["← →", "Back 10 s / forward 30 s (On Demand)"], ["Shift + ← →", "Previous / next chapter"], ["Home / End", "Start / end"],
    [", .", "One frame back / forward (paused)"], ["< > or [ ]", "Slower / faster"]]],
  ["Sound", [["M", "Mute"], ["/ *", "Volume down / up (up to 200%)"], ["Mouse wheel", "Volume, over the picture"], ["A", "Next audio track"]]],
  ["Picture and subtitles", [["C", "Subtitles"], ["Z", "Picture shape"], ["F / double-click", "Full screen"], ["P", "Picture in picture"], ["X", "Screenshot"], ["D", "Stats for nerds"]]],
];
const keysEl = Object.assign(document.createElement("div"), { className: "pkeys", hidden: true });
keysEl.setAttribute("role", "dialog");
keysEl.setAttribute("aria-label", "Keyboard shortcuts");
keysEl.innerHTML = html`<div class="pkeys-card">
  <header><h2>Keyboard shortcuts</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
  <div class="pkeys-cols">${KEYS.map(([h, list]) => html`<section><h3>${h}</h3>${list.map(([k, v]) => html`<div><kbd>${k}</kbd><span>${v}</span></div>`)}</section>`)}</div>
  <p class="tv-only">On a TV remote: press <kbd>Down</kbd> while the controls show to reach them, <kbd>◀ ▶</kbd> to move, <kbd>OK</kbd> to press, <kbd>Back</kbd> to leave.</p>
</div>`.html;
document.body.append(keysEl);
keysEl.addEventListener("click", (e) => (e.target === keysEl || e.target.closest("[data-close]")) && hideKeys());
export function showKeys() {
  hideBar();
  keysEl.hidden = false;
  keysEl.setAttribute("aria-modal", "true");
  keysEl.querySelector("[data-close]").focus({ focusVisible: true });
}
function hideKeys() {
  keysEl.hidden = true;
  keysEl.removeAttribute("aria-modal");
}

// ------------------------------------------------------------------ keys

const typing = (el) => el?.matches?.("input:not([type=range]), textarea, select, [contenteditable=true]");
const otherLayer = () => blocked() || !keysEl.hidden || !!document.querySelector('[aria-modal="true"]:not(.pb-menu)') || document.getElementById("card")?.querySelector(".pin-pad, .pin");

// Registered after spatial.js (main.js imports this second), before main.js's own keys.
addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  const stop = () => (e.preventDefault(), e.stopImmediatePropagation());
  if (!keysEl.hidden) {
    if (k === "Escape" || k === "?" || k === "Backspace") stop(), hideKeys();
    return;
  }
  // The settings menu: spatial.js moves focus inside it; Back and Escape step out.
  if (!menu.hidden) {
    if (k === "Escape" || k === "Backspace") {
      stop();
      if (page !== "main") (page = "main"), renderMenu(true);
      else closeMenu();
      return;
    }
    if ((k === "ArrowLeft" || k === "ArrowRight") && menu.contains(document.activeElement)) {
      // Left/Right on a stepper row press its − / +.
      const s = document.activeElement.closest(".pm-step");
      if (s) {
        stop();
        return s.querySelector(`[data-m$=":${k === "ArrowLeft" ? "-" : "+"}"]`)?.click();
      }
      if (k === "ArrowLeft" && page !== "main") return stop(), (page = "main"), renderMenu(true);
    }
    return;
  }
  if (typing(e.target)) return;
  if (otherLayer()) return;
  // The remote is on the bar.
  if (bar.contains(document.activeElement)) {
    const el = document.activeElement;
    if (k === "Escape" || k === "Backspace") return stop(), hideBar();
    if (el === scrub && (k === "ArrowLeft" || k === "ArrowRight")) return stop(), seekRel(k === "ArrowLeft" ? -10_000 : 30_000);
    if (el === volr && (k === "ArrowLeft" || k === "ArrowRight")) return stop(), volumeBy(k === "ArrowLeft" ? -0.05 : 0.05);
    const dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[k];
    if (dir) {
      stop();
      showBar("key");
      if (!move(bar, dir, el) && dir === "up") hideBar();
      return;
    }
    if (k === "Enter" || (k === " " && el.matches("button"))) {
      stop();
      el.click();
      return;
    }
  }
  const t = player.timeline?.();
  const seekable = !!t && t.maxMs > t.minMs;
  switch (k) {
    case "ArrowDown":
      // While the bar shows from a key press, Down goes onto it instead of changing channel.
      if (barShown() && shownBy === "key") return stop(), $('[data-act="play"]').focus({ focusVisible: true });
      return;
    case "ArrowLeft":
    case "ArrowRight":
      if (e.shiftKey && t) return stop(), chapterJump(k === "ArrowRight" ? 1 : -1);
      // main.js seeks On Demand or shows what's on; the bar comes along.
      showBar("key");
      return;
    case "Home":
    case "End":
      if (!t) return;
      stop();
      seekTo(k === "Home" ? 0 : (t.durMs || 0) - 5000);
      return;
    case ",":
    case ".":
      stop();
      if (!fx.stepFrame(k === "." ? 1 : -1)) osd("FRAME", "Nothing to step through", 1200);
      else osd(k === "." ? "FRAME ▶" : "◀ FRAME", "", 600);
      showBar("key");
      return;
    case "<":
    case ">":
    case "[":
    case "]": {
      stop();
      const cur = player.currentRate?.() ?? 1;
      const i = SPEEDS.indexOf(cur);
      const next = SPEEDS[clamp((i < 0 ? 3 : i) + (k === ">" || k === "]" ? 1 : -1), 0, SPEEDS.length - 1)];
      if (player.setRate?.(next)) osd(`${next}×`, "Speed", 1000);
      else osd("1×", seekable || t?.mode !== "live" ? "Speed" : "Live plays at normal speed", 1500);
      return;
    }
    case "/":
    case "*":
      stop();
      return volumeBy(k === "*" ? 0.05 : -0.05);
    case "p":
    case "P":
      stop();
      return void togglePip();
    case "x":
    case "X":
      stop();
      return void fx.screenshot();
    case "d":
    case "D":
      stop();
      fx.toggleStats();
      return;
    case "?":
      stop();
      return showKeys();
    case "m":
    case "M":
      stop();
      return toggleMute();
    case "f":
    case "F":
      stop();
      return toggleFull();
  }
}, true);

function chapterJump(dir) {
  const t = player.timeline?.();
  if (!t) return;
  const l = [0, ...chapters.list];
  let to;
  if (dir > 0) to = l.find((c) => c > t.posMs + 1000);
  else {
    const before = l.filter((c) => c < t.posMs - 3000);
    to = before.at(-1) ?? 0;
  }
  if (to == null) return osd("CHAPTER", "No more chapters", 1200);
  seekTo(to);
  const ch = chapterAt(to);
  osd(`CHAPTER ${ch?.n ?? 1}`, "", 1200);
}

// ------------------------------------------------------------------ mouse and touch on the picture

stage.addEventListener("wheel", (e) => {
  if (blocked() || e.ctrlKey) return;
  e.preventDefault();
  volumeBy(e.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });
stage.addEventListener("dblclick", (e) => {
  if (e.target.closest("#card button, #card a, .chip")) return;
  toggleFull();
});
let lastTap = { t: 0, x: 0 };
stage.addEventListener("pointerup", (e) => {
  if (e.pointerType !== "touch" || blocked()) return;
  const now = performance.now();
  const third = e.clientX / innerWidth;
  // Double-tap a side to skip, like YouTube.
  if (now - lastTap.t < 320 && Math.abs(e.clientX - lastTap.x) < 80 && (third < 0.35 || third > 0.65)) {
    lastTap = { t: 0, x: 0 };
    seekRel(third < 0.35 ? -10_000 : 30_000);
    return;
  }
  lastTap = { t: now, x: e.clientX };
  if (barShown()) hideBar();
  else showBar("pointer", 4000);
});

// Paused: keep the bar up so play is one press away.
video.addEventListener("pause", () => tv.paused && showBar(shownBy ?? "pointer"));

fx.applySound();
