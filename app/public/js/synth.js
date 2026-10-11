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

const GENRE_SCENE = { "Sci-fi": "stars", "Newsroom drama": "city", Mystery: "city", Nature: "waves", Cooking: "sunset", Sitcom: "sunset", Cartoon: "sunset" };
const SCENES = ["sunset", "city", "stars", "waves"];

export function synthStart(airing, fileOffsetMs) {
  const key = airing.title || airing.itemId;
  const seed = hash(key);
  const scene = GENRE_SCENE[airing.genre] || SCENES[hash(airing.itemId) % SCENES.length];
  // Each scene keeps to a palette range that looks good; the show picks a spot in it.
  const range = { sunset: [-40, 40], city: [-30, 50], stars: [0, 360], waves: [-20, 60] }[scene];
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
  if (scene === "stars") drawStars(W, H, t, hue, seed);
  else if (scene === "city") drawCity(W, H, t, hue, seed);
  else if (scene === "waves") drawWaves(W, H, t, hue);
  else drawSunset(W, H, t, hue, seed);
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

// ------------------------------------------------------------------ scenes

function drawSunset(W, H, t, hue, seed) {
  const horizon = H * 0.62;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, `hsl(${hue + 250} 60% 10%)`);
  sky.addColorStop(0.55, `hsl(${hue + 300} 70% 28%)`);
  sky.addColorStop(1, `hsl(${hue + 20} 95% 62%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, horizon);
  // Sun with venetian stripes, drifting slowly with program time.
  const r = H * 0.22;
  const cx = W * 0.5 + Math.sin(t / 90) * W * 0.04;
  const cy = horizon - r * 0.35 + Math.sin(t / 40) * H * 0.01;
  const sun = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  sun.addColorStop(0, `hsl(${hue + 50} 100% 70%)`);
  sun.addColorStop(1, `hsl(${hue + 330} 100% 60%)`);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = sun;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 7; i++) {
    const y = cy + r * 0.1 + i * r * 0.14 + ((t * 6) % (r * 0.14));
    ctx.fillRect(cx - r, y, r * 2, 2 + i * (r * 0.012));
  }
  ctx.restore();
  // Mountains (two parallax layers).
  const rand = rng(seed);
  for (const [layer, light, speed] of [[0, 18, 3], [1, 10, 7]]) {
    ctx.fillStyle = `hsl(${hue + 270} 50% ${light}%)`;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    const peaks = 9;
    const off = (t * speed) % (W / peaks);
    for (let i = -1; i <= peaks + 1; i++) {
      const x = i * (W / peaks) - off;
      const hgt = H * (0.08 + 0.12 * (0.5 + 0.5 * Math.sin(i * 1.7 + layer * 3 + Math.floor((t * speed) / (W / peaks)) * 1.7 + rand())));
      ctx.lineTo(x, horizon - hgt);
    }
    ctx.lineTo(W, horizon);
    ctx.fill();
  }
  // Perspective grid floor.
  const floor = ctx.createLinearGradient(0, horizon, 0, H);
  floor.addColorStop(0, `hsl(${hue + 280} 70% 8%)`);
  floor.addColorStop(1, `hsl(${hue + 260} 80% 4%)`);
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizon, W, H - horizon);
  ctx.strokeStyle = `hsla(${hue + 320} 100% 65% / .7)`;
  ctx.lineWidth = Math.max(1, H / 500);
  ctx.beginPath();
  for (let i = -14; i <= 14; i++) {
    ctx.moveTo(W / 2 + i * W * 0.012, horizon);
    ctx.lineTo(W / 2 + i * W * 0.14, H);
  }
  const phase = (t * 0.6) % 1;
  for (let i = 0; i < 14; i++) {
    const z = (i + phase) / 14;
    const y = horizon + (H - horizon) * z * z;
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

function drawCity(W, H, t, hue, seed) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, `hsl(${hue + 220} 55% 6%)`);
  sky.addColorStop(1, `hsl(${hue + 250} 50% 20%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // Moon.
  ctx.fillStyle = "rgba(255,250,230,.9)";
  ctx.beginPath();
  ctx.arc(W * 0.8, H * 0.2, H * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `hsl(${hue + 220} 55% 7%)`;
  ctx.beginPath();
  ctx.arc(W * 0.8 + H * 0.025, H * 0.19, H * 0.055, 0, Math.PI * 2);
  ctx.fill();
  // Three layers of buildings scrolling at different speeds; windows switch on and
  // off as a function of program time, so the city is alive but deterministic.
  const layers = [
    { speed: 4, base: 0.55, light: 12, win: 0.15 },
    { speed: 9, base: 0.68, light: 8, win: 0.3 },
    { speed: 18, base: 0.82, light: 4, win: 0.45 },
  ];
  layers.forEach((L, li) => {
    const bw = W * (0.06 + li * 0.02);
    const shift = t * L.speed;
    const first = Math.floor(shift / bw) - 1;
    for (let k = first; k < first + W / bw + 3; k++) {
      const r = rng(seed ^ (k * 2654435761) ^ (li * 97));
      const x = k * bw - shift;
      const h = H * (1 - L.base) + r() * H * 0.25;
      const top = H - h;
      ctx.fillStyle = `hsl(${hue + 230} 35% ${L.light}%)`;
      ctx.fillRect(x, top, bw - 2, h);
      const cols = 4, rows = Math.floor(h / (H * 0.03));
      const cw = (bw - 2) / (cols * 2 + 1);
      for (let row = 1; row < rows; row++)
        for (let c = 0; c < cols; c++) {
          const on = rng((k * 131 + row * 17 + c) ^ seed ^ Math.floor(t / (20 + r() * 40)))() < L.win;
          if (!on) continue;
          ctx.fillStyle = `hsla(${45 + r() * 20} 100% 70% / ${0.5 + li * 0.2})`;
          ctx.fillRect(x + cw * (1 + c * 2), top + row * H * 0.03, cw, H * 0.012);
        }
    }
  });
  // A searchlight sweep.
  const a = Math.sin(t / 7) * 0.6 - Math.PI / 2;
  const g = ctx.createLinearGradient(W * 0.3, H, W * 0.3 + Math.cos(a) * H, H + Math.sin(a) * H);
  g.addColorStop(0, `hsla(${hue + 180} 100% 80% / .18)`);
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(W * 0.3, H);
  ctx.lineTo(W * 0.3 + Math.cos(a - 0.05) * H * 1.4, H + Math.sin(a - 0.05) * H * 1.4);
  ctx.lineTo(W * 0.3 + Math.cos(a + 0.05) * H * 1.4, H + Math.sin(a + 0.05) * H * 1.4);
  ctx.fill();
}

function drawStars(W, H, t, hue, seed) {
  ctx.fillStyle = `hsl(${hue + 230} 60% 4%)`;
  ctx.fillRect(0, 0, W, H);
  const neb = ctx.createRadialGradient(W * 0.3, H * 0.4, 0, W * 0.3, H * 0.4, W * 0.6);
  neb.addColorStop(0, `hsla(${hue} 90% 50% / .25)`);
  neb.addColorStop(1, "transparent");
  ctx.fillStyle = neb;
  ctx.fillRect(0, 0, W, H);
  const r = rng(seed);
  const cx = W / 2, cy = H / 2;
  for (let i = 0; i < 380; i++) {
    const ang = r() * Math.PI * 2;
    const speed = 0.05 + r() * 0.15;
    const z = (r() + t * speed) % 1; // 0 far, 1 near
    const d = Math.pow(z, 2.2) * Math.hypot(W, H) * 0.6;
    const x = cx + Math.cos(ang) * d, y = cy + Math.sin(ang) * d;
    const len = z * z * W * 0.02;
    ctx.strokeStyle = `hsla(${hue + 180 + r() * 60} 80% ${70 + z * 30}% / ${0.2 + z * 0.8})`;
    ctx.lineWidth = Math.max(1, z * 2.5);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  // A planet sliding by over the episode.
  const px = W * (1.1 - ((t / 600) % 1.4));
  const pr = H * 0.28;
  const pg = ctx.createRadialGradient(px - pr * 0.4, H * 0.7 - pr * 0.4, pr * 0.1, px, H * 0.7, pr);
  pg.addColorStop(0, `hsl(${hue + 30} 70% 60%)`);
  pg.addColorStop(1, `hsl(${hue + 10} 70% 12%)`);
  ctx.fillStyle = pg;
  ctx.beginPath();
  ctx.arc(px, H * 0.7, pr, 0, Math.PI * 2);
  ctx.fill();
}

function drawWaves(W, H, t, hue) {
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0, `hsl(${hue + 190} 60% 22%)`);
  sky.addColorStop(1, `hsl(${hue + 160} 50% 58%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // Drifting clouds.
  ctx.fillStyle = "rgba(255,255,255,.22)";
  for (let i = 0; i < 6; i++) {
    const x = ((i * 0.23 + t / 400) % 1.3) * W * 1.1 - W * 0.15;
    const y = H * (0.1 + (i % 3) * 0.08);
    ctx.beginPath();
    ctx.ellipse(x, y, W * 0.09, H * 0.025, 0, 0, Math.PI * 2);
    ctx.ellipse(x + W * 0.05, y - H * 0.015, W * 0.06, H * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let layer = 0; layer < 6; layer++) {
    const base = H * (0.5 + layer * 0.09);
    const amp = H * (0.01 + layer * 0.006);
    ctx.fillStyle = `hsl(${hue + 190 + layer * 4} 65% ${40 - layer * 5.5}%)`;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 80) {
      const y = base + Math.sin(x / W * (6 + layer) + t * (0.4 + layer * 0.15)) * amp + Math.sin(x / W * 17 + t * 1.1) * amp * 0.3;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.fill();
  }
}

// ------------------------------------------------------------------ overlay

function overlay(W, H, fileMs) {
  const { airing } = state;
  const u = H / 60;
  const pad = u * 3;
  // Burned-in timecode: file position, so you can watch the station keep time.
  const fr = Math.floor((fileMs % 1000) / (1000 / 30));
  const tc = `${fmt(fileMs)}:${String(fr).padStart(2, "0")}`;
  ctx.font = `${u * 2.2}px VT323, monospace`;
  ctx.textBaseline = "alphabetic";
  const tw = ctx.measureText(tc).width;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  // Bottom left, like a VHS counter, so the top-left rating card never sits on it.
  // The info banner covers that corner, so the counter steps aside while it's up.
  const bannerUp = document.body.classList.contains("banner-open");
  const base = H - pad;
  if (bannerUp) ctx.globalAlpha = 0;
  ctx.fillRect(pad - u * 0.6, base - u * 2.1, tw + u * 1.2, u * 2.7);
  ctx.fillStyle = "#e8ffe8";
  ctx.fillText(tc, pad, base);
  ctx.font = `600 ${u * 1.05}px Inter, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.fillText("DEMO PROGRAM · NO MEDIA IS STREAMED", pad, base - u * 2.7);
  ctx.globalAlpha = 1;

  // Lower third: shown at the top of the program and for a few seconds after tuning in.
  // Lower third: only at the top of a program, like a real broadcast. On tune-in the
  // info banner already says what this is.
  const show = fileMs < 10_000 ? Math.min(1, (10_000 - fileMs) / 600) : 0;
  if (show <= 0 || document.body.classList.contains("banner-open")) return;
  ctx.globalAlpha = Math.min(1, show);
  const y = H * (airing.kind === "movie" ? 0.78 : 0.8);
  ctx.font = `800 ${u * 4.2}px "Barlow Condensed", sans-serif`;
  const title = airing.title.toUpperCase();
  const tw2 = ctx.measureText(title).width;
  const grad = ctx.createLinearGradient(pad, 0, pad + tw2 + u * 4, 0);
  grad.addColorStop(0, "rgba(0,0,0,.75)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(pad - u, y - u * 4.2, tw2 + u * 8, u * 7.2);
  ctx.fillStyle = `hsl(${state.hue + 40} 100% 65%)`;
  ctx.fillRect(pad - u, y - u * 4.2, u * 0.45, u * 7.2);
  ctx.fillStyle = "#fff";
  ctx.fillText(title, pad + u * 0.4, y);
  ctx.font = `500 ${u * 1.7}px Inter, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,.85)";
  const sub = [airing.episode, airing.subtitle ? `“${airing.subtitle}”` : null, airing.year].filter(Boolean).join("  ·  ");
  ctx.fillText(sub, pad + u * 0.5, y + u * 2.3);
  ctx.globalAlpha = 1;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}
