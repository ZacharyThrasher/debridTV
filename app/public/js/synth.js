// Demo programs. Demo items have no media at all, so the picture is painted here:
// a scene chosen from the show's genre, animated purely from the *file position*
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
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  const { airing, scene, hue, seed } = state;
  const W = canvas.width, H = canvas.height;
  const fileMs = state.fileAtStart + (performance.now() - state.t0);
  const t = fileMs / 1000;
  ctx.save();
  drawField(W, H, t, hue, seed);
  ctx.restore();

  // Movies get a letterbox, like a film on broadcast TV.
  if (airing.kind === "movie") {
    ctx.fillStyle = "#000";
    const bar = H * 0.1;
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
  }
  overlay(W, H, fileMs);
}

// ------------------------------------------------------------------ the picture

// A slow colour field: three soft lights drifting over a dark ground, a faint horizon
// and film grain. It moves with the file position, so the station keeps visible time.
let grain = null;
function grainTile() {
  if (grain) return grain;
  grain = document.createElement("canvas");
  grain.width = grain.height = 160;
  const g = grain.getContext("2d");
  const img = g.createImageData(160, 160);
  const r = rng(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(r() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grain;
}

function drawField(W, H, t, hue, seed) {
  const r = rng(seed);
  ctx.fillStyle = `hsl(${hue} 22% 8%)`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const ph = r() * Math.PI * 2;
    const sp = 0.012 + r() * 0.02;
    const x = W * (0.2 + 0.6 * r() + 0.18 * Math.sin(t * sp + ph));
    const y = H * (0.25 + 0.45 * r() + 0.12 * Math.cos(t * sp * 0.8 + ph));
    const rad = Math.max(W, H) * (0.38 + 0.22 * r());
    const h = hue + (i - 1) * (22 + r() * 18);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `hsl(${h} ${38 + i * 6}% ${34 - i * 4}% / .55)`);
    g.addColorStop(0.55, `hsl(${h} 35% 20% / .18)`);
    g.addColorStop(1, `hsl(${h} 30% 10% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = "source-over";
  // a horizon of light, low in the frame
  const hz = H * (0.66 + 0.01 * Math.sin(t * 0.05));
  const line = ctx.createLinearGradient(0, hz - H * 0.05, 0, hz + H * 0.05);
  line.addColorStop(0, "rgba(255,240,220,0)");
  line.addColorStop(0.5, `hsl(${hue + 20} 50% 80% / .07)`);
  line.addColorStop(1, "rgba(255,240,220,0)");
  ctx.fillStyle = line;
  ctx.fillRect(0, hz - H * 0.05, W, H * 0.1);
  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // grain, moved every frame
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = "overlay";
  const tile = grainTile();
  const ox = Math.floor((t * 977) % 160), oy = Math.floor((t * 613) % 160);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = ctx.createPattern(tile, "repeat");
  ctx.fillRect(0, 0, W + 160, H + 160);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ overlay

function overlay(W, H, fileMs) {
  const { airing } = state;
  const u = H / 60;
  const pad = u * 3;
  // Burned-in timecode: file position, so you can watch the station keep time.
  const fr = Math.floor((fileMs % 1000) / (1000 / 30));
  const tc = `${fmt(fileMs)}:${String(fr).padStart(2, "0")}`;
  ctx.font = `500 ${u * 1.5}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = "alphabetic";
  // Bottom left, like a VHS counter, so the top-left rating card never sits on it.
  // The info banner covers that corner, so the counter steps aside while it's up.
  const bannerUp = document.body.classList.contains("banner-open");
  const base = H - pad;
  if (bannerUp) ctx.globalAlpha = 0;
  ctx.fillStyle = "rgba(241,236,226,.78)";
  ctx.fillText(tc, pad, base);
  ctx.font = `500 ${u * 0.95}px Inter, sans-serif`;
  ctx.fillStyle = "rgba(241,236,226,.5)";
  ctx.fillText("Demo program · no media is streamed", pad, base - u * 2.3);
  ctx.globalAlpha = 1;

  // Lower third: shown at the top of the program and for a few seconds after tuning in.
  // Lower third: only at the top of a program, like a real broadcast. On tune-in the
  // info banner already says what this is.
  const show = fileMs < 10_000 ? Math.min(1, (10_000 - fileMs) / 600) : 0;
  if (show <= 0 || document.body.classList.contains("banner-open")) return;
  ctx.globalAlpha = Math.min(1, show);
  const y = H * (airing.kind === "movie" ? 0.78 : 0.8);
  ctx.font = `400 ${u * 4.6}px "Instrument Serif", Georgia, serif`;
  ctx.fillStyle = "#f1ece2";
  ctx.fillText(airing.title, pad, y);
  ctx.font = `500 ${u * 1.5}px Inter, sans-serif`;
  ctx.fillStyle = "rgba(241,236,226,.75)";
  const sub = [airing.episode, airing.subtitle ? `“${airing.subtitle}”` : null, airing.year].filter(Boolean).join("   ");
  ctx.fillText(sub, pad + u * 0.1, y + u * 2.4);
  ctx.globalAlpha = 1;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
