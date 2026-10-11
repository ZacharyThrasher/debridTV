// On-screen display: the green channel number, the info banner, and the channel bug.

import { html, raw, fmtTime, fmtDur, now, clamp } from "./util.js";
import { logoHtml } from "./channel-editor.js";

const hasMark = (c) => c?.logo?.kind === "text" && c.logo.text;

const osdEl = document.getElementById("osd-num");
const bannerEl = document.getElementById("banner");
const bugEl = document.getElementById("bug");
let osdTimer, bannerTimer;
let bannerState = null; // { ch, info, route }

export function osd(text, small = "", ms = 2600) {
  osdEl.innerHTML = html`${text}${small ? html`<small>${small}</small>` : ""}`;
  osdEl.classList.add("on");
  clearTimeout(osdTimer);
  if (ms) osdTimer = setTimeout(() => osdEl.classList.remove("on"), ms);
}
export function osdHide() {
  osdEl.classList.remove("on");
}

export function bug(ch) {
  if (!ch) return void (bugEl.hidden = true);
  bugEl.innerHTML = hasMark(ch) ? logoHtml(ch) : html`<b>${ch.number}</b>${ch.name}`.html;
  bugEl.hidden = false;
}

export function setBanner(ch, info, route) {
  bannerState = { ch, info, route };
  if (!bannerEl.hidden) renderBanner();
}

export function showBanner(ms = 5200) {
  if (!bannerState) return;
  renderBanner();
  bannerEl.hidden = false;
  document.body.classList.add("banner-open");
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(hideBanner, ms);
}
export function hideBanner() {
  bannerEl.hidden = true;
  document.body.classList.remove("banner-open");
  clearTimeout(bannerTimer);
}
export function toggleBanner() {
  if (bannerEl.hidden) showBanner(0);
  else hideBanner();
}
export function tickBanner() {
  if (!bannerEl.hidden) renderBanner();
}

/** Where the slot's closing station break starts on the progress bar, hatched like the guide. */
function padAt(a) {
  const pad = a.segments?.find((x) => x.kind === "break" && x.reason === "padding" && x.end - x.start >= 2 * 60_000);
  if (!pad) return "";
  return `<b style="left:${(((pad.start - a.start) / (a.end - a.start)) * 100).toFixed(2)}%"></b>`;
}

const ROUTE_LABEL = { direct: "Direct play", live: "Compatibility mode", demo: "Demo picture", card: "" };

function renderBanner() {
  const { ch, info, route } = bannerState;
  const a = info.airing;
  const seg = info.segment;
  const t = now();
  let title = ch.name, meta = "", pct = 0, times = "", next = "";
  if (a) {
    title = a.title;
    pct = clamp((t - a.start) / (a.end - a.start), 0, 1) * 100;
    times = `${fmtTime(a.start, { short: true })} – ${fmtTime(a.end)}`;
    const bits = [];
    if (a.episode) bits.push(html`<span class="ep">${a.episode}</span>`);
    if (a.subtitle) bits.push(html`<span>“${a.subtitle}”</span>`);
    if (a.year) bits.push(html`<span>${a.year}</span>`);
    if (a.genre) bits.push(html`<span>${a.genre}</span>`);
    if (a.durationMs) bits.push(html`<span>${fmtDur(a.durationMs)}</span>`);
    if (seg?.kind === "break") bits.push(html`<span class="badge warn">Station break</span>`);
    else bits.push(html`<span class="badge live">LIVE</span>`);
    if (a.watched) bits.push(html`<span class="badge ok">✓ Watched</span>`);
    if (a.availability === "policy-blocked") bits.push(html`<span class="badge bad">Refused by provider</span>`);
    if (ROUTE_LABEL[route]) bits.push(html`<span class="badge">${ROUTE_LABEL[route]}</span>`);
    if (a.provider && a.provider !== "demo") bits.push(html`<span class="badge">${a.provider === "realdebrid" ? "Real-Debrid" : a.provider === "torbox" ? "TorBox" : "This PC"}</span>`);
    meta = bits.join("");
  } else meta = html`<span class="badge warn">Off the air</span>`;
  if (info.next) next = html`<div class="next">Next at ${fmtTime(info.next.start)}<b>${info.next.title}</b></div>`;
  bannerEl.style.setProperty("--h", ch.hue);
  bannerEl.innerHTML = html`
    <div class="chan"><div class="num" style="--h:${ch.hue}">${ch.number}</div><div class="cname">${hasMark(ch) ? raw(logoHtml(ch)) : ch.name}</div></div>
    <div>
      <div class="title">${title}</div>
      <div class="meta">${raw(meta)}</div>
      ${a ? raw(`<div class="progress"><i style="width:${pct.toFixed(2)}%"></i>${padAt(a)}</div>`) : ""}
    </div>
    <div style="display:grid;gap:calc(var(--u)*.5);justify-items:end">
      <div class="clock">${fmtTime(t)}</div>
      <div class="times">${times}</div>
      ${raw(next)}
    </div>`;
}
