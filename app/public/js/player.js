// The tuner. Implements the measured default from EXP-006/LIVE-001
// ("adaptive-prefetch"): every press asks the *local* station clock what's on
// (free), resolves the playback link once the viewer has lingered briefly (one
// API call, cached for an hour), and only opens media after an adaptive dwell
// learned from the viewer's own surfing rhythm. Surfing past a channel costs no
// media bytes, and leaving a channel cancels its stream at once.

import { api } from "./api.js";
import { now, sleep, clamp, pref, setPref, syncClock, toast } from "./util.js";
import { staticOn, staticOff, click } from "./static.js";
import { synthStart, synthStop, synthPaused } from "./synth.js";
import { breakCard, offAirCard, unavailableCard, messageCard, hideCard } from "./cards.js";
import * as cards from "./cards.js"; // lockedCard comes from workstream B
import { osd, osdHide, bug, setBanner, showBanner } from "./ui.js";
import { initSignOff, signedOff } from "./signoff.js";
import { tracksFor, selectionFor, needsCompat, selectionQuery, audioTracks, subTracks, defaultAudio, isText, trackLabel, Captions } from "./tracks.js";

const video = document.getElementById("video");
const synthEl = document.getElementById("synth");
const pausedEl = document.getElementById("paused");

export const tv = { channels: [], current: null, last: null, info: null, route: "card", ffmpeg: false, paused: false };

const MIN_WAIT = 150, MAX_WAIT = 1200; // EXP-006 adaptive bounds
// EXP-008: a slow surfer (about one press a second) gets a paused "peek" of the
// picture 400 ms after a press; motion and sound start when the adaptive wait ends.
const PEEK_AT = 400, PEEK_MIN_WAIT = 700;
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
  if (!ch || signedOff()) return;
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
    if (e.status === 403) return showLocked(ch, null); // body is { error, locked, final }
    return messageCard(ch, "Signal lost", "Can't reach the tuner", `The DebridTV server on this PC isn't answering (${e.message}). Is it still running?`);
  }
  if (my !== token) return;
  syncClock(info.now, sent);
  tv.info = info;
  // A PIN-locked channel (N-06b) gets a scrambled card: no link, no media, no bytes.
  // A redacted airing (itemId null on a locked channel) never reaches the media code,
  // even if the lock flags were missing.
  if (isLocked(ch, info) || (info.airing && info.airing.itemId == null && info.airing.provider !== "demo")) {
    staticOff();
    scheduleBoundary(ch, info.segment ? info.segment.end : info.airing ? info.airing.end : now() + 60_000);
    return showLocked(ch, info);
  }

  const a = info.airing;
  const playable = a && info.segment?.kind === "program" && a.provider && a.provider !== "demo" && a.availability !== "policy-blocked";
  let hold = 0;
  if (playable) {
    // Resolve the link after the minimum dwell; media waits for the adaptive dwell.
    if (wait > 0) await sleep(Math.min(MIN_WAIT, wait));
    if (my !== token) return;
    api.post("/api/prefetch", { itemId: a.itemId }).catch(() => {});
    if (wait >= PEEK_MIN_WAIT) {
      await sleep(PEEK_AT - MIN_WAIT);
      hold = wait - PEEK_AT;
    } else if (wait > MIN_WAIT) await sleep(wait - MIN_WAIT);
    if (my !== token) return;
  }
  render(ch, info, my, silent, hold);
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

function render(ch, info, my, silent, hold = 0) {
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
    playMedia(ch, info, my, null, hold);
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

async function playMedia(ch, info, my, forced = null, hold = 0) {
  const holdUntil = performance.now() + hold;
  const a = info.airing;
  stopMedia();
  // Remembered audio/caption languages may need tracks the browser can't pick by
  // itself. Only then do we look the tracks up (a local call), so the common case
  // adds no delay.
  let sel = forced;
  if (!sel && tv.ffmpeg && (pref("audioLang") || (pref("subLang") && pref("subLang") !== "off"))) {
    sel = selectionFor(await tracksFor(a.itemId));
    if (my !== token) return;
  }
  let route = chooseRoute(a);
  if (sel && needsCompat(sel) && tv.ffmpeg && route === "direct") route = "live";
  tv.route = route;
  const offsetAt = () => info.fileOffsetMs + (now() - info.now);
  media = { itemId: a.itemId, route, liveStart: 0, ch, info, sel, my };
  applyVolume();
  const onPlaying = () => {
    if (my !== token) return;
    clearTimeout(stallTimer);
    staticOff();
    startWatch(a.itemId, ch.id);
  };
  // A stall mid-program (Wi-Fi hiccup, slow provider). The browser re-requests on
  // its own, and reopening ourselves made a hung provider worse in testing, so we
  // only say what's happening after 7 s.
  video.onwaiting = () => {
    if (my !== token || !media || tv.paused || video.currentTime < 0.5) return;
    const m = media;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (media !== m || my !== token || tv.paused || (!video.paused && video.readyState >= 3)) return;
      toast("Your provider is slow right now. Still trying…");
    }, 7000);
  };
  const onError = async () => {
    if (my !== token) return;
    clearTimeout(stallTimer);
    const route = media?.route;
    stopMedia();
    if (isLocked(ch, info)) return staticOff(), showLocked(ch, info);
    // Ask the server what happened before doing anything else. A refusal (451) or a
    // file the account can't serve (409) is final: no retry, no compatibility-mode
    // second attempt, no other provider (ADR-0002).
    let item = null;
    let status = 0;
    try {
      item = await api.get(`/api/item?id=${encodeURIComponent(a.itemId)}`);
    } catch (e) {
      status = e.status ?? 0;
    }
    if (my !== token) return;
    // The server refuses media on a locked channel with 403: final, show the lock.
    if (status === 403) return staticOff(), showLocked(ch, info);
    if (item?.availability === "policy-blocked") return staticOff(), unavailableCard(ch, a, { policy: true });
    if (item?.availability === "unavailable") {
      staticOff();
      return unavailableCard(ch, a, { reason: `${item.availabilityReason ?? "The provider couldn't serve this file"}. The channel moves on at the next program.` });
    }
    if (route === "direct" && tv.ffmpeg) {
      // The bytes arrived but this browser couldn't decode them: one fallback to
      // compatibility mode, never a loop.
      media = { itemId: a.itemId, route: "live", liveStart: 0, ch, info, sel, my };
      tv.route = "live";
      setBanner(ch, info, tv.route);
      return startLive(offsetAt(), a, onPlaying, onError);
    }
    staticOff();
    const why = tv.ffmpeg
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
    // With a hold (slow surfing) open paused: headers, then the frame where the
    // program will be when the hold ends. Motion and sound start then.
    video.preload = hold > 0 ? "metadata" : "auto";
    video.src = `/media/${encodeURIComponent(a.itemId)}`;
    video.onloadedmetadata = () => {
      if (my !== token) return;
      const left = Math.max(0, holdUntil - performance.now());
      video.currentTime = (offsetAt() + left) / 1000;
      if (!left) return void video.play().catch(() => autoplayHint());
      video.onseeked = () => {
        video.onseeked = null;
        if (my === token && video.paused) staticOff(); // the picture locks in, still silent
      };
      setTimeout(() => {
        if (my !== token || tv.paused) return;
        video.preload = "auto";
        if (Math.abs(video.currentTime * 1000 - offsetAt()) > 1000) video.currentTime = offsetAt() / 1000;
        video.play().catch(() => autoplayHint());
      }, left);
    };
    video.load();
  } else if (hold > 0) {
    // Compatibility mode starts ffmpeg, so it only starts once the viewer settles.
    setTimeout(() => my === token && media?.itemId === a.itemId && startLive(offsetAt(), a, onPlaying, onError), hold);
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
  video.src = `/media/${encodeURIComponent(a.itemId)}/live?start=${(offsetMs / 1000).toFixed(2)}&v=${v}&tok=${tok}${selectionQuery(m.sel)}`;
  video.play().catch(() => autoplayHint());
  if (m.sel?.sub != null && !m.sel.burn) {
    tracksFor(a.itemId).then((tracks) => {
      if (media !== m) return;
      const t = subTracks(tracks).find((x) => x.index === m.sel.sub);
      captions.start(tok, trackLabel(t), t?.lang);
    });
  }
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
  captions.stop();
  video.playbackRate = 1;
  media = null;
  video.onplaying = video.onerror = video.onloadedmetadata = video.onseeked = video.onwaiting = null;
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

// ------------------------------------------------------------------ locked channels

const unlockedHere = new Set();

/** Locked and not unlocked in this session. Reads the channel and /api/now flags. */
function isLocked(ch, info) {
  const locked = info?.channel?.locked ?? info?.locked ?? ch.locked;
  const unlocked = info?.channel?.unlocked ?? info?.unlocked ?? ch.unlocked;
  return !!locked && !unlocked && !unlockedHere.has(ch.id);
}

function showLocked(ch, info) {
  tv.route = "card";
  stopMedia();
  synthStop();
  if (cards.lockedCard) cards.lockedCard(ch, info);
  else messageCard(ch, "Locked", "This channel is locked", "Enter the PIN to watch it.");
  if (info) setBanner(ch, info, tv.route);
}

// The PIN entry fires this. Unlocking is global (detail.channelId is null), so the
// server's flags decide from here on; we just re-tune the channel on screen.
addEventListener("debridtv:unlocked", (e) => {
  const id = e.detail?.channelId ?? null;
  if (id) unlockedHere.add(id);
  for (const c of tv.channels) if (!id || c.id === id) c.unlocked = true;
  if (tv.current && (!id || tv.current.id === id)) tune(tv.current, { silent: true });
});

// ------------------------------------------------------------------ audio and captions

const captions = new Captions(video);
captions.onUnsupported = () => toast("Captions need a newer DebridTV server.");

/** Restart the current program with another track choice, at the live point. */
function replay(m, sel) {
  if (media !== m || m.my !== token) return;
  staticOn();
  playMedia(m.ch, m.info, m.my, sel);
}

/** A key: next audio track. Remembers the language for the next programs too. */
export async function cycleAudio() {
  const m = media;
  if (!m) return osd("AUDIO", tv.route === "demo" ? "Demo channels have one track" : "Nothing playing", 1500);
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return;
  const list = audioTracks(tracks);
  if (list.length < 2) return osd("AUDIO", list[0] ? `${trackLabel(list[0])} · only track` : "Only one track", 2000);
  if (!tv.ffmpeg) return osd("AUDIO", "Switching tracks needs compatibility mode (install ffmpeg)", 3000);
  const cur = m.sel?.audio ?? defaultAudio(tracks);
  const i = (list.findIndex((t) => t.index === cur) + 1) % list.length;
  const next = list[i];
  setPref("audioLang", next.lang && next.lang !== "und" ? next.lang : null);
  osd(`AUDIO ${i + 1}/${list.length}`, trackLabel(next), 2500);
  const sel = { ...(m.sel ?? { sub: null, burn: false }), audio: next.index === defaultAudio(tracks) ? null : next.index };
  replay(m, sel);
}

/** C key: captions off → each subtitle track → off. */
export async function cycleCaptions() {
  const m = media;
  if (!m) return osd("CC", tv.route === "demo" ? "Demo channels have no captions" : "Nothing playing", 1500);
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return;
  const list = subTracks(tracks);
  if (!list.length) return osd("CC", "No captions for this program", 2000);
  if (!tv.ffmpeg) return osd("CC", "Captions need compatibility mode (install ffmpeg)", 3000);
  const at = list.findIndex((t) => t.index === m.sel?.sub);
  const next = list[at + 1] ?? null; // past the last one: off
  setPref("subLang", next ? next.lang && next.lang !== "und" ? next.lang : "any" : "off");
  osd(next ? "CC ON" : "CC OFF", next ? `${trackLabel(next)}${isText(next) ? "" : " · drawn into the picture"}` : "", 2500);
  const sel = { ...(m.sel ?? { audio: null }), sub: next?.index ?? null, burn: next ? !isText(next) : false };
  replay(m, sel);
}

// ------------------------------------------------------------------ picture shape

/**
 * Picture shape (parity N-17a), set by the Z key (main.js) through pref "aspect":
 *   auto — the file's own shape, letterboxed (default)
 *   fill — stretched to the screen
 *   4:3  — a 4:3 set: widescreen pictures are center-cut, like a 90s broadcast
 *   zoom — fills the screen and crops the edges (for 4:3 shows on a wide screen)
 */
export function applyAspect() {
  const mode = pref("aspect") ?? "auto";
  const stage = video.parentElement;
  const W = stage?.clientWidth || innerWidth, H = stage?.clientHeight || innerHeight;
  // The demo canvas paints to whatever box it gets, so only the 4:3 box applies to it.
  for (const el of [video, synthEl]) {
    if (!el) continue;
    const s = el.style;
    s.objectFit = mode === "fill" ? "fill" : mode === "4:3" || mode === "zoom" ? "cover" : "";
    if (mode === "4:3") {
      // The largest 4:3 box that fits, centred.
      const w = Math.min(W, (H * 4) / 3), h = Math.min(H, (W * 3) / 4);
      Object.assign(s, { width: `${w}px`, height: `${h}px`, left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, right: "auto", bottom: "auto" });
    } else Object.assign(s, { width: "", height: "", left: "", top: "", right: "", bottom: "" });
  }
}
addEventListener("resize", () => (pref("aspect") ?? "auto") === "4:3" && applyAspect());
applyAspect();

// ------------------------------------------------------------------ sign-off

initSignOff({
  // Drop every stream and timer: nothing is fetched until the viewer is back.
  stop() {
    token++;
    clearTimeout(boundary);
    clearTimeout(stallTimer);
    stopMedia();
    synthStop();
    staticOff();
    hideCard();
    setPaused(false, { quiet: true });
  },
  // Back on the air, live, on the same channel.
  resume() {
    if (tv.current) tune(tv.current, { silent: true });
  },
});
