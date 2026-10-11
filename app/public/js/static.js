// Channel-change static: a low-res noise field scaled up (cheap on any GPU) plus a
// short burst of white noise. Both are optional (Look & feel).

import { pref } from "./util.js";

const canvas = document.getElementById("static");
const ctx = canvas.getContext("2d", { alpha: true });
const W = 192, H = 108;
canvas.width = W;
canvas.height = H;
canvas.style.imageRendering = "pixelated";
const img = ctx.createImageData(W, H);
let running = false;
let raf = 0;

function frame() {
  const d = img.data;
  const roll = (performance.now() / 9) % H | 0; // a slow rolling bar like a detuned set
  for (let y = 0; y < H; y++) {
    const band = Math.abs(y - roll) < 7 ? 40 : 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = (Math.random() * 215 + band) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (running) raf = requestAnimationFrame(frame);
}

export function staticOn() {
  if (!pref("static")) {
    // Without static, cut to black so the change still reads as a change.
    canvas.style.background = "#000";
    canvas.classList.add("on");
    ctx.clearRect(0, 0, W, H);
    return;
  }
  canvas.style.background = "";
  canvas.classList.add("on");
  if (!running) {
    running = true;
    frame();
  }
  noise(true);
}

export function staticOff() {
  canvas.classList.remove("on");
  noise(false);
  setTimeout(() => {
    if (!canvas.classList.contains("on")) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }, 300);
}

// ------------------------------------------------------------------ sound

let ac = null;
let noiseNode = null;
let noiseGain = null;

export function unlockAudio() {
  if (ac) return;
  try {
    ac = new AudioContext();
    const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    noiseNode = ac.createBufferSource();
    noiseNode.buffer = buf;
    noiseNode.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 3200;
    filter.Q.value = 0.6;
    noiseGain = ac.createGain();
    noiseGain.gain.value = 0;
    noiseNode.connect(filter).connect(noiseGain).connect(ac.destination);
    noiseNode.start();
  } catch {
    ac = null;
  }
}

function noise(on) {
  if (!ac || !noiseGain) return;
  const t = ac.currentTime;
  const target = on && pref("sound") && !pref("muted") ? 0.05 * pref("volume") : 0;
  noiseGain.gain.cancelScheduledValues(t);
  noiseGain.gain.setTargetAtTime(target, t, on ? 0.01 : 0.06);
}

/** The soft relay click of an old tuner. */
export function click() {
  if (!ac || !pref("sound") || pref("muted")) return;
  const t = ac.currentTime;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "square";
  o.frequency.setValueAtTime(1800, t);
  o.frequency.exponentialRampToValueAtTime(400, t + 0.03);
  g.gain.setValueAtTime(0.04 * pref("volume"), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + 0.06);
}
