// Music channels (parity N-23a). A music airing is one audio file ("track") on
// the station clock. The <video> element plays it like any program, so tuning,
// station time, pause, errors and watch history all work unchanged; this file
// only draws what's on screen: a record sleeve, the track details and a hi-fi
// spectrum analyser in the theme's colours.
//
// The analyser needs Web Audio, which browsers keep suspended until the first
// key or click. The video's sound is only routed through Web Audio once the
// context runs (routing into a suspended context would silence the TV); until
// then the bars dance to a gentle stand-in so the screen never looks dead.

import { html } from "./util.js";
import { artOf } from "./ui.js";

const video = document.getElementById("video");
const BARS = 48;

let el = null;
let canvas = null;
let g = null;
let raf = 0;
let state = null; // { a, ch, hue, posMs(), durationMs, levels, peaks, peakHold }
let actx = null;
let analyser = null;
let freq = null;
let routed = false;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const fmt = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "–:––";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ------------------------------------------------------------------ audio

function wake() {
  if (routed || !state) return;
  try {
    actx ??= new AudioContext();
  } catch {
    return;
  }
  if (actx.state !== "running") {
    actx.resume().then(() => state && wake(), () => {});
    return;
  }
  try {
    const src = actx.createMediaElementSource(video);
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    freq = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    analyser.connect(actx.destination);
    routed = true;
    // Once routed, the TV's sound depends on this context: keep it running.
    actx.onstatechange = () => actx.state === "suspended" && actx.resume().catch(() => {});
  } catch {}
}
for (const type of ["keydown", "pointerdown"]) addEventListener(type, wake, { capture: true, passive: true });

/** Bar heights 0..1, log-spaced from 40 Hz to 16 kHz, or a stand-in when Web Audio isn't running. */
function sample(t) {
  const out = new Float32Array(BARS);
  const playing = state.demo || (!video.paused && video.readyState >= 2);
  if (routed && !state.demo && analyser && actx?.state === "running") {
    analyser.getByteFrequencyData(freq);
    const nyq = actx.sampleRate / 2;
    for (let i = 0; i < BARS; i++) {
      const f0 = 40 * Math.pow(16000 / 40, i / BARS), f1 = 40 * Math.pow(16000 / 40, (i + 1) / BARS);
      const b0 = Math.floor((f0 / nyq) * freq.length), b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * freq.length));
      let m = 0;
      for (let b = b0; b < b1 && b < freq.length; b++) m = Math.max(m, freq[b]);
      // A gentle tilt so the treble isn't always flat on the floor.
      out[i] = Math.min(1, (m / 255) * (0.82 + 0.35 * (i / BARS)));
    }
    return out;
  }
  if (!playing) return out;
  // Stand-in: a soft beat at about 112 bpm with a drifting melody band.
  const beat = Math.pow(Math.max(0, Math.cos((t / 1000) * Math.PI * (112 / 60))), 6);
  const seed = state.hue;
  for (let i = 0; i < BARS; i++) {
    const x = i / BARS;
    const body = 0.55 * Math.exp(-x * 2.6) + 0.18;
    const melody = 0.25 * Math.exp(-Math.pow((x - (0.35 + 0.15 * Math.sin(t / 2300 + seed))) * 9, 2));
    const shimmer = 0.08 * (Math.sin(t / 97 + i * 1.7) + Math.sin(t / 61 + i * 0.9));
    out[i] = Math.max(0, Math.min(1, body * (0.55 + 0.45 * beat) + melody + shimmer));
  }
  return out;
}

// ------------------------------------------------------------------ view

const css = `
#music { position: absolute; inset: 0; overflow: hidden; background: #000; color: var(--ink); font-family: var(--body); --h: 220; }
#music .mu-bg { position: absolute; inset: -10%; background:
    radial-gradient(60% 55% at 25% 30%, hsl(var(--h) 70% 28% / .85), transparent 70%),
    radial-gradient(55% 50% at 80% 70%, hsl(calc(var(--h) + 60) 70% 24% / .7), transparent 70%),
    linear-gradient(160deg, var(--bg), #000 75%);
  filter: blur(calc(var(--u) * 2)); animation: mu-drift 38s ease-in-out infinite alternate; }
#music canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
#music .mu-now { position: absolute; left: 8%; right: 8%; top: 17%; display: grid; grid-template-columns: auto 1fr; gap: calc(var(--u) * 3); align-items: center; }
#music .mu-deck { --s: min(34vh, 26vw); position: relative; width: calc(var(--s) * 1.4); height: var(--s); }
#music .mu-disc { position: absolute; top: 4%; left: calc(var(--s) * .44); width: calc(var(--s) * .92); aspect-ratio: 1; border-radius: 50%;
  background: radial-gradient(circle, hsl(var(--h) 70% 55%) 0 15%, #111 15.5% 17%, transparent 17.5%),
    repeating-radial-gradient(circle, #0c0c0e 0 1.2px, #19191d 1.6px 2.6px);
  box-shadow: 0 0 calc(var(--u) * 2) rgba(0,0,0,.7); animation: mu-spin 1.8s linear infinite; animation-play-state: paused; }
#music .mu-disc::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 30deg, transparent 0 20%, rgba(255,255,255,.08) 25%, transparent 32% 70%, rgba(255,255,255,.06) 75%, transparent 82%); }
#music.playing .mu-disc { animation-play-state: running; }
#music .mu-sleeve { position: absolute; left: 0; top: 0; width: var(--s); height: var(--s); border-radius: calc(var(--radius) * .6); overflow: hidden; box-shadow: 0 calc(var(--u) * 1) calc(var(--u) * 3) rgba(0,0,0,.65), inset 0 0 0 1px rgba(255,255,255,.08);
  background: linear-gradient(135deg, hsl(var(--h) 75% 52%), hsl(calc(var(--h) + 50) 70% 30%)); display: grid; place-items: center; }
#music .mu-sleeve img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
#music .mu-mono { font-family: var(--display); font-weight: 800; font-size: min(15vh, 13vw); letter-spacing: -.02em; color: rgba(255,255,255,.9); text-shadow: 0 .05em .2em rgba(0,0,0,.35); }
#music .mu-meta { min-width: 0; display: grid; gap: calc(var(--u) * .5); }
#music .mu-kicker { font-family: var(--display); text-transform: uppercase; letter-spacing: .2em; font-size: calc(var(--u) * 1); color: var(--amber); display: flex; align-items: center; gap: .6em; }
#music .mu-kicker i { width: .55em; height: .55em; border-radius: 50%; background: var(--bad); box-shadow: 0 0 .6em var(--bad); }
#music.playing .mu-kicker i { animation: mu-blink 1.2s steps(2, start) infinite; }
#music .mu-title { font-family: var(--display); font-weight: 800; font-size: clamp(28px, 7vh, 96px); line-height: .95; overflow-wrap: anywhere; text-wrap: balance; }
#music .mu-artist { font-size: clamp(18px, 3.4vh, 44px); font-weight: 600; }
#music .mu-album { font-size: clamp(14px, 2.3vh, 30px); color: var(--dim); }
#music .mu-time { margin-top: calc(var(--u) * 1.2); display: grid; grid-template-columns: auto 1fr auto; gap: calc(var(--u) * .8); align-items: center; font-family: var(--mono); font-size: clamp(18px, 2.8vh, 36px); color: var(--osd); }
#music .mu-bar { height: calc(var(--u) * .35); border-radius: 99px; background: var(--line); overflow: hidden; }
#music .mu-bar b { display: block; height: 100%; width: calc(var(--p, 0) * 100%); background: linear-gradient(90deg, var(--cyan), var(--magenta)); }
@keyframes mu-spin { to { transform: rotate(360deg); } }
@keyframes mu-drift { to { transform: translate(3%, -2%) scale(1.06); } }
@keyframes mu-blink { 50% { opacity: .2; } }
@media (max-aspect-ratio: 1/1) { #music .mu-now { grid-template-columns: 1fr; justify-items: start; top: 8%; } }
@media (prefers-reduced-motion: reduce) { #music .mu-bg, #music .mu-disc, #music .mu-kicker i { animation: none !important; } }
`;

function mount() {
  if (el) return;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  el = document.createElement("div");
  el.id = "music";
  el.hidden = true;
  el.setAttribute("aria-live", "polite");
  // Above the picture, under the cards, static, OSD and banner.
  (document.getElementById("synth") ?? video).after(el);
}

/**
 * Show the music screen for a track airing.
 * hooks.posMs() gives the file position on screen (null before it plays).
 */
export function musicShow(a, ch, hooks) {
  mount();
  // One colour per album, so a run of tracks from it keeps the same look.
  const hue = hash(`${a.artist ?? ""}|${a.album ?? a.title ?? ""}`) % 360;
  state = { a, ch, hue, posMs: hooks.posMs, demo: !!hooks.demo, durationMs: a.durationMs ?? (a.end && a.start ? a.end - a.start : 0), peaks: new Float32Array(BARS), held: new Float32Array(BARS), levels: new Float32Array(BARS) };
  const cover = artOf(a, "cover", "poster", "thumb", "fanart");
  const initials = String(a.artist || a.title || "♪").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const album = [a.album, a.year].filter(Boolean).join(" · ");
  el.style.setProperty("--h", String(hue));
  el.innerHTML = html`<div class="mu-bg"></div><canvas></canvas>
    <div class="mu-now">
      <div class="mu-deck"><div class="mu-disc"></div><div class="mu-sleeve" data-art-box><span class="mu-mono">${initials}</span>${cover ? html`<img src="${cover}" alt="" decoding="async" data-art>` : ""}</div></div>
      <div class="mu-meta">
        <div class="mu-kicker"><i></i>Now playing${ch?.name ? html` · ${ch.name}` : ""}</div>
        <div class="mu-title">${a.title ?? "Untitled"}</div>
        ${a.artist ? html`<div class="mu-artist">${a.artist}</div>` : ""}
        ${album ? html`<div class="mu-album">${album}</div>` : ""}
        <div class="mu-time"><span data-at>0:00</span><div class="mu-bar"><b></b></div><span data-len>${state.durationMs ? fmt(state.durationMs) : "–:––"}</span></div>
      </div>
    </div>`;
  el.querySelector("img[data-art]")?.addEventListener("error", (e) => e.target.remove());
  canvas = el.querySelector("canvas");
  g = canvas.getContext("2d");
  el.hidden = false;
  wake();
  cancelAnimationFrame(raf);
  let last = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = (t) => {
    if (!state) return;
    raf = requestAnimationFrame(frame);
    if (reduced && t - last < 250) return;
    last = t;
    draw(t);
  };
  raf = requestAnimationFrame(frame);
}

export function musicHide() {
  state = null;
  cancelAnimationFrame(raf);
  if (!el) return;
  el.hidden = true;
  el.innerHTML = "";
  canvas = g = null;
}

export const musicShowing = () => !!state;

let colors = null;
let colorsAt = 0;
function themeColors() {
  // Themes can change while music plays; re-read the palette now and then.
  if (colors && performance.now() - colorsAt < 2000) return colors;
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => cs.getPropertyValue(n).trim() || d;
  colors = { lo: v("--cyan", "#4fe3ff"), mid: v("--magenta", "#ff5fa2"), hi: v("--amber", "#ffb547"), cap: v("--ink", "#fff") };
  colorsAt = performance.now();
  return colors;
}

function draw(t) {
  const s = state;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) (canvas.width = W), (canvas.height = H);
  g.clearRect(0, 0, W, H);

  const target = sample(t);
  const playing = s.demo || (!video.paused && video.readyState >= 2);
  el.classList.toggle("playing", playing);
  const c = themeColors();
  const base = H * 0.86, maxH = H * 0.3;
  const gap = W * 0.004, left = W * 0.08, span = W * 0.84;
  const bw = span / BARS - gap;
  const grad = g.createLinearGradient(0, base, 0, base - maxH);
  grad.addColorStop(0, c.lo);
  grad.addColorStop(0.55, c.mid);
  grad.addColorStop(1, c.hi);
  for (let i = 0; i < BARS; i++) {
    // Fast attack, slow release, like a hardware meter.
    const lv = (s.levels[i] = target[i] > s.levels[i] ? target[i] : s.levels[i] * 0.9 + target[i] * 0.1);
    if (lv >= s.peaks[i]) (s.peaks[i] = lv), (s.held[i] = t);
    else if (t - s.held[i] > 500) s.peaks[i] = Math.max(0, s.peaks[i] - 0.012);
    const x = left + i * (bw + gap);
    // Segmented LED bars.
    const seg = Math.max(3 * dpr, maxH / 22), lit = Math.round((lv * maxH) / seg);
    g.fillStyle = grad;
    for (let k = 0; k < lit; k++) g.fillRect(x, base - (k + 1) * seg + dpr, bw, seg - 2 * dpr);
    // Reflection on the "floor".
    g.globalAlpha = 0.14;
    for (let k = 0; k < Math.min(lit, 6); k++) g.fillRect(x, base + k * seg + dpr, bw, seg - 2 * dpr);
    g.globalAlpha = 1;
    if (s.peaks[i] > 0.02) {
      g.fillStyle = c.cap;
      g.fillRect(x, base - s.peaks[i] * maxH - 2 * dpr, bw, 2 * dpr);
    }
  }

  const pos = s.posMs();
  const len = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : s.durationMs;
  const at = el.querySelector("[data-at]");
  if (at && pos != null) at.textContent = fmt(pos);
  const ln = el.querySelector("[data-len]");
  if (ln && len) ln.textContent = fmt(len);
  el.querySelector(".mu-bar b")?.style.setProperty("--p", String(pos != null && len ? Math.min(1, pos / len) : 0));
}
