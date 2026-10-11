// Full-screen station cards: breaks between programs, off air, and the honest
// "can't play this" card. Breaks never touch a provider: they're drawn here.

import { html, raw, fmtTime, fmtClock, fmtDur, now, clamp } from "./util.js";
import { api } from "./api.js";
import { tv, tune } from "./player.js";
import { logoHtml } from "./channel-editor.js";

const el = document.getElementById("card");
let countdownTo = 0;

const bars = raw(`<div class="card-bars">${"<i></i>".repeat(7)}</div>`);

function show(hue, inner, cls = "") {
  el.className = `card ${cls}`;
  el.style.setProperty("--h", hue ?? 220);
  el.innerHTML = `<div class="card-inner">${inner}</div>${bars.html}`;
  el.hidden = false;
}

export function hideCard() {
  brk = null;
  el.hidden = true;
  el.innerHTML = "";
  countdownTo = 0;
}

/**
 * A station break. Short ones are a simple "up next" ident. Long ones (a 42-minute
 * episode in an hour slot leaves 18 minutes) become a Prevue-style channel: the
 * card rotates through what's next here, later today, and what's on elsewhere, with
 * a guide crawl along the bottom. All of it comes from the local station clock
 * (/api/guide), so a break costs zero provider calls and zero media bytes.
 */
export function breakCard(ch, info) {
  const seg = info.segment;
  const mid = seg.reason === "mid";
  const next = mid ? info.airing : info.next;
  countdownTo = seg.end;
  const long = seg.end - seg.start >= ROTATE_MIN_MS && seg.end - now() > ROTATE_MIN_MS / 2;
  brk = { ch, info, seg, mid, next, long, slide: 0, slideAt: now(), guide: null, key: `${ch.id}:${seg.start}` };
  show(
    ch.hue,
    html`<header class="brk-top">
        <div class="brk-chan"><span class="card-num">${ch.number}</span>${ch.logo?.kind === "text" && ch.logo.text ? raw(`<span class="brk-mark">${logoHtml(ch, "lg")}</span>`) : html`<span class="brk-name">${ch.name}</span>`}</div>
        <div class="brk-kicker">${mid ? "We'll be right back" : "Station break"}</div>
        <div class="brk-clock" data-clock aria-live="off">${fmtTime(now())}</div>
      </header>
      <div class="brk-stage" data-stage aria-live="off">${raw(heroSlide())}</div>
      <footer class="brk-foot">
        <div class="brk-pips" data-pips aria-hidden="true"></div>
        <div class="brk-meter" aria-hidden="true"><i data-meter></i></div>
      </footer>
      <div class="brk-crawl" data-crawl aria-hidden="true"></div>
      <div class="brk-ghost" aria-hidden="true">${ch.number}</div>
      <p class="sr-only">${mid ? "Short break" : "Station break"} on ${ch.name}. ${next ? `${mid ? "Back to" : "Up next"}: ${next.title} at ${fmtTime(seg.end)}.` : ""}</p>`,
    "brk",
  );
  updateMeter();
  loadGuide(brk.key);
}

const ROTATE_MIN_MS = 2.5 * 60_000; // breaks shorter than this stay on "up next"
const SLIDE_MS = 10_000;
let brk = null;

async function loadGuide(key) {
  const t = now();
  let g;
  try {
    g = await api.get(`/api/guide?from=${t - 60_000}&to=${t + 6 * 3_600_000}`);
  } catch {
    return; // the hero slide still works without it
  }
  if (!brk || brk.key !== key) return;
  brk.guide = g;
  el.querySelector("[data-crawl]").innerHTML = crawl(g).html;
  if (brk.long) renderPips();
}

const meta = (a) => [a.episode, a.subtitle && `“${a.subtitle}”`, a.year, a.genre, a.rating, a.durationMs && fmtDur(a.durationMs)].filter(Boolean);

function heroSlide() {
  const { next, mid, seg, ch } = brk;
  if (!next) return html`<div class="brk-slide brk-hero"><div class="brk-label">Stay tuned</div><div class="brk-title">${ch.name}</div>
    <div class="brk-sub">${ch.tagline || ""}</div><div class="brk-when">Back in <b data-countdown>${fmtClock(seg.end - now())}</b></div></div>`.html;
  return html`<div class="brk-slide brk-hero">
    <div class="brk-label">${mid ? "Back to" : "Up next"}${mid ? "" : html` · <span class="brk-at">${fmtTime(seg.end)}</span>`}</div>
    <div class="brk-title">${next.title}</div>
    <div class="brk-sub">${meta(next).join(" · ")}</div>
    ${next.description ? html`<div class="brk-plot">${next.description}</div>` : ""}
    <div class="brk-when">${mid ? "Back in" : "Starts in"} <b data-countdown>${fmtClock(seg.end - now())}</b></div>
  </div>`.html;
}

/** The other slides; each returns null when it would be empty. */
const SLIDES = [
  () => heroSlide(),
  // Station ident (N-21): the channel's own mark, like a network bumper between shows.
  function ident() {
    const { ch } = brk;
    const mark = ch.logo?.kind === "text" && ch.logo.text ? raw(logoHtml(ch, "xl")) : html`<span class="id-num">${ch.number}</span>`;
    return html`<div class="brk-slide brk-ident"><div class="id-rays" aria-hidden="true"></div>
      <div class="brk-label">You're watching</div>
      <div class="id-mark">${mark}</div>
      <div class="id-name"><b>${ch.number}</b>${ch.name}</div>
      ${ch.tagline ? html`<div class="id-tag">${ch.tagline}</div>` : ""}</div>`.html;
  },
  function laterHere() {
    const row = brk.guide?.rows.find((r) => r.channel.id === brk.ch.id);
    const list = (row?.airings ?? []).filter((a) => a.start >= brk.seg.end).slice(0, 5);
    if (list.length < 2) return null;
    return html`<div class="brk-slide"><div class="brk-label">Later on ${brk.ch.name}</div>
      <ol class="brk-list">${list.map((a, i) => html`<li class="${i === 0 ? "hl" : ""}"><span class="tm">${fmtTime(a.start)}</span>
        <span class="ti">${a.title}</span><span class="mt">${meta(a).slice(0, 2).join(" · ")}</span></li>`)}</ol></div>`.html;
  },
  function onNow() {
    const t = now();
    const rows = (brk.guide?.rows ?? []).filter((r) => r.channel.id !== brk.ch.id)
      .map((r) => ({ ch: r.channel, a: r.airings.find((a) => a.start <= t && t < a.end) }))
      .filter((x) => x.a)
      .slice(0, 6);
    if (rows.length < 2) return null;
    return html`<div class="brk-slide"><div class="brk-label">On now elsewhere</div>
      <ol class="brk-list chans">${rows.map(({ ch, a }) => {
        const inBreak = a.segments?.some((s) => s.kind === "break" && s.start <= t && t < s.end);
        const pct = clamp((t - a.start) / (a.end - a.start), 0, 1) * 100;
        return html`<li style="--h:${ch.hue}" data-ch="${ch.id}"><span class="n">${ch.number}</span><span class="ti">${a.title}</span>
          <span class="mt">${inBreak ? "On a break" : a.episode || a.year || ""}</span>
          <span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span><span class="tm">til ${fmtTime(a.end, { short: true })}</span></li>`;
      })}</ol><div class="brk-hint">Type a channel number, or click one, to switch</div></div>`.html;
  },
  function startingSoon() {
    const t = now();
    const soon = (brk.guide?.rows ?? []).filter((r) => r.channel.id !== brk.ch.id)
      .flatMap((r) => r.airings.filter((a) => a.start > t && a.start < t + 75 * 60_000).slice(0, 1).map((a) => ({ ch: r.channel, a })))
      .sort((x, y) => x.a.start - y.a.start)
      .slice(0, 5);
    if (soon.length < 2) return null;
    return html`<div class="brk-slide"><div class="brk-label">Starting soon</div>
      <ol class="brk-list chans">${soon.map(({ ch, a }) => html`<li style="--h:${ch.hue}" data-ch="${ch.id}"><span class="n">${ch.number}</span>
        <span class="ti">${a.title}</span><span class="mt">${a.episode || a.year || ch.name}</span><span class="tm wide">${fmtTime(a.start)}</span></li>`)}</ol></div>`.html;
  },
];

function slides() {
  return SLIDES.map((f, i) => (brk.guide || i < 2 ? f() : null));
}

function renderPips() {
  const n = slides().filter(Boolean).length;
  el.querySelector("[data-pips]").innerHTML = n > 1 ? "<i></i>".repeat(n) : "";
  markPip();
}
function markPip() {
  const live = slides().map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  el.querySelectorAll("[data-pips] i").forEach((p, i) => p.classList.toggle("on", live[i] === brk.slide));
}

function rotate() {
  const all = slides();
  const live = all.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  if (live.length < 2) return;
  const pos = live.indexOf(brk.slide);
  // Close to the end of the break, settle on "up next".
  const nextIdx = countdownTo - now() < SLIDE_MS * 1.5 ? 0 : live[(pos + 1) % live.length];
  if (nextIdx === brk.slide) return;
  brk.slide = nextIdx;
  brk.slideAt = now();
  const stage = el.querySelector("[data-stage]");
  stage.innerHTML = all[nextIdx];
  markPip();
}

// Mouse and touch: a channel row in a break slide tunes to it.
el.addEventListener("click", (e) => {
  const li = e.target.closest("[data-ch]");
  if (!li) return;
  e.stopPropagation();
  const ch = tv.channels.find((c) => c.id === li.dataset.ch);
  if (ch) tune(ch);
});

function crawl(g) {
  const t = now();
  const items = g.rows.map((r) => {
    const a = r.airings.find((x) => x.start <= t && t < x.end);
    const n = r.airings.find((x) => x.start >= t);
    return html`<span class="ci" style="--h:${r.channel.hue}"><b>${r.channel.number}</b>${r.channel.name}<em>${a ? a.title : "Off air"}</em>${n ? html`<small>then ${n.title} ${fmtTime(n.start, { short: true })}</small>` : ""}</span>`;
  });
  // Two copies so the loop is seamless; the speed scales with its length.
  return html`<div class="crawl-track" style="--dur:${Math.max(30, items.length * 6)}s"><div>${items}</div><div>${items}</div></div>`;
}

function updateMeter() {
  if (!brk) return;
  const m = el.querySelector("[data-meter]");
  if (m) m.style.width = `${(clamp((now() - brk.seg.start) / (brk.seg.end - brk.seg.start), 0, 1) * 100).toFixed(2)}%`;
  const c = el.querySelector("[data-clock]");
  if (c) c.textContent = fmtTime(now());
}

export function offAirCard(ch) {
  countdownTo = 0;
  show(
    ch.hue,
    html`<div class="card-kicker">Off the air</div>
      <div class="card-title">${ch.name}</div>
      <div><span class="card-num">${ch.number}</span></div>
      <div class="why">This channel has nothing it can schedule yet. Programs join a channel once their running time is known: open Settings → Sources and run a library scan.</div>
      <div class="elsewhere" data-elsewhere></div>`,
    "warn",
  );
  elsewhere(ch.id);
}

export function unavailableCard(ch, airing, { policy = false, reason = "" } = {}) {
  countdownTo = airing.end;
  const why = policy
    ? "Your provider refused this file. DebridTV won't retry it and won't fetch it from anywhere else. The channel carries on with the next program."
    : reason || "This program can't be played right now. The channel keeps time and moves on at the next program.";
  show(
    ch.hue,
    html`<div class="card-kicker">${policy ? "Not available from your provider" : "Can't play this one"}</div>
      <div class="card-title" style="font-size:calc(var(--u)*4.4)">${airing.title}</div>
      <div class="card-sub">${[airing.episode, airing.subtitle].filter(Boolean).join(" · ")}</div>
      <div class="why">${why}</div>
      <div class="card-countdown" aria-live="off">Next program in <span data-countdown>${fmtClock(airing.end - now())}</span></div>
      <div class="elsewhere" data-elsewhere></div>`,
    "warn",
  );
  elsewhere(ch.id);
}

/** A row of other channels' current programs, so a dead end always offers a way out. */
async function elsewhere(skipId) {
  const t = now();
  let g;
  try {
    g = await api.get(`/api/guide?from=${t - 60_000}&to=${t + 60_000}`);
  } catch {
    return;
  }
  const box = el.querySelector("[data-elsewhere]");
  if (!box) return;
  const picks = g.rows.filter((r) => r.channel.id !== skipId)
    .map((r) => ({ ch: r.channel, a: r.airings.find((a) => a.start <= t && t < a.end && a.availability !== "policy-blocked") }))
    .filter((x) => x.a)
    .slice(0, 4);
  if (!picks.length) return;
  box.innerHTML = html`<div class="label">Meanwhile, on now</div><div class="chips">${picks.map(({ ch, a }) =>
    html`<button class="chip" style="--h:${ch.hue}" data-ch="${ch.id}"><b>${ch.number}</b><span>${a.title}</span></button>`)}</div>`.html;
}

export function messageCard(ch, kicker, title, why) {
  countdownTo = 0;
  show(ch?.hue ?? 220, html`<div class="card-kicker">${kicker}</div><div class="card-title" style="font-size:calc(var(--u)*4.4)">${title}</div><div class="why">${why}</div>`, "warn");
}

/** Called once a second by the main loop. */
export function tickCard() {
  if (el.hidden || !countdownTo) return;
  const c = el.querySelector("[data-countdown]");
  if (c) c.textContent = fmtClock(countdownTo - now());
  if (brk) {
    updateMeter();
    if (brk.long && now() - brk.slideAt >= SLIDE_MS) rotate();
  }
}
