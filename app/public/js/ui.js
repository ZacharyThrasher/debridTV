// On-screen display: the green channel number, the info banner, and the channel bug.

import { html, raw, fmtTime, fmtDur, now, clamp, pref, onPrefsApplied } from "./util.js";
import { logoHtml } from "./channel-editor.js";
import { isLocked, isRedacted } from "./lock.js";

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

let bugCh = null;
export function bug(ch) {
  bugCh = ch;
  if (!ch) return void (bugEl.hidden = true);
  dispatchEvent(new CustomEvent("debridtv:channel", { detail: ch }));
  // Position and opacity are viewer prefs (N-16): bugPos "br" | "bl" | "tr" | "tl", bugOpacity 0.1–1.
  bugEl.dataset.pos = pref("bugPos") ?? "br";
  bugEl.style.setProperty("--bug-o", String(pref("bugOpacity") ?? 1));
  bugEl.innerHTML = hasMark(ch) ? logoHtml(ch) : html`<b>${ch.number}</b>${ch.name}`.html;
  bugEl.hidden = false;
}

// Moving the bug or changing its opacity in settings shows at once.
onPrefsApplied(() => bugCh && bug(bugCh));

// Picture and sound format chips (N-37). From airing.codecs (workstream C): video/audio
// codec names from the file header, plus optional hdr, height, audioChannels and atmos.
const HDR = { dv: ["Dolby Vision", "dv"], "hdr10+": ["HDR10+", "hdr"], hdr10: ["HDR10", "hdr"], hlg: ["HLG", "hdr"] };
const AUDIO = { eac3: "DD+", ac3: "Dolby Digital", dts: "DTS", truehd: "TrueHD", flac: "FLAC" };
const CHANNELS = { 1: "Mono", 2: "Stereo", 6: "5.1", 7: "6.1", 8: "7.1" };
export function formatChips(a) {
  const c = a?.codecs;
  if (!c) return "";
  const out = [];
  const h = Number(c.height) || 0;
  if (h) out.push(h >= 1600 ? ["4K", "res"] : h >= 1000 ? ["1080p", "res"] : h >= 700 ? ["720p", "res"] : ["SD", "res"]);
  if (HDR[c.hdr]) out.push(HDR[c.hdr]);
  const codec = AUDIO[String(c.audio?.[0] ?? "").toLowerCase()];
  const chans = CHANNELS[Number(c.audioChannels)] ?? (c.audioChannels > 2 ? `${c.audioChannels} ch` : "");
  if (c.atmos) out.push(["Atmos", "atmos"]);
  const sound = [codec, chans === "Stereo" && codec ? "2.0" : chans].filter(Boolean).join(" ");
  if (sound) out.push([sound, "snd"]);
  if (!out.length) return "";
  const label = out.map(([t]) => t).join(", ");
  return html`<span class="fmt" role="img" aria-label="${label}" title="${label}">${out.map(([t, k]) => html`<i class="${k}">${t}</i>`)}</span>`.html;
}

export function setBanner(ch, info, route) {
  bannerState = { ch, info, route };
  ratingCard(isLocked(ch) ? null : info);
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

// Rating card (N-16): a rated program shows its rating top-left for a few seconds
// when it starts or when you tune into it. Pref ratingCard (default on).
const ratingEl = Object.assign(document.createElement("div"), { className: "rating-card", hidden: true });
ratingEl.setAttribute("aria-live", "polite");
document.getElementById("stage").append(ratingEl);
let ratedKey = "", ratingTimer = 0;
function ratingCard(info) {
  const a = info?.airing;
  const key = a ? `${a.itemId}:${a.start}` : "";
  if (key === ratedKey) return;
  ratedKey = key;
  ratingEl.hidden = true;
  if (!a?.rating || info.segment?.kind !== "program" || pref("ratingCard") === false) return;
  ratingEl.innerHTML = html`<small>Rated</small><b>${a.rating}</b>`.html;
  ratingEl.hidden = false;
  clearTimeout(ratingTimer);
  ratingTimer = setTimeout(() => (ratingEl.hidden = true), 6000);
}

const ROUTE_LABEL = { direct: "Direct play", live: "Compatibility mode", demo: "Demo picture", card: "" };

function renderBanner() {
  const { ch, info, route } = bannerState;
  const a = info.airing;
  const seg = info.segment;
  const t = now();
  let title = ch.name, meta = "", pct = 0, times = "", next = "";
  if (a && (isLocked(ch) || isRedacted(a))) {
    title = "Locked channel";
    pct = clamp((t - a.start) / (a.end - a.start), 0, 1) * 100;
    times = `${fmtTime(a.start, { short: true })} – ${fmtTime(a.end)}`;
    meta = html`<span class="badge warn">🔒 Type the PIN to watch</span>`;
  } else if (a) {
    title = a.title;
    pct = clamp((t - a.start) / (a.end - a.start), 0, 1) * 100;
    times = `${fmtTime(a.start, { short: true })} – ${fmtTime(a.end)}`;
    const bits = [];
    if (a.episode) bits.push(html`<span class="ep">${a.episode}</span>`);
    if (a.subtitle) bits.push(html`<span>“${a.subtitle}”</span>`);
    if (a.year) bits.push(html`<span>${a.year}</span>`);
    if (a.genre) bits.push(html`<span>${a.genre}</span>`);
    if (a.rating) bits.push(html`<span class="rating">${a.rating}</span>`);
    if (a.durationMs) bits.push(html`<span>${fmtDur(a.durationMs)}</span>`);
    const fmt = formatChips(a);
    if (fmt) bits.push(fmt);
    if (seg?.kind === "break") bits.push(html`<span class="badge warn">Station break</span>`);
    else bits.push(html`<span class="badge live">LIVE</span>`);
    if (a.watched) bits.push(html`<span class="badge ok">✓ Watched</span>`);
    if (a.availability === "policy-blocked") bits.push(html`<span class="badge bad">Refused by provider</span>`);
    if (ROUTE_LABEL[route]) bits.push(html`<span class="badge">${ROUTE_LABEL[route]}</span>`);
    if (a.provider && a.provider !== "demo") bits.push(html`<span class="badge">${a.provider === "realdebrid" ? "Real-Debrid" : a.provider === "torbox" ? "TorBox" : "This PC"}</span>`);
    meta = bits.join("");
  } else meta = html`<span class="badge warn">Off the air</span>`;
  if (info.next && !isLocked(ch) && !isRedacted(info.next)) next = html`<div class="next">Next at ${fmtTime(info.next.start)}<b>${info.next.title}</b></div>`;
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
