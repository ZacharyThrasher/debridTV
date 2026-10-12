// Player effects behind the control bar (docs/parity/player.md): volume boost, audio
// delay, night mode and tone through Web Audio; picture adjustments through CSS;
// subtitle delay and your own subtitle file; screenshots, frame steps, A–B loop and
// the stats overlay. Nothing here fetches media: it all works on what is already
// playing.

import { pref, setPref, clamp, fmtClock, toast } from "./util.js";
import * as player from "./player.js";
import { parseSubs } from "./subfile.js";

const video = document.getElementById("video");
const synthEl = document.getElementById("synth");

// ------------------------------------------------------------------ sound

// The Web Audio graph is built only once something needs it (boost, delay, night
// mode, tone): after createMediaElementSource the element's sound always flows
// through the graph, so the plain case stays plain.
let ac = null;
let nodes = null;

const want = () => level() > 1 || audioDelay() > 0 || !!pref("nightMode") || !!pref("bassDb") || !!pref("trebleDb");

function graph() {
  if (nodes) return nodes;
  try {
    ac = new AudioContext();
    const src = ac.createMediaElementSource(video);
    const delay = ac.createDelay(10);
    const bass = Object.assign(ac.createBiquadFilter(), { type: "lowshelf" });
    bass.frequency.value = 200;
    const treble = Object.assign(ac.createBiquadFilter(), { type: "highshelf" });
    treble.frequency.value = 3200;
    const night = ac.createDynamicsCompressor();
    // Night mode: lift quiet dialogue, hold down explosions (like mpv's dynaudnorm).
    night.threshold.value = -38;
    night.knee.value = 24;
    night.ratio.value = 8;
    night.attack.value = 0.004;
    night.release.value = 0.3;
    const makeup = ac.createGain();
    const gain = ac.createGain();
    src.connect(delay).connect(bass).connect(treble);
    makeup.connect(gain).connect(ac.destination);
    nodes = { src, delay, bass, treble, night, makeup, gain, nightOn: null };
  } catch {
    nodes = null;
  }
  return nodes;
}

/** Re-apply volume, boost, delay, night mode and tone. Cheap; call after any change. */
export function applySound() {
  const v = level();
  video.muted = !!pref("muted");
  video.volume = clamp(Math.min(v, 1), 0, 1);
  if (!nodes && !want()) return;
  const n = graph();
  if (!n) return;
  if (ac.state === "suspended") ac.resume().catch(() => {});
  n.gain.gain.value = Math.max(1, v);
  n.delay.delayTime.value = Math.max(0, audioDelay()) / 1000;
  n.bass.gain.value = Number(pref("bassDb")) || 0;
  n.treble.gain.value = Number(pref("trebleDb")) || 0;
  const night = !!pref("nightMode");
  if (n.nightOn !== night) {
    n.treble.disconnect();
    if (night) n.treble.connect(n.night).connect(n.makeup);
    else n.treble.connect(n.makeup);
    n.makeup.gain.value = night ? 1.9 : 1;
    n.nightOn = night;
  }
}
// Browsers start an AudioContext suspended until the viewer presses something.
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => ac?.state === "suspended" && ac.resume().catch(() => {}), true);

/** Volume 0–2 (above 1 is the boost). */
export const level = () => (Number(pref("volume")) || 0) * (Number(pref("boost")) || 1);
export function setLevel(v) {
  v = clamp(Math.round(v * 100) / 100, 0, 2);
  setPref("volume", Math.min(v, 1));
  setPref("boost", v > 1 ? v : 1);
  if (v > 0 && pref("muted")) setPref("muted", false);
  applySound();
}

/** Audio delay in ms: positive = sound later, negative = sound earlier. */
export const audioDelay = () => clamp(Math.round(Number(pref("audioDelayMs")) || 0), -10_000, 10_000);
export function setAudioDelay(ms) {
  const before = audioDelay();
  setPref("audioDelayMs", clamp(Math.round(ms / 10) * 10, -10_000, 10_000));
  applySound();
  // Crossing into or out of "earlier" changes how the stream is made; the player restarts it in place.
  if ((before < 0) !== (audioDelay() < 0) || audioDelay() < 0) shiftSoon();
}
let shiftTimer = 0;
function shiftSoon() {
  clearTimeout(shiftTimer);
  // A run of presses restarts the stream once.
  shiftTimer = setTimeout(() => player.reapplyAudioShift?.(), 700);
}

// ------------------------------------------------------------------ picture

/**
 * Picture adjustments on top of the shape (Z): zoom 1–2, rotate 0/90/180/270, flip,
 * brightness/contrast/saturation 0.5–1.5 (1 = as filmed). The demo canvas gets them too.
 */
export const PICTURE = { zoom: 1, rotate: 0, flip: false, brightness: 1, contrast: 1, saturation: 1, cropT: 0, cropR: 0, cropB: 0, cropL: 0 };
export const picture = () => ({ ...PICTURE, ...(pref("picture") ?? {}) });
export function setPicture(patch) {
  const p = { ...picture(), ...patch };
  for (const k of Object.keys(p)) if (p[k] === PICTURE[k]) delete p[k];
  setPref("picture", Object.keys(p).length ? p : null);
  applyPicture();
}
export function applyPicture() {
  const p = picture();
  const stage = video.parentElement;
  const W = stage?.clientWidth || innerWidth, H = stage?.clientHeight || innerHeight;
  const turn = ((p.rotate % 360) + 360) % 360;
  // A quarter turn swaps width and height: shrink so the turned picture still fits.
  const fit = turn % 180 ? Math.min(W / H, H / W) : 1;
  const t = [turn && `rotate(${turn}deg)`, (p.zoom !== 1 || fit !== 1) && `scale(${(p.zoom * fit).toFixed(4)})`, p.flip && "scaleX(-1)"].filter(Boolean).join(" ");
  const f = [p.brightness !== 1 && `brightness(${p.brightness})`, p.contrast !== 1 && `contrast(${p.contrast})`, p.saturation !== 1 && `saturate(${p.saturation})`].filter(Boolean).join(" ");
  for (const el of [video, synthEl]) {
    if (!el) continue;
    el.style.transform = t;
    el.style.filter = f;
  }
  applyCrop(p, W, H);
}
addEventListener("resize", () => {
  const p = picture();
  if (p.rotate % 180 || cropOn(p)) applyPicture();
});
video.addEventListener("loadedmetadata", () => cropOn(picture()) && applyPicture());

// ------------------------------------------------------------------ crop

// Crop (VLC's Video → Crop, mpv's video-crop): cut fractions off each edge of the
// file's picture (cropT/R/B/L, 0–0.4), then fit what's left to the screen. The video
// element is sized so the whole frame keeps its shape, placed so the kept part is
// centred, and clipped to it. The demo picture isn't cropped.
let cropApplied = false;
export const cropOn = (p = picture()) => p.cropT > 0 || p.cropR > 0 || p.cropB > 0 || p.cropL > 0;
function applyCrop(p, W, H) {
  const s = video.style;
  if (!cropOn(p)) {
    if (cropApplied) {
      cropApplied = false;
      Object.assign(s, { clipPath: "", transformOrigin: "", objectFit: "" });
      player.applyAspect?.(); // back to the picture shape's own box
    }
    return;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const kw = 1 - p.cropL - p.cropR, kh = 1 - p.cropT - p.cropB;
  const scale = Math.min(W / (vw * kw), H / (vh * kh));
  const ew = vw * scale, eh = vh * scale;
  Object.assign(s, {
    objectFit: "fill", width: `${ew}px`, height: `${eh}px`, right: "auto", bottom: "auto",
    left: `${(W - ew * kw) / 2 - p.cropL * ew}px`, top: `${(H - eh * kh) / 2 - p.cropT * eh}px`,
    clipPath: `inset(${p.cropT * 100}% ${p.cropR * 100}% ${p.cropB * 100}% ${p.cropL * 100}%)`,
    transformOrigin: `${(p.cropL + kw / 2) * 100}% ${(p.cropT + kh / 2) * 100}%`, // zoom and turn around the kept part
  });
  cropApplied = true;
}

/** Crop to an aspect ratio (e.g. 2.39) from the centre: the sides or top and bottom, whichever is too long. */
export function cropToRatio(ratio) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return toast("Crop needs a playing program."), false;
  const src = vw / vh;
  const e = src > ratio ? (1 - (ratio * vh) / vw) / 2 : (1 - vw / ratio / vh) / 2;
  const v = Math.round(clamp(e, 0, 0.4) * 1000) / 1000;
  setPicture(src > ratio ? { cropL: v, cropR: v, cropT: 0, cropB: 0 } : { cropT: v, cropB: v, cropL: 0, cropR: 0 });
  return true;
}

/**
 * Find black bars in the frame on screen (like mpv's autocrop) and crop them off.
 * Reads one frame of what is already playing; nothing is fetched.
 */
export function autoCrop() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return toast("Auto crop needs a playing program."), null;
  const w = 192, h = Math.max(2, Math.round((w * vh) / vw));
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d", { willReadFrequently: true });
  let d;
  try {
    g.drawImage(video, 0, 0, w, h);
    d = g.getImageData(0, 0, w, h).data;
  } catch {
    return toast("This picture can't be measured."), null;
  }
  const lum = (x, y) => {
    const i = (y * w + x) * 4;
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  };
  const dark = (n, len, at) => {
    for (let k = 0; k < len; k++) if (at(n, k) > 28) return false;
    return true;
  };
  const scan = (len, across, at) => {
    let n = 0;
    while (n < len * 0.4 && dark(n, across, at)) n++;
    return n / len;
  };
  const crop = {
    cropT: scan(h, w, (y, x) => lum(x, y)),
    cropB: scan(h, w, (y, x) => lum(x, h - 1 - y)),
    cropL: scan(w, h, (x, y) => lum(x, y)),
    cropR: scan(w, h, (x, y) => lum(w - 1 - x, y)),
  };
  // A whole black frame (a fade) isn't letterboxing.
  if (crop.cropT + crop.cropB > 0.78 || crop.cropL + crop.cropR > 0.78) return toast("The picture is dark right now; try again in a moment."), null;
  for (const k of Object.keys(crop)) crop[k] = Math.round(crop[k] * 1000) / 1000;
  setPicture(crop);
  return crop;
}

// ------------------------------------------------------------------ subtitle delay

// Shifts every text cue on the video by pref subDelayMs (positive = later), whatever
// added it: the compatibility stream's captions, or a file you loaded. Cues keep their
// original times here so changing the delay never drifts.
const orig = new WeakMap();
const ownCues = new WeakSet(); // a loaded file's cues, placed by loadedCues() instead
export const subDelay = () => clamp(Math.round(Number(pref("subDelayMs")) || 0), -60_000, 60_000);
export function setSubDelay(ms) {
  setPref("subDelayMs", clamp(Math.round(ms / 50) * 50, -60_000, 60_000));
  shiftCues(true);
  placeLoaded();
}
function shiftCues(all = false) {
  const d = subDelay() / 1000;
  for (const tr of video.textTracks) {
    for (const c of tr.cues ?? []) {
      if (ownCues.has(c)) continue;
      let o = orig.get(c);
      if (!o) {
        if (!d) continue; // never touched, and no delay: leave it be
        orig.set(c, (o = { s: c.startTime, e: c.endTime }));
      } else if (!all) continue;
      c.startTime = Math.max(0, o.s + d);
      c.endTime = Math.max(c.startTime + 0.05, o.e + d);
    }
  }
}
setInterval(() => subDelay() && shiftCues(false), 400);

// ------------------------------------------------------------------ your own subtitle file

let loaded = null; // { itemId, name, cues: [{ s, e, text }] } in file time (ms)
let loadedTrack = null;

/** Read a .srt/.vtt picked on this device (never uploaded) and show it on this program. */
export async function loadSubtitleFile(file) {
  const t = player.timeline?.();
  if (!t?.itemId) return toast("Start a program first, then load its subtitles."), false;
  const cues = parseSubs(await file.text());
  if (!cues.length) return toast("That file has no subtitles DebridTV can read (SRT or WebVTT)."), false;
  loaded = { itemId: t.itemId, name: file.name, cues };
  placeLoaded();
  toast(`Subtitles from ${file.name}`);
  return true;
}
export const loadedSubs = () => loaded;
export function clearLoaded() {
  loaded = null;
  if (loadedTrack) {
    for (const c of [...(loadedTrack.cues ?? [])]) loadedTrack.removeCue(c);
    loadedTrack.mode = "disabled";
  }
}

/** Lay the file's cues on the video's clock (a compatibility stream starts at 0 mid-file). */
function placeLoaded() {
  if (!loaded) return;
  const t = player.timeline?.();
  if (!t || t.itemId !== loaded.itemId) return clearLoaded();
  if (!loadedTrack) {
    loadedTrack = video.addTextTrack("subtitles", "Your file", ""); // styled by the captions sheet's ::cue rule
  }
  for (const c of [...(loadedTrack.cues ?? [])]) loadedTrack.removeCue(c);
  const zero = t.posMs - video.currentTime * 1000; // file ms at video time 0
  const d = subDelay();
  for (const c of loaded.cues) {
    const s = (c.s + d - zero) / 1000, e = (c.e + d - zero) / 1000;
    if (e <= 0) continue;
    const cue = new VTTCue(Math.max(0, s), e, c.text);
    ownCues.add(cue);
    loadedTrack.addCue(cue);
  }
  loadedTrack.mode = "showing";
}
// A new stream (seek in compatibility mode, track change, next program) moves the zero.
video.addEventListener("playing", () => loaded && placeLoaded());
addEventListener("debridtv:ondemand", () => loaded && setTimeout(placeLoaded, 0));

// ------------------------------------------------------------------ frames and screenshots

// The file's frame length, learned from the picture itself while it plays.
let frameSec = 1 / 24;
let lastFrame = null;
function watchFrames() {
  if (!video.requestVideoFrameCallback) return;
  video.requestVideoFrameCallback((_, meta) => {
    if (lastFrame != null && meta.presentedFrames - lastFrame.n === 1) {
      const dt = meta.mediaTime - lastFrame.t;
      if (dt > 0.004 && dt < 0.2) frameSec = frameSec * 0.8 + dt * 0.2;
    }
    lastFrame = { n: meta.presentedFrames, t: meta.mediaTime };
    watchFrames();
  });
}
watchFrames();
export const frameMs = () => Math.round(frameSec * 1000);

/** One frame forward (+1) or back (-1). Pauses first. Direct play steps both ways. */
export function stepFrame(dir) {
  const t = player.timeline?.();
  if (!t || player.tv.route === "demo" || player.tv.route === "card") return false;
  if (!player.tv.paused) player.togglePause();
  const to = video.currentTime + dir * frameSec;
  if (to < 0) return false;
  video.currentTime = to;
  return true;
}

/** Save the frame on screen as a PNG on this device. */
export function screenshot() {
  const t = player.timeline?.();
  const src = player.demoCanvas?.() ?? (video.videoWidth ? video : null);
  if (!src) return toast("Nothing on screen to capture."), false;
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  const p = picture();
  g.filter = [`brightness(${p.brightness})`, `contrast(${p.contrast})`, `saturate(${p.saturation})`].join(" ");
  if (p.flip) g.translate(w, 0), g.scale(-1, 1);
  g.drawImage(src, 0, 0, w, h);
  const title = (player.tv.onDemand?.title ?? player.tv.info?.airing?.title ?? "DebridTV").replace(/[\\/:*?"<>|]+/g, " ").trim();
  const at = t ? fmtClock(t.posMs).replace(/:/g, "-") : "";
  c.toBlob((b) => {
    if (!b) return toast("This picture can't be captured.");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: `${title}${at ? ` ${at}` : ""}.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Screenshot saved");
  }, "image/png");
  return true;
}

// ------------------------------------------------------------------ loops

let loop = null; // { a, b } file ms; b null while waiting for the second press
export const abLoop = () => loop;
/** A–B loop: first call marks A, second marks B, third clears. */
export function markLoop() {
  const t = player.timeline?.();
  if (!t || t.maxMs <= t.minMs) return toast("Loops work in On Demand."), null;
  loopItem = t.itemId;
  if (!loop) loop = { a: t.posMs, b: null };
  else if (loop.b == null && t.posMs > loop.a + 500) loop.b = t.posMs;
  else loop = null;
  return loop;
}
export function setLoopFile(on) {
  const t = player.timeline?.();
  loopItem = t?.itemId ?? null;
  loop = on && t?.durMs && t.maxMs > t.minMs ? { a: 0, b: t.durMs - 800, whole: true } : null;
}
let loopItem = null;
setInterval(() => {
  const t = player.timeline?.();
  if (!loop || !t) return;
  if (loopItem !== t.itemId) return void (loop = loopItem = null);
  if (loop.b != null && !player.tv.paused && t.posMs >= loop.b) player.seekTo(loop.a);
}, 200);

// ------------------------------------------------------------------ stats

const statsEl = Object.assign(document.createElement("pre"), { className: "pstats", hidden: true });
statsEl.setAttribute("aria-live", "off");
document.getElementById("stage").append(statsEl);
let statsTimer = 0;
export const statsOn = () => !statsEl.hidden;
export function toggleStats(on = statsEl.hidden) {
  statsEl.hidden = !on;
  clearInterval(statsTimer);
  if (on) {
    drawStats();
    statsTimer = setInterval(drawStats, 1000);
  }
}
const ROUTES = { direct: "Direct play (the browser reads the file)", live: "Compatibility mode (ffmpeg on the PC)", demo: "Demo picture", card: "—", none: "Can't decode" };
function drawStats() {
  const t = player.timeline?.();
  const a = player.tv.info?.airing;
  const c = a?.codecs ?? {};
  const q = video.getVideoPlaybackQuality?.();
  let ahead = 0;
  for (let i = 0; i < video.buffered.length; i++)
    if (video.buffered.start(i) <= video.currentTime + 0.1) ahead = Math.max(ahead, video.buffered.end(i) - video.currentTime);
  const rows = [
    ["Playing", player.tv.onDemand ? "On Demand" : player.tv.current ? `Channel ${player.tv.current.number} · ${player.tv.current.name}` : "—"],
    ["Route", ROUTES[player.tv.route] ?? player.tv.route],
    ["Picture", video.videoWidth ? `${video.videoWidth}×${video.videoHeight}${c.video ? ` · ${String(c.video).toUpperCase()}` : ""}${c.hdr ? ` · ${c.hdr}` : ""}` : "—"],
    ["Frame", `${frameMs()} ms (${(1000 / frameMs()).toFixed(2)} fps)`],
    ["Sound", [Array.isArray(c.audio) ? c.audio[0] : c.audio, c.audioChannels && `${c.audioChannels} ch`].filter(Boolean).join(" · ") || "—"],
    ["Dropped", q ? `${q.droppedVideoFrames} of ${q.totalVideoFrames} frames` : "—"],
    ["Buffer", `${ahead.toFixed(1)} s ahead`],
    ["Position", t ? `${fmtClock(t.posMs)} / ${fmtClock(t.durMs)}${t.liveMs != null ? ` · live ${fmtClock(t.liveMs)}` : ""}` : "—"],
    ["Speed", `${player.currentRate?.() ?? 1}×`],
    ["Volume", `${Math.round(level() * 100)}%${pref("muted") ? " (muted)" : ""}${pref("nightMode") ? " · night mode" : ""}`],
    ["Sync", `sound ${audioDelay()} ms · subtitles ${subDelay()} ms`],
    ["Item", t?.itemId ?? "—"],
  ];
  statsEl.textContent = rows.map(([k, v]) => `${k.padEnd(9)} ${v}`).join("\n");
}

applySound();
applyPicture();
