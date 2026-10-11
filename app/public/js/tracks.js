// Audio and caption choice (parity N-18a). The probe lists each file's tracks
// (/api/item → tracks, indexed per kind). Browsers only play a file's default
// audio and can't show subtitles from inside an MKV, so picking another audio
// track or any captions moves that program to compatibility mode, where ffmpeg
// maps the chosen tracks from the same single read of the file. Choices are
// remembered by language, so the next program speaks the same language.

import { api } from "./api.js";
import { pref } from "./util.js";

const TEXT_SUBS = new Set(["srt", "subrip", "ass", "ssa", "webvtt", "mov_text", "ttml", "text"]);
const cache = new Map();

/** Tracks for an item, fetched once per item (a local call, no provider traffic). */
export function tracksFor(itemId) {
  let p = cache.get(itemId);
  if (!p) {
    p = api.get(`/api/item?id=${encodeURIComponent(itemId)}`).then((it) => it.tracks ?? [], () => (cache.delete(itemId), []));
    cache.set(itemId, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
  }
  return p;
}

export const audioTracks = (tracks) => tracks.filter((t) => t.kind === "audio");
export const subTracks = (tracks) => tracks.filter((t) => t.kind === "subtitle");
export const isText = (t) => TEXT_SUBS.has(String(t?.codec ?? "").toLowerCase());

/** The audio track a browser plays on its own: the one flagged default, else the first. */
export function defaultAudio(tracks) {
  const a = audioTracks(tracks);
  return (a.find((t) => t.default) ?? a[0])?.index ?? 0;
}

/**
 * What to play for this program given the remembered languages:
 * { audio: index | null (the file's default), sub: index | null (off), burn }.
 */
export function selectionFor(tracks) {
  const sel = { audio: null, sub: null, burn: false };
  const lang = pref("audioLang");
  if (lang) {
    const a = audioTracks(tracks).filter((t) => t.lang === lang);
    const pick = a.find((t) => t.default) ?? a[0];
    if (pick && pick.index !== defaultAudio(tracks)) sel.audio = pick.index;
  }
  const sub = pref("subLang");
  if (sub && sub !== "off") {
    const s = subTracks(tracks).filter((t) => sub === "any" || t.lang === sub);
    // Prefer full captions over "forced" (signs-and-foreign-lines-only) tracks.
    const pick = s.find((t) => !t.forced && isText(t)) ?? s.find((t) => !t.forced) ?? s[0];
    if (pick) {
      sel.sub = pick.index;
      sel.burn = !isText(pick);
    }
  }
  return sel;
}

export const needsCompat = (sel) => sel.audio != null || sel.sub != null;

/** Query string for the compatibility stream. */
export function selectionQuery(sel) {
  if (!sel) return "";
  return (sel.audio != null ? `&a=${sel.audio}` : "") + (sel.sub != null ? `&s=${sel.sub}${sel.burn ? "&burn=1" : ""}` : "");
}

// ------------------------------------------------------------------ labels

const ISO2 = { eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", jpn: "ja", por: "pt", rus: "ru", chi: "zh", zho: "zh",
  kor: "ko", dut: "nl", nld: "nl", swe: "sv", nor: "no", nob: "nb", dan: "da", fin: "fi", pol: "pl", tur: "tr", ara: "ar", hin: "hi", heb: "he",
  gre: "el", ell: "el", cze: "cs", ces: "cs", hun: "hu", rum: "ro", ron: "ro", tha: "th", vie: "vi", ind: "id", ukr: "uk", cat: "ca" };
let names = null;
try {
  names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
} catch {}

export function langName(code) {
  if (!code || code === "und") return "";
  const c = ISO2[code.toLowerCase()] ?? code;
  try {
    return names?.of(c) ?? code;
  } catch {
    return code;
  }
}

export function trackLabel(t) {
  if (!t) return "";
  const parts = [langName(t.lang) || t.name || `Track ${t.index + 1}`];
  if (t.name && langName(t.lang) && !t.name.toLowerCase().includes(langName(t.lang).toLowerCase())) parts.push(t.name);
  if (t.forced) parts.push("forced");
  if (t.kind === "audio" && t.codec) parts.push(String(t.codec).toUpperCase());
  return parts.join(" · ");
}

// ------------------------------------------------------------------ captions

/**
 * Text captions from the compatibility stream. ffmpeg writes the chosen subtitle
 * track as it goes; we fetch new cues every 700 ms and show them in TV-style
 * closed-caption boxes. Times share the stream's zero, so they map straight onto
 * the video's own clock.
 */
export class Captions {
  constructor(video) {
    this.video = video;
    this.track = null;
    this.timer = 0;
    this.tok = null;
    this.since = 0;
    this.warned = false;
  }

  start(tok, label, lang) {
    this.stop();
    if (!this.track) {
      this.track = this.video.addTextTrack("captions", label, lang || "");
      styleCues();
    }
    this.track.mode = "showing";
    this.tok = tok;
    this.since = 0;
    let misses = 0;
    const poll = async () => {
      if (this.tok !== tok) return;
      try {
        const r = await fetch(`/api/livesubs?tok=${tok}&since=${this.since}`);
        // The stream registers its tok when ffmpeg starts, so a few early 404s are
        // normal; a server without captions keeps saying 404.
        if (r.status === 404) {
          if (++misses < 8) return void (this.timer = setTimeout(poll, 700));
          if (!this.warned) (this.warned = true), this.onUnsupported?.();
          return;
        }
        const { cues = [], done } = await r.json();
        if (this.tok !== tok) return;
        for (const c of cues) {
          // Times share the stream's zero; lines from before the keyframe it started on are negative.
          if (c.endMs > 0) this.track.addCue(new VTTCue(Math.max(0, c.startMs) / 1000, c.endMs / 1000, c.text));
          this.since = Math.max(this.since, c.n + 1);
        }
        if (done) return;
      } catch {}
      this.timer = setTimeout(poll, 700);
    };
    poll();
  }

  stop() {
    clearTimeout(this.timer);
    this.tok = null;
    if (!this.track) return;
    for (const c of [...(this.track.cues ?? [])]) this.track.removeCue(c);
    this.track.mode = "disabled";
  }
}

let styled = false;
function styleCues() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  // Line-21 closed captions: white mono text on solid black boxes.
  s.textContent = `#video::cue { background: rgba(0,0,0,.9); color: #fff; font-family: VT323, ui-monospace, Consolas, monospace;
    font-size: clamp(20px, 4.4vh, 56px); line-height: 1.15; text-shadow: none; }
  #video::-webkit-media-text-track-display { padding: 0 .3em; }`;
  document.head.append(s);
}
