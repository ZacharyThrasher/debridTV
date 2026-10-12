// Demo programs. Demo items have no media at all, so the picture is painted here:
// a program slate tinted by the show's genre, kept in step with the *file position*
// (tune away and back and you land exactly where the station is), with a burned-in
// timecode so the station clock is visible on screen. Zero provider traffic.

const canvas = document.getElementById("synth");
const ctx = canvas.getContext("2d");
let state = null; // { airing, fileAtStart, t0, scene, hue, seed }
let raf = 0;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
// Each genre leans to a colour family; the show picks a spot in it. Muted on purpose:
// this stands in for a picture, it shouldn't shout over the guide.
const GENRE_HUE = { "Sci-fi": [190, 250], "Newsroom drama": [200, 230], Mystery: [220, 280], Nature: [90, 170], Cooking: [15, 45], Sitcom: [25, 55], Cartoon: [330, 400] };

export function synthStart(airing, fileOffsetMs) {
  const key = airing.title || airing.itemId;
  const seed = hash(key);
  const scene = "field";
  const range = GENRE_HUE[airing.genre] ?? [0, 360];
  const hue = range[0] + (seed % (range[1] - range[0]));
  state = { airing, fileAtStart: fileOffsetMs, t0: performance.now(), scene, hue, seed, tunedAt: performance.now() };
  canvas.style.display = "block";
  resize();
  cancelAnimationFrame(raf);
  loop();
}

export function synthStop() {
  state = null;
  cancelAnimationFrame(raf);
  canvas.style.display = "none";
}

export function synthPaused(p) {
  if (!state) return;
  if (p) state.pausedAt = performance.now();
  else if (state.pausedAt) state.pausedAt = undefined;
}

function resize() {
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
addEventListener("resize", () => state && resize());

function loop() {
  if (!state) return;
  if (!state.pausedAt) draw();
  raf = requestAnimationFrame(loop);
}

function draw() {
  const fileMs = state.fileAtStart + (performance.now() - state.t0);
  ctx.save();
  drawSlate(canvas.width, canvas.height, fileMs);
  ctx.restore();
  overlay(canvas.width, canvas.height, fileMs);
}

// ------------------------------------------------------------------ the picture

// A program slate: the flat card a station runs ahead of a tape. Title, episode and
// running time, a strip of colour bars, and a rule that fills as the program plays, so
// the station keeps visible time. No media, so nothing pretends to be a picture.
const BARS = ["#bfbfbf", "#bfbf00", "#00bfbf", "#00bf00", "#bf00bf", "#bf0000", "#0000bf"]; // SMPTE, 75%

function drawSlate(W, H, fileMs) {
  const { airing, hue } = state;
  const u = H / 60;
  const pad = u * 5;
  ctx.fillStyle = `hsl(${hue} 7% 10%)`;
  ctx.fillRect(0, 0, W, H);
  // colour bars along the top edge
  const bh = Math.max(2, u * 0.5);
  BARS.forEach((c, i) => ((ctx.fillStyle = c), ctx.fillRect((i * W) / 7, 0, W / 7 + 1, bh)));

  ctx.textBaseline = "alphabetic";
  const left = pad;
  const maxW = W - pad * 2;
  // kind and genre, small
  ctx.font = `600 ${u * 1.5}px "Archivo", sans-serif`;
  ctx.fillStyle = "rgba(238,240,241,.55)";
  const kind = airing.kind === "movie" ? "Feature" : airing.kind === "episode" ? "Series" : "Program";
  ctx.fillText([kind, airing.genre, airing.rating].filter(Boolean).join("  ·  "), left, H * 0.36);
  // title, condensed and big; shrinks to fit
  let size = u * 7;
  const setTitle = () => (ctx.font = `700 condensed ${size}px "Archivo", sans-serif`);
  setTitle();
  while (size > u * 3 && ctx.measureText(airing.title).width > maxW) (size -= u * 0.25), setTitle();
  ctx.fillStyle = "#eef0f1";
  ctx.fillText(airing.title, left - u * 0.2, H * 0.36 + size * 1.02);
  // episode line
  ctx.font = `500 ${u * 2}px "Archivo", sans-serif`;
  ctx.fillStyle = "rgba(238,240,241,.75)";
  const sub = [airing.episode, airing.subtitle ? `“${airing.subtitle}”` : null, airing.year].filter(Boolean).join("   ");
  ctx.fillText(sub, left, H * 0.36 + size * 1.02 + u * 3.4);
  // running rule
  const dur = airing.durationMs || 0;
  const y = H * 0.36 + size * 1.02 + u * 6;
  ctx.fillStyle = "rgba(238,240,241,.16)";
  ctx.fillRect(left, y, maxW, Math.max(1, u * 0.15));
  if (dur > 0) {
    ctx.fillStyle = "#f0402f";
    ctx.fillRect(left, y, maxW * Math.min(1, Math.max(0, fileMs / dur)), Math.max(2, u * 0.3));
  }
}

// ------------------------------------------------------------------ overlay

function overlay(W, H, fileMs) {
  const u = H / 60;
  const pad = u * 5;
  // Burned-in timecode: file position, so you can watch the station keep time.
  const fr = Math.floor((fileMs % 1000) / (1000 / 30));
  const tc = `${fmt(fileMs)}:${String(fr).padStart(2, "0")}`;
  // Bottom left, like a VHS counter, so the top-left rating card never sits on it.
  // The info banner covers that corner, so the counter steps aside while it's up.
  if (document.body.classList.contains("banner-open")) return;
  const base = H - u * 3.4;
  ctx.textBaseline = "alphabetic";
  ctx.font = `600 ${u * 1.6}px "Archivo", sans-serif`;
  ctx.fillStyle = "rgba(238,240,241,.8)";
  ctx.fillText(tc, pad, base);
  ctx.font = `500 ${u * 1.1}px "Archivo", sans-serif`;
  ctx.fillStyle = "rgba(238,240,241,.5)";
  ctx.fillText("Demo program. No media is streamed.", pad, base - u * 2.4);
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
