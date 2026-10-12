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
import { musicShow, musicHide } from "./music.js";
import { tracksFor, selectionFor, needsCompat, selectionQuery, audioTracks, subTracks, defaultAudio, isText, trackLabel, Captions } from "./tracks.js";

const video = document.getElementById("video");
const synthEl = document.getElementById("synth");
const pausedEl = document.getElementById("paused");

// onDemand is { itemId, fromMs, durationMs, title, positionMs } while On Demand plays (parity N-30), else null.
export const tv = { channels: [], current: null, last: null, info: null, route: "card", ffmpeg: false, paused: false, onDemand: null };

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
  endOnDemand();
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
  if (tv.onDemand) return toggleOnDemandPause();
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
  } else if (a.provider === "demo" && a.kind === "track") {
    // A demo music channel: the music screen with stand-in levels, no sound.
    tv.route = "demo";
    synthStop();
    musicShow(a, ch, { posMs: filePos, demo: true });
    staticOff();
    startWatch(a.itemId, ch.id);
  } else if (a.provider === "demo") {
    tv.route = "demo";
    musicHide();
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
// Compatibility mode sends AAC sound. Chromium builds without AAC (Linux distros,
// test browsers) ask for Opus instead.
const aacOk = !!probeEl.canPlayType('audio/mp4; codecs="mp4a.40.2"');

/** Direct play when the browser can decode the file as-is, else ffmpeg compatibility mode. */
function chooseRoute(a) {
  const c = a.codecs || {};
  const audio = Array.isArray(c.audio) ? c.audio[0] : c.audio;
  // A music track (N-23a) has no picture; any container the browser can open will do.
  if (a.kind === "track") return !audio || AUDIO_OK.has(audio) || !tv.ffmpeg ? "direct" : "live";
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
  if (a.kind === "track") musicShow(a, ch, { posMs: filePos });
  applyVolume();
  const onPlaying = () => {
    if (my !== token) return;
    clearTimeout(stallTimer);
    staticOff();
    startWatch(a.itemId, info.onDemand ? "ondemand" : ch.id);
  };
  // At the end of an On Demand file, the station is still on the air: go back to it.
  video.onended = info.onDemand ? () => my === token && media?.itemId === a.itemId && backToLive() : null;
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
    // A home-network device that was un-paired mid-program gets a 401 the page can't
    // see on /media; ask who we are now, and go to pairing instead of an error card.
    if (await unpaired()) return location.replace("/pair");
    if (my !== token) return;
    if (!info.onDemand && isLocked(ch, info)) return staticOff(), showLocked(ch, info);
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
    if (info.onDemand) {
      // Same answers as live, all final; On Demand just says so and returns to the station.
      if (status === 403) return onDemandFailed(LOCKED_OD);
      if (item?.availability === "policy-blocked") return onDemandFailed(POLICY_OD);
      if (item?.availability === "unavailable") return onDemandFailed(`${item.availabilityReason ?? "The provider couldn't serve this file"}.`);
    }
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
      if (!info.onDemand) setBanner(ch, info, tv.route);
      return startLive(offsetAt(), a, onPlaying, onError);
    }
    staticOff();
    if (info.onDemand) return onDemandFailed(tv.ffmpeg ? "The browser couldn't play this file, even in compatibility mode." : "Your browser can't play this file's format. Installing ffmpeg turns on compatibility mode.");
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
    if (info.onDemand) return onDemandFailed(`This browser can't decode ${String(a.codecs?.video ?? "this").toUpperCase()} or H.264 video. Chrome or Edge can.`);
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
  video.src = `/media/${encodeURIComponent(a.itemId)}/live?start=${(offsetMs / 1000).toFixed(2)}&v=${v}&tok=${tok}${aacOk ? "" : "&ac=opus"}${capQuery()}${selectionQuery(m.sel)}`;
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
  // On Demand has no station to catch up with: it just starts on that keyframe.
  if (startMs != null && m.info.onDemand) return void (m.liveStart = startMs);
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

/**
 * Transcode cap (parity N-19): when compatibility mode has to convert the picture,
 * pref "compatMaxHeight" (720 or 1080; unset = up to 1080) limits its size, for
 * PCs that can't convert 4K in real time. A copied picture is never scaled.
 */
function capQuery() {
  const h = Number(pref("compatMaxHeight"));
  return h === 720 || h === 1080 ? `&maxh=${h}` : "";
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
  musicHide();
  captions.stop();
  video.playbackRate = 1;
  media = null;
  clearTimeout(seekTimer);
  video.onplaying = video.onerror = video.onloadedmetadata = video.onseeked = video.onwaiting = video.onended = null;
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
  if (odDemo) return demoPos();
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

// ------------------------------------------------------------------ On Demand

// On Demand (parity N-30) plays one file from any point, off the station clock.
// It uses the same route choice and the same final answers (403, 409, 451) as
// live. The station keeps running underneath: any tune, backToLive() or the end
// of the file returns to whatever is on the air now. B draws the browser, banner
// and OSD; this is only the playback side.

const LOCKED_OD = "That program is locked. Enter the PIN on its channel to watch it.";
const POLICY_OD = "Your provider refused this file. DebridTV won't retry it or fetch it from anywhere else.";
const OD_CH = { id: "ondemand", name: "On Demand", number: 0, hue: 220 };
let odItem = null; // the /api/item answer for the file On Demand is playing
let seekTimer = 0;
let pausedAt = 0;

/** A /api/now-shaped answer for one file at one position, so playMedia can play it. */
function odInfo(item, fromMs) {
  return {
    onDemand: true,
    now: now(),
    fileOffsetMs: fromMs,
    segment: { kind: "program" },
    airing: { itemId: item.id, title: item.title, provider: item.provider, availability: item.availability, end: 0,
      codecs: { container: item.container, video: item.video, audio: item.audio } },
  };
}

/**
 * opts.item is the On Demand listing's item when the caller has it (title,
 * episode label, genre); the server's /api/item still decides what can play.
 */
export async function playOnDemand(itemId, { fromMs = 0, item: listed = null } = {}) {
  if (!itemId || signedOff()) return;
  const my = ++token;
  clearTimeout(boundary);
  clearTimeout(stallTimer);
  flushWatch(true);
  if (odDemo) clearTimeout(odDemo.endTimer), (odDemo = null);
  setPaused(false, { quiet: true });
  click();
  staticOn();
  stopMedia();
  synthStop();
  hideCard();
  osdHide();
  let item;
  try {
    item = await api.get(`/api/item?id=${encodeURIComponent(itemId)}`);
  } catch (e) {
    if (my !== token) return;
    return onDemandFailed(e.status === 403 ? LOCKED_OD : e.status === 404 ? "That file isn't in the library any more." : `Can't reach the DebridTV server (${e.message}).`);
  }
  if (my !== token) return;
  if (item.availability === "policy-blocked") return onDemandFailed(POLICY_OD);
  if (item.availability === "unavailable") return onDemandFailed(`${item.availabilityReason ?? "The provider couldn't serve this file"}.`);
  const durationMs = item.durationMs ?? 0;
  // Starting in the last few seconds would end at once; start a little earlier.
  const from = Math.round(clamp(Number(fromMs) || 0, 0, durationMs > 10_000 ? durationMs - 5000 : 0));
  odItem = item;
  tv.onDemand = {
    itemId: item.id, fromMs: from, durationMs, title: listed?.title ?? item.title,
    /** Where the picture is now, in file ms (or where a pending seek is heading). */
    get positionMs() {
      if (odDemo) return demoPos();
      return media?.seekTarget ?? filePos() ?? media?.info?.fileOffsetMs ?? from;
    },
  };
  dispatchEvent(new CustomEvent("debridtv:ondemand", { detail: tv.onDemand }));
  if (item.provider === "demo") return startDemoOnDemand(item, listed, from);
  playMedia(OD_CH, odInfo(item, from), my);
}

// Demo files have no media: the picture is painted from the file position, as on
// live demo channels, so the demo's On Demand is watchable end to end.
let odDemo = null; // { airing, pos, t0, paused, endTimer }

function demoPos() {
  return odDemo.pos + (odDemo.paused ? 0 : performance.now() - odDemo.t0);
}

function startDemoOnDemand(item, listed, from) {
  const l = listed ?? {};
  const airing = { itemId: item.id, provider: "demo", title: l.title ?? item.title, kind: l.kind ?? "episode", genre: l.genre ?? item.genre,
    episode: l.label ?? (l.episode != null ? `S${l.season} · E${l.episode}` : undefined), subtitle: l.subtitle, year: l.year, durationMs: tv.onDemand.durationMs };
  odDemo = { airing, pos: from, t0: performance.now(), paused: false, endTimer: 0 };
  tv.route = "demo";
  demoRun();
  staticOff();
}

/** (Re)start the painted picture at odDemo.pos and set the end-of-file timer. */
function demoRun() {
  const d = odDemo;
  clearTimeout(d.endTimer);
  d.t0 = performance.now();
  d.paused = false;
  synthStart(d.airing, d.pos);
  startWatch(d.airing.itemId, "ondemand");
  const left = (tv.onDemand?.durationMs || Infinity) - d.pos;
  if (Number.isFinite(left)) d.endTimer = setTimeout(() => odDemo === d && backToLive(), Math.max(0, left));
}

/** Back to the live airing on the channel we came from. */
export function backToLive() {
  if (tv.current) return tune(tv.current);
  token++;
  endOnDemand();
  stopMedia();
  staticOff();
}

/**
 * Left/Right in On Demand. A direct file seeks in place. A compatibility stream
 * can't seek, so it restarts at the new point once the presses settle (400 ms),
 * which keeps a run of presses to one ffmpeg start.
 */
export function seekBy(deltaMs) {
  const m = media;
  if (!tv.onDemand) return;
  const end = tv.onDemand.durationMs ? tv.onDemand.durationMs - 1000 : Infinity;
  const target = Math.round(clamp(tv.onDemand.positionMs + deltaMs, 0, Math.max(0, end)));
  if (odDemo) {
    flushWatch(true);
    odDemo.pos = target;
    setPaused(false, { quiet: true });
    return demoRun();
  }
  if (!m || m.my !== token) return;
  m.seekTarget = target;
  if (m.route === "direct") {
    flushWatch(true);
    video.onseeked = () => {
      if (media !== m) return;
      m.seekTarget = null;
      if (!tv.paused) startWatch(m.itemId, "ondemand");
    };
    video.currentTime = target / 1000;
    return;
  }
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    if (media !== m || m.my !== token) return;
    setPaused(false, { quiet: true });
    staticOn();
    playMedia(OD_CH, odInfo(odItem, target), m.my, m.sel);
  }, 400);
}

function toggleOnDemandPause() {
  const m = media;
  if (!tv.paused) {
    pausedAt = performance.now();
    if (odDemo) {
      setPaused(true); // flushes the watch span first, then freezes the picture
      odDemo.pos = demoPos();
      odDemo.paused = true;
      return clearTimeout(odDemo.endTimer);
    }
    return setPaused(true);
  }
  setPaused(false);
  if (odDemo) return demoRun();
  if (!m) return;
  // A compatibility stream left paused for long may have been dropped along the
  // way; restart it where the viewer paused rather than risk a dead stream.
  if (m.route === "live" && performance.now() - pausedAt > 30_000) {
    staticOn();
    return playMedia(OD_CH, odInfo(odItem, filePos() ?? m.info.fileOffsetMs), m.my, m.sel);
  }
  video.play().catch(() => autoplayHint());
}

function endOnDemand() {
  if (!tv.onDemand) return;
  if (odDemo) {
    flushWatch(true);
    clearTimeout(odDemo.endTimer);
    odDemo = null;
    synthStop();
  }
  tv.onDemand = null;
  odItem = null;
  clearTimeout(seekTimer);
  dispatchEvent(new CustomEvent("debridtv:ondemand", { detail: null }));
}

/** A final answer for an On Demand file: say why, then go back to the station. */
function onDemandFailed(why) {
  toast(why);
  backToLive();
}

// ------------------------------------------------------------------ home network

/** True when this browser is no longer a paired device (its pairing was revoked). */
async function unpaired() {
  try {
    const r = await fetch("/api/lan/hello", { cache: "no-store" });
    if (r.status === 401) return true;
    return r.ok && (await r.json())?.where === "stranger";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ locked channels

const unlockedHere = new Set();

/**
 * Locked unless something says it was unlocked. Any source can lock (the channel,
 * /api/now, the airing); any source can unlock (the server's flag, or the PIN entry's
 * event in this page). Erring towards "unlocked" is safe: the server still answers a
 * locked item's link or media request with a final 403, which shows the locked card.
 */
function isLocked(ch, info) {
  const locked = !!(info?.channel?.locked || info?.locked || info?.airing?.locked || ch.locked);
  const unlocked = !!(info?.channel?.unlocked || info?.unlocked || ch.unlocked || unlockedHere.has(ch.id));
  return locked && !unlocked;
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
  if (tv.current && !tv.onDemand && (!id || tv.current.id === id)) tune(tv.current, { silent: true });
});

// ------------------------------------------------------------------ audio and captions

const captions = new Captions(video);
captions.onUnsupported = () => toast("Captions need a newer DebridTV server.");

/** Restart the current program with another track choice, at the live point. */
function replay(m, sel) {
  if (media !== m || m.my !== token) return;
  staticOn();
  // On Demand picks up where the viewer is, not where it started.
  playMedia(m.ch, m.info.onDemand ? odInfo(odItem, filePos() ?? m.info.fileOffsetMs) : m.info, m.my, sel);
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

/**
 * What the subtitles menu (captions.js) offers for the program on screen:
 * { why } when there is nothing to choose from, else the program's tracks and the
 * ones playing now (subNow null = subtitles off).
 */
export async function trackChoices() {
  const m = media;
  if (!m) return { why: tv.route === "demo" ? "Demo channels have no subtitles." : "Nothing is playing right now." };
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return trackChoices();
  return {
    why: null,
    ffmpeg: !!tv.ffmpeg,
    audio: audioTracks(tracks),
    subs: subTracks(tracks),
    audioNow: m.sel?.audio ?? defaultAudio(tracks),
    subNow: m.sel?.sub ?? null,
  };
}

const langOf = (t) => (t.lang && t.lang !== "und" ? t.lang : "any");

/**
 * Subtitles on (a track's index) or off (null) for this program. The language is
 * remembered, so the next program and the next channel start the same way.
 */
export async function pickSubtitle(index) {
  const m = media;
  if (!m) return;
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return;
  const t = index == null ? null : subTracks(tracks).find((x) => x.index === index);
  if (t) setPref("subLast", langOf(t));
  setPref("subLang", t ? langOf(t) : "off");
  if (!tv.ffmpeg || (m.sel?.sub ?? null) === (t?.index ?? null)) return;
  osd(t ? "CC ON" : "CC OFF", t ? `${trackLabel(t)}${isText(t) ? "" : " · drawn into the picture"}` : "", 2500);
  replay(m, { ...(m.sel ?? { audio: null }), sub: t?.index ?? null, burn: t ? !isText(t) : false });
}

/** Another audio track for this program; its language carries over too. */
export async function pickAudio(index) {
  const m = media;
  if (!m) return;
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return;
  const t = audioTracks(tracks).find((x) => x.index === index);
  if (!t) return;
  setPref("audioLang", t.lang && t.lang !== "und" ? t.lang : null);
  const cur = m.sel?.audio ?? defaultAudio(tracks);
  if (!tv.ffmpeg || cur === t.index) return;
  osd("AUDIO", trackLabel(t), 2500);
  replay(m, { ...(m.sel ?? { sub: null, burn: false }), audio: t.index === defaultAudio(tracks) ? null : t.index });
}

/**
 * The remote's Subtitle button: off ⇄ on, in the language used last (else the
 * program's first full track).
 */
export async function toggleCaptions() {
  const m = media;
  if (!m) return osd("CC", tv.route === "demo" ? "Demo channels have no subtitles" : "Nothing playing", 1500);
  const tracks = await tracksFor(m.itemId);
  if (media !== m) return;
  const list = subTracks(tracks);
  if (m.sel?.sub != null) return pickSubtitle(null);
  if (!list.length) return osd("CC", "No subtitles for this program", 2000);
  if (!tv.ffmpeg) return osd("CC", "Subtitles need compatibility mode (install ffmpeg)", 3000);
  const last = pref("subLast");
  const same = list.filter((t) => !last || last === "any" || t.lang === last);
  const pick = same.find((t) => !t.forced && isText(t)) ?? same.find((t) => !t.forced) ?? list.find((t) => !t.forced) ?? list[0];
  return pickSubtitle(pick.index);
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
    endOnDemand();
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
