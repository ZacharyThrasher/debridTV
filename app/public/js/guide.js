// The program guide. Built from the local station clock only: opening it, browsing
// it for hours, or scrolling 12 hours ahead costs zero provider calls and zero
// media bytes (EXP-001). The picture keeps playing in the top-left preview.

import { api } from "./api.js";
import { html, raw, fmtTime, fmtDur, now, clamp, toast, pref } from "./util.js";
import { tv, tune } from "./player.js";
import { logoHtml, hasLogo, datesLabel } from "./channel-editor.js";
import { formatChips, artOf, artImg } from "./ui.js";
import { isLocked, isRedacted } from "./lock.js";
import { openPanel } from "./panel.js";
import { openOnDemand } from "./ondemand.js";

const wordmark = (c) => (hasLogo(c) ? raw(logoHtml(c, "sm")) : null);

const MIN = 60_000;
const root = document.getElementById("guide");
const grid = document.getElementById("grid");
const details = document.getElementById("guide-details");
const dateEl = document.getElementById("guide-date");
const clockEl = document.getElementById("guide-clock");
const jumpEl = document.getElementById("guide-jump");
const tools = () => [...root.querySelectorAll(".guide-tools button")];

let data = null; // { from, to, rows }
let viewFrom = 0;
let row = 0;
let at = 0; // cursor time
let scrollRow = 0;
let refreshTimer = 0;
let openedAt = 0; // set on open so the first load highlights the current channel

const span = () => (innerWidth < 760 ? 90 : 150) * MIN;
const floor30 = (t) => t - (t % (30 * MIN));

export const guideOpen = () => !root.hidden;

export async function openGuide() {
  root.hidden = false;
  document.body.classList.add("guide-open");
  viewFrom = floor30(now());
  at = now();
  openedAt = now();
  poke();
  await load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => (guideOpen() ? load() : clearInterval(refreshTimer)), 60_000);
}

export function closeGuide() {
  clearPreview();
  if (root.contains(document.activeElement)) document.activeElement.blur();
  root.classList.remove("in-tools");
  root.hidden = true;
  document.body.classList.remove("guide-open");
  clearInterval(refreshTimer);
  clearTimeout(idleTimer);
}

// Idle action (N-15): after a while with no input, the guide can close back to the
// picture or tune the highlighted channel. Default is to stay open, like a real box.
export const IDLE_ACTIONS = { stay: "Stay open", close: "Close the guide", tune: "Tune the highlighted channel" };
let idleTimer = 0;
function poke() {
  clearTimeout(idleTimer);
  const action = pref("guideIdle") ?? "stay";
  if (action === "stay" || !guideOpen()) return;
  const mins = Number(pref("guideIdleMin")) || 2;
  idleTimer = setTimeout(() => {
    if (!guideOpen()) return;
    if (action === "tune" && data) pick(row, airingAt(row, at));
    else closeGuide();
  }, mins * MIN);
}
for (const t of ["keydown", "pointerdown", "wheel", "touchstart"]) addEventListener(t, () => guideOpen() && poke(), { passive: true, capture: true });

async function load() {
  const from = floor30(now()) - 30 * MIN;
  try {
    const first = !data;
    data = await api.get(`/api/guide?from=${from}&to=${from + 12 * 60 * MIN}`);
    // Favorites first (N-03), otherwise channel order. Stable, so numbers stay in order.
    data.rows.sort((a, b) => Number(!!b.channel.favorite) - Number(!!a.channel.favorite));
    if (first || openedAt) row = Math.max(0, data.rows.findIndex((r) => r.channel.id === tv.current?.id));
    openedAt = 0;
  } catch (e) {
    grid.innerHTML = html`<div style="padding:2em;color:var(--dim)">Couldn't load the guide: ${e.message}</div>`;
    return;
  }
  render();
}

function airingAt(r, t) {
  const list = data?.rows[r]?.airings ?? [];
  return list.find((a) => a.start <= t && t < a.end) ?? list.find((a) => a.start >= t) ?? list[list.length - 1];
}

function render() {
  if (!data) return;
  const s = span();
  const viewTo = viewFrom + s;
  const t = now();
  const rowsVisible = Math.max(1, Math.round((grid.querySelector(".grid-rows")?.clientHeight || grid.clientHeight) / rowPx()) || 6);
  if (row < scrollRow) scrollRow = row;
  if (row >= scrollRow + rowsVisible) scrollRow = row - rowsVisible + 1;
  scrollRow = clamp(scrollRow, 0, Math.max(0, data.rows.length - rowsVisible));

  const pct = (ms) => ((ms - viewFrom) / s) * 100;
  const times = [];
  for (let m = viewFrom; m < viewTo; m += 30 * MIN) times.push(html`<span style="left:${pct(m)}%">${fmtTime(m)}</span>`);
  if (t >= viewFrom && t < viewTo) times.push(html`<span class="now-mark" style="left:${pct(t)}%" aria-hidden="true"></span>`);
  const focus = airingAt(row, at);

  const rows = data.rows.map((r, ri) => {
    const ch = r.channel;
    const cells = r.airings
      .filter((a) => a.end > viewFrom && a.start < viewTo)
      .map((a, i, shown) => {
        const left = Math.max(0, pct(a.start));
        const right = Math.min(100, pct(a.end));
        const cls = ["cell"];
        if (a.end <= t) cls.push("past");
        else if (a.start <= t) cls.push("now");
        if (a.availability === "policy-blocked" || a.availability === "unavailable") cls.push("unavail");
        if (a.start < viewFrom) cls.push("cut-left");
        if (ri === row && focus && a.start === focus.start) cls.push("focus");
        let head = a.title;
        let sub = [a.episode, a.subtitle, a.year].filter(Boolean).join(" · ");
        const locked = isLocked(ch) || isRedacted(a); // a locked channel's listings stay hidden until the PIN is typed
        if (locked) cls.push("locked");
        // A run of short episodes of one show: lead with the episode, not the same title again.
        if (locked) (head = "Locked"), (sub = "");
        else if (i > 0 && shown[i - 1].title === a.title && a.episode && right - left < 14) {
          head = a.subtitle || a.episode;
          sub = a.subtitle ? a.episode : a.title;
        }
        return html`<div class="${cls.join(" ")}" style="left:calc(${left}% + 2px);width:calc(${right - left}% - 4px)${a.start <= t && t < a.end ? `;--p:${(((t - Math.max(a.start, viewFrom)) / (Math.min(a.end, viewTo) - Math.max(a.start, viewFrom))) * 100).toFixed(1)}%` : ""}" data-row="${ri}" data-start="${a.start}" role="gridcell"
          aria-label="${locked ? "Locked program" : a.title}, ${fmtTime(a.start)}">
          ${a.start < viewFrom ? raw('<span class="cont">◂</span>') : ""}
          ${a.watched ? raw('<span class="watched" title="Watched">✓</span>') : ""}
          ${raw(breakTail(a))}<div class="ct">${head}</div>${sub ? html`<div class="cs">${sub}</div>` : ""}</div>`;
      });
    const nowLine = t >= viewFrom && t < viewTo ? raw(`<div class="now-line" style="left:${pct(t)}%"></div>`) : "";
    // A seasonal channel out of season (N-32) has no listings: say when it's back.
    // The program on now finishes first, so the gap starts where the last listing ends.
    const lastEnd = Math.max(viewFrom, ...r.airings.map((a) => a.end));
    const off = offSeason(ch) && lastEnd < viewTo ? html`<div class="cell offseason ${ri === row && !focus ? "focus" : ""}" style="left:calc(${Math.max(0, pct(lastEnd))}% + 2px);right:2px" data-row="${ri}" data-start="0" role="gridcell" aria-label="${ch.name} is off season">
      <div class="ct">Off season</div><div class="cs">${backOn(ch) ? `Back ${backOn(ch)}` : datesLabel(ch.season)}</div></div>` : "";
    return html`<div class="row ${tv.current?.id === ch.id ? "current" : ""}" style="--h:${ch.hue}" role="row">
      <div class="row-label" data-tune="${ri}"><span class="n">${ch.number}</span><span class="nm">${ch.favorite ? raw('<b class="fav" title="Favorite">★</b>') : ""}${isLocked(ch) ? raw('<b class="lk" title="Locked">🔒</b>') : ""}${wordmark(ch) ?? ch.name}<span class="tg">${ch.season ? html`<b class="season-tag" title="On the air ${datesLabel(ch.season)}">◷ ${datesLabel(ch.season)}</b>` : ch.tagline}</span></span></div>
      <div class="row-track">${raw(cells.join(""))}${off}${nowLine}</div></div>`;
  });

  grid.innerHTML = html`<div class="grid-times">${raw(times.join(""))}</div>
    <div class="grid-rows"><div class="grid-scroll" style="transform:translateY(calc(${-scrollRow} * var(--row)))">${raw(rows.join(""))}</div></div>`;

  dateEl.textContent = new Date(viewFrom).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  clockEl.textContent = fmtTime(t);
  renderDetails(data.rows[row]?.channel, focus);
  schedulePreview(data.rows[row]?.channel, focus);
  if (fitRows()) render();
}

/** The slot padding after a program, drawn as a hatched tail so long breaks are visible. */
function breakTail(a) {
  const pad = a.segments?.filter((x) => x.kind === "break" && x.reason === "padding" && x.end - x.start >= 2 * MIN);
  if (!pad?.length) return "";
  const from = Math.min(...pad.map((x) => x.start));
  const left = ((from - a.start) / (a.end - a.start)) * 100;
  return `<i class="tail" style="left:${left.toFixed(2)}%" title="Station break"></i>`;
}

/** Fit a whole number of rows so the last one is never cut in half. */
let fittedTo = 0;
function fitRows() {
  const h = grid.querySelector(".grid-rows")?.clientHeight;
  if (!h || h === fittedTo) return false;
  fittedTo = h;
  grid.style.removeProperty("--row");
  const n = Math.max(1, Math.round(h / rowPx()));
  grid.style.setProperty("--row", `${h / n}px`);
  return true;
}

function rowPx() {
  const probe = grid.querySelector(".row");
  return probe ? probe.getBoundingClientRect().height : 50;
}

const offSeason = (ch) => !!ch?.season && ch.season.inSeason === false;
const backOn = (ch) => (ch.season?.nextChangeMs ? new Date(ch.season.nextChangeMs).toLocaleDateString(undefined, { month: "long", day: "numeric" }) : "");

function renderDetails(ch, a) {
  if (ch && !a && offSeason(ch)) {
    details.style.setProperty("--h", ch.hue);
    details.innerHTML = html`<div class="when">Off season<span class="on-ch"><b>${ch.number}</b>${ch.name}</span></div>
      <div class="t">${ch.name}</div>
      <div class="desc">A seasonal channel: on the air ${datesLabel(ch.season) === "All year" ? "all year" : `${datesLabel(ch.season)} each year`}.${backOn(ch) ? ` Back on ${backOn(ch)}.` : ""} Nothing airs until then, so there's nothing to fetch.</div>`.html;
    return;
  }
  if (!ch || !a) return void (details.innerHTML = "");
  if (isLocked(ch) || isRedacted(a)) {
    details.style.setProperty("--h", ch.hue);
    details.innerHTML = html`<div class="when">${fmtTime(a.start)} – ${fmtTime(a.end)}<span class="on-ch"><b>${ch.number}</b>${ch.name}</span></div>
      <div class="t">🔒 Locked</div><div class="desc">This channel is locked. Tune to it and type the PIN to see what's on.</div>
      <div class="act"><kbd>OK</kbd> tune to this channel</div>`.html;
    return;
  }
  const t = now();
  const state = a.end <= t ? "Ended" : a.start <= t ? `On now · ${Math.round((a.end - t) / MIN)} min left` : `Starts in ${fmtDur(a.start - t)}`;
  const bits = [a.episode && html`<span>${a.episode}</span>`, a.year && html`<span>${a.year}</span>`, a.genre && html`<span>${a.genre}</span>`,
    a.rating && html`<span class="rating">${a.rating}</span>`,
    a.durationMs && html`<span>${fmtDur(a.durationMs)}</span>`, formatChips(a), a.watched && raw('<span class="badge ok">✓ Watched</span>'),
    a.availability === "policy-blocked" && raw('<span class="badge bad">Refused by provider</span>'),
    a.availability === "unavailable" && raw('<span class="badge warn">Unavailable</span>'),
    a.availability === "playable" && a.provider !== "demo" && raw('<span class="badge ok">Plays</span>')].filter(Boolean);
  const pad = a.segments?.find((x) => x.kind === "break" && x.reason === "padding" && x.end - x.start >= 2 * MIN);
  const onNow = a.start <= t && t < a.end;
  const pct = onNow ? clamp((t - a.start) / (a.end - a.start), 0, 1) * 100 : 0;
  // Local files may bring art (N-01c): a backdrop behind the text and a poster beside it.
  const back = artOf(a, "fanart", "thumb");
  const poster = artOf(a, "poster");
  details.style.setProperty("--h", ch.hue);
  details.innerHTML = html`${raw(artImg(back, "gd-back"))}${poster ? html`<div class="gd-poster" data-art-box>${raw(artImg(poster, ""))}</div>` : ""}
    <div class="when">${fmtTime(a.start)} – ${fmtTime(a.end)}<span class="on-ch"><b>${ch.number}</b>${ch.name}</span></div>
    <div class="t">${a.title}</div>
    <div class="s">${raw(bits.join(""))}</div>
    ${a.description ? html`<div class="plot">${a.description}</div>` : ""}
    ${a.group ? html`<div class="gd-group"><b>${a.group.name}</b>${a.group.description ? html` · ${a.group.description}` : ""}</div>` : ""}
    <div class="desc">${a.subtitle ? html`“${a.subtitle}”. ` : ""}${state}.${pad ? ` Ends at ${fmtTime(pad.start)}, then a station break until ${fmtTime(pad.end)}.` : ""}</div>
    ${onNow ? raw(`<div class="prog"><i style="width:${pct.toFixed(1)}%"></i></div>`) : ""}
    <div class="act"><kbd>OK</kbd> ${onNow ? "watch now" : "tune to this channel"}</div>`;
}

// ------------------------------------------------------------------ preview (N-14)
// NostalgiaTV can change channel as you move through the guide ("hover tuning"). Here
// that would open media for every row the highlight passes, and the guide's promise is
// zero provider calls and zero bytes (audit A05). So the preview window shows what the
// station clock already knows about the highlighted channel: its mark, what's on, how far
// in, and the program's own art when the file has some. The picture stays on the channel
// you're watching until you press OK. Pref guidePreview: false turns it off.

const previewEl = root.querySelector(".guide-preview");
const slate = Object.assign(document.createElement("div"), { className: "gp-slate", hidden: true });
slate.setAttribute("aria-hidden", "true");
previewEl.append(slate);
let previewTimer = 0;
let previewKey = "";

function clearPreview() {
  clearTimeout(previewTimer);
  previewKey = "";
  slate.hidden = true;
  previewEl.classList.remove("previewing");
  label.textContent = "Now watching";
}
const label = previewEl.querySelector(".preview-label");

/** Waits for the highlight to rest (250 ms) so scrolling past rows doesn't flicker. */
function schedulePreview(ch, a) {
  const t = now();
  const live = a && a.start <= t && t < a.end;
  const want = pref("guidePreview") !== false && ch && ch.id !== tv.current?.id;
  const key = want ? `${ch.id}:${live ? a.start : "x"}` : "";
  if (key === previewKey) return void (key && paintPreview(ch, live ? a : null, false));
  clearTimeout(previewTimer);
  previewKey = key;
  if (!key) return clearPreview();
  previewTimer = setTimeout(() => paintPreview(ch, live ? a : null, true), slate.hidden ? 250 : 120);
}

function paintPreview(ch, a, fresh) {
  const t = now();
  const locked = isLocked(ch) || (a && isRedacted(a));
  const art = locked ? null : artOf(a, "fanart", "thumb");
  const pct = a ? clamp((t - a.start) / (a.end - a.start), 0, 1) * 100 : 0;
  const left = a ? Math.max(1, Math.round((a.end - t) / MIN)) : 0;
  const sub = a && !locked ? [a.episode, a.subtitle && `“${a.subtitle}”`, a.year].filter(Boolean).join(" · ") : "";
  slate.style.setProperty("--h", ch.hue);
  slate.classList.toggle("has-art", !!art);
  slate.innerHTML = html`${raw(artImg(art, "gp-art"))}
    <div class="gp-top"><span class="gp-num">${ch.number}</span><span class="gp-name">${wordmark(ch) ?? ch.name}</span></div>
    <div class="gp-mid">
      ${locked ? html`<div class="gp-t">🔒 Locked</div><div class="gp-s">Tune in and type the PIN to watch.</div>`
        : a ? html`<div class="gp-k">On now</div><div class="gp-t">${a.title}</div>${sub ? html`<div class="gp-s">${sub}</div>` : ""}`
        : offSeason(ch) ? html`<div class="gp-k">Off season</div><div class="gp-t">${ch.name}</div>${backOn(ch) ? html`<div class="gp-s">Back ${backOn(ch)}</div>` : ""}`
        : html`<div class="gp-k">Coming up</div><div class="gp-t">${ch.name}</div>`}
    </div>
    ${a && !locked ? html`<div class="gp-bar"><i style="width:${pct.toFixed(1)}%"></i></div><div class="gp-left">${left} min left · <kbd>OK</kbd> watch</div>` : ""}`.html;
  if (fresh) {
    slate.hidden = false;
    slate.style.animation = "none";
    void slate.offsetWidth;
    slate.style.animation = "";
    previewEl.classList.add("previewing");
    label.textContent = "Preview · from the schedule";
  }
}

// ------------------------------------------------------------------ input

export function guideKey(e) {
  if (!data) return false;
  const k = e.key;
  // The toolbar (Now, Settings): a remote reaches it with Up from the top row.
  const tl = tools();
  const ti = tl.indexOf(document.activeElement);
  if (ti >= 0) {
    if (k === "ArrowLeft" || k === "ArrowRight") tl[clamp(ti + (k === "ArrowRight" ? 1 : -1), 0, tl.length - 1)].focus();
    else if (k === "ArrowDown") leaveTools();
    else if (k === "Enter") document.activeElement.click();
    else if (k !== "ArrowUp") return false;
    return true;
  }
  if (k === "ArrowUp" && row === 0) {
    root.classList.add("in-tools");
    tl.at(-1)?.focus({ focusVisible: true });
    return true;
  }
  if (/^[0-9]$/.test(k)) return jumpKey(k), true;
  const list = data.rows[row]?.airings ?? [];
  const cur = airingAt(row, at);
  const idx = list.indexOf(cur);
  if (k === "ArrowDown" || k === "ArrowUp" || k === "PageDown" || k === "PageUp") {
    const step = k === "PageDown" ? 6 : k === "PageUp" ? -6 : k === "ArrowDown" ? 1 : -1;
    row = clamp(row + step, 0, data.rows.length - 1);
  } else if (k === "ArrowRight") {
    const nx = list[idx + 1];
    if (nx && nx.start < data.to) {
      at = nx.start + 1;
      if (nx.start >= viewFrom + span() - 15 * MIN) viewFrom = floor30(nx.start) - 30 * MIN;
    }
  } else if (k === "ArrowLeft") {
    const pv = list[idx - 1];
    const floor = floor30(now());
    if (pv && pv.end > floor - 30 * MIN) {
      at = Math.max(pv.start, floor - 30 * MIN) + 1;
      if (pv.start < viewFrom) viewFrom = Math.max(floor - 30 * MIN, floor30(pv.start));
    } else if (viewFrom > floor) viewFrom = floor;
  } else if (k === "Home") {
    viewFrom = floor30(now());
    at = now();
  } else if (k === "Enter" || k === "OK") {
    pick(row, cur);
    return true;
  } else return false;
  render();
  return true;
}

function leaveTools() {
  document.activeElement?.blur();
  root.classList.remove("in-tools");
}

root.querySelector(".guide-tools").addEventListener("click", (e) => {
  const act = e.target.closest("[data-gt]")?.dataset.gt;
  if (act === "settings") {
    closeGuide();
    openPanel();
  } else if (act === "ondemand") {
    closeGuide();
    openOnDemand();
  } else if (act === "now") {
    leaveTools();
    guideKey({ key: "Home" });
  }
});

// Digits jump the highlight to a channel number, like typing it on a cable box guide.
let jump = "";
let jumpTimer = 0;
function jumpKey(d) {
  jump = (jump + d).slice(-3);
  jumpEl.textContent = jump.padEnd(2, "-");
  jumpEl.classList.add("on");
  clearTimeout(jumpTimer);
  const n = Number(jump);
  const go = () => {
    const r = data.rows.findIndex((x) => x.channel.number === n);
    jump = "";
    if (r < 0) {
      jumpEl.textContent = `No ${n}`;
      jumpTimer = setTimeout(() => jumpEl.classList.remove("on"), 1200);
      return;
    }
    jumpEl.classList.remove("on");
    row = r;
    render();
  };
  const longer = data.rows.some((x) => String(x.channel.number).startsWith(jump) && x.channel.number !== n);
  if (!longer && data.rows.some((x) => x.channel.number === n)) return go();
  jumpTimer = setTimeout(go, 1200);
}

function pick(r, a) {
  const ch = data.rows[r]?.channel;
  const target = tv.channels.find((c) => c.id === ch?.id);
  if (!target) return;
  closeGuide();
  if (a && a.start > now()) toast(`${a.title} starts at ${fmtTime(a.start)}. Tuning to ${target.name} now.`);
  if (tv.current?.id !== target.id) tune(target);
}

grid.addEventListener("click", (e) => {
  const label = e.target.closest("[data-tune]");
  if (label) return pick(Number(label.dataset.tune), null);
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const r = Number(cell.dataset.row);
  const start = Number(cell.dataset.start);
  if (cell.classList.contains("focus")) return pick(r, airingAt(r, start + 1));
  row = r;
  at = start + 1;
  render();
});
grid.addEventListener("wheel", (e) => {
  if (!data) return;
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) guideKey({ key: e.deltaX > 0 ? "ArrowRight" : "ArrowLeft" });
  else {
    row = clamp(row + Math.sign(e.deltaY), 0, data.rows.length - 1);
    render();
  }
}, { passive: false });
addEventListener("resize", () => guideOpen() && render());

// Touch: swipe the grid up/down for channels, left/right for time. The rows follow
// the finger and the guide re-renders on release: replacing the touched cell mid-
// gesture would end the gesture (a detached node gets no more touch events).
let touch = null;
grid.addEventListener("touchstart", (e) => {
  const p = e.touches[0];
  touch = { x: p.clientX, y: p.clientY, dy: 0, scroll: grid.querySelector(".grid-scroll") };
}, { passive: true });
grid.addEventListener("touchmove", (e) => {
  if (!touch || !data) return;
  const p = e.touches[0];
  touch.dy = touch.y - p.clientY;
  if (Math.abs(touch.dy) > Math.abs(touch.x - p.clientX) && touch.scroll) {
    e.preventDefault();
    touch.scroll.style.transition = "none";
    touch.scroll.style.translate = `0 ${-touch.dy}px`;
  }
}, { passive: false });
grid.addEventListener("touchend", (e) => {
  if (!touch || !data) return;
  const p = e.changedTouches[0];
  const dx = touch.x - p.clientX;
  const dy = touch.y - p.clientY;
  touch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return void guideKey({ key: dx > 0 ? "ArrowRight" : "ArrowLeft" });
  const rows = Math.round(dy / rowPx());
  if (!rows) return void render();
  // Move the view with the finger, and the highlight along with it.
  scrollRow = clamp(scrollRow + rows, 0, data.rows.length - 1);
  row = clamp(row + rows, 0, data.rows.length - 1);
  render();
});
