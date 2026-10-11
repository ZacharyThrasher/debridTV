// The tuner. Implements the measured default from EXP-006/LIVE-001
// ("adaptive-prefetch"): every press asks the *local* station clock what's on
// (free), resolves the playback link once the viewer has lingered briefly (one
// API call, cached for an hour), and only opens media after an adaptive dwell
// learned from the viewer's own surfing rhythm. Surfing past a channel costs no
// media bytes, and leaving a channel cancels its stream at once.

import { api } from "./api.js";
import { now, sleep, clamp, pref, syncClock, toast } from "./util.js";
import { staticOn, staticOff, click } from "./static.js";
import { synthStart, synthStop, synthPaused } from "./synth.js";
import { breakCard, offAirCard, unavailableCard, messageCard, hideCard } from "./cards.js";
import { osd, osdHide, bug, setBanner, showBanner } from "./ui.js";

const video = document.getElementById("video");
const pausedEl = document.getElementById("paused");

export const tv = { channels: [], current: null, last: null, info: null, route: "card", ffmpeg: false, paused: false };

const MIN_WAIT = 150, MAX_WAIT = 1200; // EXP-006 adaptive bounds
let token = 0;
let lastPressAt = 0;
let lastGap = Infinity;
let boundary = 0;
let stallTimer = 0;
let media = null; // { itemId, route, liveStart }
let watch = null; // { itemId, channel, from }

// ------------------------------------------------------------------ public

export function channelStep(dir) {
  const list = tv.channels;
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((c) => c.id === tv.current?.id));
  tune(list[(i + dir + list.length) % list.length]);
}

export function lastChannel() {
  if (tv.last) tune(tv.last);
}

export function byNumber(n) {
  return tv.channels.find((c) => c.number === n);
}

export async function tune(ch, { silent = false } = {}) {
  if (!ch) return;
  const my = ++token;
  clearTimeout(boundary);
  clearTimeout(stallTimer);
  flushWatch(true);
  setPaused(false, { quiet: true });

  let wait = 0;
  if (!silent) {
    const t = performance.now();
    const gap = t - lastPressAt;
    lastPressAt = t;
    // A long pause between presses means a deliberate pick: play almost at once.
    wait = gap > 2 * MAX_WAIT ? MIN_WAIT : clamp(1.3 * Math.min(gap, lastGap * 2), MIN_WAIT, MAX_WAIT);
    lastGap = gap > 2 * MAX_WAIT ? Infinity : gap;
    if (tv.current && tv.current.id !== ch.id) tv.last = tv.current;
    click();
    staticOn();
    stopMedia();
    synthStop();
    hideCard();
    osd(String(ch.number), ch.name);
  }
  tv.current = ch;
  try {
    localStorage.setItem("debridtv.lastChannel", ch.id);
  } catch {}
  bug(ch);

  const sent = Date.now();
  let info;
  try {
    info = await api.get(`/api/now?channel=${encodeURIComponent(ch.id)}${silent ? "" : "&count=1"}`);
  } catch (e) {
    if (my !== token) return;
    staticOff();
    return messageCard(ch, "Signal lost", "Can't reach the tuner", `The DebridTV server on this PC isn't answering (${e.message}). Is it still running?`);
  }
  if (my !== token) return;
  syncClock(info.now, sent);
  tv.info = info;

  const a = info.airing;
  const playable = a && info.segment?.kind === "program" && a.provider && a.provider !== "demo" && a.availability !== "policy-blocked";
  if (playable) {
    // Resolve the link after the minimum dwell; media waits for the adaptive dwell.
    if (wait > 0) await sleep(Math.min(MIN_WAIT, wait));
    if (my !== token) return;
    api.post("/api/prefetch", { itemId: a.itemId }).catch(() => {});
    if (wait > MIN_WAIT) await sleep(wait - MIN_WAIT);
    if (my !== token) return;
  }
  render(ch, info, my, silent);
}

export function togglePause() {
  if (!tv.current) return;
  if (tv.paused) {
    // Like real TV, resuming returns to live (parity C4): the station never waited.
    setPaused(false);
    tune(tv.current, { silent: true });
  } else setPaused(true);
}

export function applyVolume() {
  video.muted = !!pref("muted");
  video.volume = pref("volume");
}

// ------------------------------------------------------------------ render

function render(ch, info, my, silent) {
  const seg = info.segment;
  const a = info.airing;
  const newProgram = !media || media.itemId !== a?.itemId || seg?.kind !== "program";
  if (silent && newProgram) {
    stopMedia();
    synthStop();
  }
  hideCard();
  scheduleBoundary(ch, seg ? seg.end : a ? a.end : now() + 60_000);

  if (info.offAir || !a) {
    tv.route = "card";
    staticOff();
    offAirCard(ch);
  } else if (seg.kind === "break") {
    tv.route = "card";
    stopMedia();
    staticOff();
    breakCard(ch, info);
  } else if (a.availability === "policy-blocked") {
    tv.route = "card";
    staticOff();
    unavailableCard(ch, a, { policy: true });
  } else if (a.provider === "demo") {
    tv.route = "demo";
    synthStart(a, info.fileOffsetMs + (now() - info.now));
    staticOff();
    startWatch(a.itemId, ch.id);
  } else if (silent && media && media.itemId === a.itemId && !newProgram && !video.paused) {
    // Same program continuing after a mid-break boundary we never left.
  } else {
    playMedia(ch, info, my);
  }
  setBanner(ch, info, tv.route);
  if (!silent || newProgram) showBanner();
  if (silent) osdHide();
}

function scheduleBoundary(ch, at) {
  clearTimeout(boundary);
  boundary = setTimeout(() => {
    if (tv.current?.id === ch.id && !tv.paused) tune(ch, { silent: true });
  }, Math.max(250, at - now() + 60));
}

// ------------------------------------------------------------------ media

const AUDIO_OK = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

const probeEl = document.createElement("video");
const CODEC_TYPES = {
  h264: 'video/mp4; codecs="avc1.42E01E"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  vp9: 'video/webm; codecs="vp9"',
  vp8: 'video/webm; codecs="vp8"',
};
/** Video codecs this browser can decode, asked once. */
const decodable = Object.keys(CODEC_TYPES).filter((c) => !!probeEl.canPlayType(CODEC_TYPES[c]));
const canVideo = (codec) => !codec || decodable.includes(codec);

/** Direct play when the browser can decode the file as-is, else ffmpeg compatibility mode. */
function chooseRoute(a) {
  const c = a.codecs || {};
  const audio = Array.isArray(c.audio) ? c.audio[0] : c.audio;
  const containerOk = c.container === "mp4" || c.container === "matroska" || !c.container || c.container === "unknown";
  const mkvNative = c.container !== "matroska" || !!video.canPlayType("video/x-matroska") || /Chrome\//.test(navigator.userAgent);
  const ok = containerOk && mkvNative && canVideo(c.video) && (!audio || AUDIO_OK.has(audio));
  if (ok || !tv.ffmpeg) return "direct";
  // Compatibility mode copies the picture when we can decode it, else converts it to H.264.
  if (!canVideo(c.video) && !canVideo("h264")) return "none";
  return "live";
}

function playMedia(ch, info, my) {
  const a = info.airing;
  stopMedia();
  const route = chooseRoute(a);
  tv.route = route;
  const offsetAt = () => info.fileOffsetMs + (now() - info.now);
  media = { itemId: a.itemId, route, liveStart: 0, ch, info };
  applyVolume();
  const onPlaying = () => {
    if (my !== token) return;
    clearTimeout(stallTimer);
    staticOff();
    startWatch(a.itemId, ch.id);
  };
  const onError = async () => {
    if (my !== token) return;
    clearTimeout(stallTimer);
    if (media?.route === "direct" && tv.ffmpeg) {
      // One fallback to compatibility mode, never a retry loop.
      media.route = tv.route = "live";
      setBanner(ch, info, tv.route);
      return startLive(offsetAt(), a, onPlaying, onError);
    }
    stopMedia();
    staticOff();
    let item = null;
    try {
      item = await api.get(`/api/item?id=${encodeURIComponent(a.itemId)}`);
    } catch {}
    if (my !== token) return;
    if (item?.availability === "policy-blocked") return unavailableCard(ch, a, { policy: true });
    const why = item?.availabilityReason
      ? `${item.availabilityReason}.`
      : tv.ffmpeg
        ? "The browser couldn't play this file, even in compatibility mode."
        : "Your browser can't play this file's format. Installing ffmpeg turns on compatibility mode (see the README).";
    unavailableCard(ch, a, { reason: `${why} The channel moves on at the next program.` });
  };
  video.onplaying = onPlaying;
  video.onerror = onError;
  stallTimer = setTimeout(() => my === token && toast("Still tuning in… your provider is taking a while."), 8000);
  if (route === "none") {
    clearTimeout(stallTimer);
    staticOff();
    return unavailableCard(ch, a, { reason: `This browser can't decode ${String(a.codecs?.video ?? "this").toUpperCase()} or H.264 video. Chrome or Edge can. The channel moves on at the next program.` });
  }
  if (route === "direct") {
    video.src = `/media/${encodeURIComponent(a.itemId)}`;
    video.onloadedmetadata = () => {
      if (my !== token) return;
      video.currentTime = offsetAt() / 1000;
      video.play().catch(() => autoplayHint());
    };
    video.load();
  } else startLive(offsetAt(), a, onPlaying, onError);
}

function startLive(offsetMs, a, onPlaying, onError) {
  const v = decodable.join(",") || "none";
  const tok = Math.random().toString(36).slice(2, 10);
  const m = media;
  m.liveStart = offsetMs;
  m.aligned = false;
  video.onloadedmetadata = null;
  video.onplaying = () => {
    if (media !== m) return;
    if (!m.aligned) {
      m.aligned = true;
      alignLive(m, tok, offsetMs).catch(() => {});
    }
    onPlaying();
  };
  video.onerror = onError;
  video.src = `/media/${encodeURIComponent(a.itemId)}/live?start=${(offsetMs / 1000).toFixed(2)}&v=${v}&tok=${tok}`;
  video.play().catch(() => autoplayHint());
}

/**
 * A copied picture starts on the keyframe before the live position (up to a few
 * seconds early). Ask where that was, jump ahead if it's already buffered, else
 * catch up by playing 10% faster (pitch preserved) until we're back on station time.
 */
async function alignLive(m, tok, requestedMs) {
  let startMs = null;
  for (let i = 0; i < 20 && startMs == null; i++) {
    try {
      startMs = (await api.get(`/api/livestart?tok=${tok}`)).startMs;
    } catch {
      await sleep(150);
    }
    if (media !== m) return;
  }
  if (startMs == null || requestedMs - startMs < 250) return;
  m.liveStart = startMs;
  const behind = () => m.info.fileOffsetMs + (now() - m.info.now) - (startMs + video.currentTime * 1000);
  const b = video.buffered;
  const target = video.currentTime + behind() / 1000;
  if (b.length && b.end(b.length - 1) >= target + 0.3) {
    video.currentTime = target;
    return;
  }
  video.preservesPitch = true;
  while (media === m && behind() > 150) {
    if (!tv.paused) video.playbackRate = 1.1;
    await sleep(250);
  }
  video.playbackRate = 1;
}

function autoplayHint() {
  if (video.paused && !video.muted) {
    // Browsers block sound until the first click or key press.
    video.muted = true;
    video.play().catch(() => {});
    toast("Press any key or click to turn the sound on.");
  }
}

function stopMedia() {
  flushWatch(true);
  video.playbackRate = 1;
  media = null;
  video.onplaying = video.onerror = video.onloadedmetadata = null;
  if (video.getAttribute("src")) {
    video.pause();
    // Dropping the source closes the connection, which the server turns into an
    // upstream cancel (measured: 26 ms on TorBox).
    video.removeAttribute("src");
    video.load();
  }
}

function setPaused(p, { quiet = false } = {}) {
  if (p) flushWatch(true);
  tv.paused = p;
  pausedEl.hidden = !p;
  if (p) {
    clearTimeout(boundary);
    if (media) video.pause();
    synthPaused(true);
  } else if (!quiet) synthPaused(false);
}

// ------------------------------------------------------------------ watch history

/** File position currently on screen, in ms, or null if nothing is playing. */
function filePos() {
  if (tv.route === "demo" && tv.info?.airing) return tv.info.fileOffsetMs + (now() - tv.info.now);
  if (!media || video.readyState < 2) return null;
  return media.route === "live" ? media.liveStart + video.currentTime * 1000 : video.currentTime * 1000;
}

function startWatch(itemId, channel) {
  const p = filePos();
  if (p == null) return;
  watch = { itemId, channel, from: p };
}

/** Report actually-seen file time (gate D8): never break time, never time we skipped. */
function flushWatch(end = false) {
  if (!watch) return;
  const to = filePos();
  const w = watch;
  if (end) watch = null;
  if (to == null || tv.paused) return;
  if (to - w.from >= 1000 && to - w.from < 10 * 60_000) {
    api.post("/api/watch", { itemId: w.itemId, fromMs: Math.round(w.from), toMs: Math.round(to), channel: w.channel }).catch(() => {});
  }
  if (!end) w.from = to;
}
setInterval(() => flushWatch(false), 15_000);
addEventListener("pagehide", () => flushWatch(true));
