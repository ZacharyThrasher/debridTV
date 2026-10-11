// Small shared helpers: time formatting, preferences, DOM building, toasts.

const PREF_KEY = "debridtv.prefs";
const DEFAULTS = { theme: "midnight", crt: true, static: true, sound: true, clock24: false, calm: false, volume: 0.9, muted: false, welcomed: false, lastChannel: null };

let prefs = { ...DEFAULTS };
try {
  prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
} catch {}

export function pref(k) {
  return prefs[k];
}
export function setPref(k, v) {
  prefs[k] = v;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {}
  applyPrefs();
}
export function applyPrefs() {
  document.documentElement.dataset.theme = prefs.theme;
  document.body.classList.toggle("crt", !!prefs.crt);
  document.body.classList.toggle("calm", !!prefs.calm);
}

/** Server clock offset so the picture matches the station even if the PC clock drifts. */
let skew = 0;
export function syncClock(serverNow, sentAt) {
  const rtt = Date.now() - sentAt;
  skew = serverNow + rtt / 2 - Date.now();
}
export const now = () => Date.now() + skew;

export function fmtTime(ms, { short = false } = {}) {
  const d = new Date(ms);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  if (prefs.clock24) return `${String(h).padStart(2, "0")}:${m}`;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return short ? `${h}:${m}` : `${h}:${m} ${ap}`;
}
export function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ""}`;
}
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}
export function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
export function ago(ms) {
  const s = Math.round((now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Markup that is already safe. Template results nest without being escaped twice. */
class Safe {
  constructor(h) {
    this.html = h;
  }
  toString() {
    return this.html;
  }
}
const part = (v) => (v == null || v === false ? "" : v instanceof Safe ? v.html : Array.isArray(v) ? v.map(part).join("") : esc(v));

/** Tagged template that escapes interpolations unless they are html``/raw() results. */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Safe(out);
}
export const raw = (h) => (h instanceof Safe ? h : new Safe(String(h ?? "")));

let toastTimer;
export function toast(msg, ms = 3200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
