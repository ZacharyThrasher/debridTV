// On Demand (parity N-30): Continue Watching, browse and search the library outside
// the live lineup. Browsing reads only the local library (/api/ondemand, /api/continue),
// so it costs zero provider calls and zero media bytes, like the guide. Media is
// requested only when a program is picked, and then by the player (workstream A).
//
// It is a modal layer, so spatial.js gives it remote navigation: arrows move between
// tiles, OK opens or plays, Back steps out (sheet, then show, then the layer).

import { api } from "./api.js";
import { html, raw, fmtDur, fmtClock, toast, ago } from "./util.js";
import * as player from "./player.js";
import { artOf, artImg, formatChips } from "./ui.js";
import { keepFocus } from "./spatial.js";

const MIN = 60_000;
const root = document.createElement("section");
root.id = "ondemand";
root.className = "vod";
root.hidden = true;
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-label", "On Demand");
document.body.append(root);

let state = { kind: "all", q: "", show: null, season: null }; // show = key of the open show
let lists = null; // { shows, movies }
let cont = []; // Continue Watching items
let showData = null; // the open show
let missing = false; // the server has no On Demand yet
let searchTimer = 0;
let returnFocus = null;
const heroes = new Map(); // data-k -> { kind, item|show }
let nowPlaying = null;

export const onDemandOpen = () => !root.hidden;
/** The program picked here that the player is showing, for the banner. */
export const onDemandItem = () => nowPlaying;

export async function openOnDemand({ show = null } = {}) {
  returnFocus = document.activeElement;
  root.hidden = false;
  document.body.classList.add("od-open");
  state = { ...state, show, season: null };
  root.innerHTML = html`<div class="od-loading">Loading your library…</div>`.html;
  await Promise.all([loadLists(), loadContinue(), show ? loadShow(show) : null]);
  render();
  focusFirst();
}

export function closeOnDemand() {
  if (root.hidden) return;
  root.hidden = true;
  document.body.classList.remove("od-open");
  clearTimeout(searchTimer);
  if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
}

// ------------------------------------------------------------------ data

async function loadLists() {
  try {
    lists = await api.get(`/api/ondemand?kind=${state.kind}&q=${encodeURIComponent(state.q)}`);
    missing = false;
  } catch (e) {
    lists = { shows: [], movies: [] };
    missing = e.status === 404;
  }
}
async function loadContinue() {
  try {
    cont = (await api.get("/api/continue?limit=20")).items ?? [];
  } catch {
    cont = [];
  }
}
async function loadShow(key) {
  try {
    showData = await api.get(`/api/ondemand/show?key=${encodeURIComponent(key)}`);
    const next = showData.nextUp?.season;
    state.season = state.season ?? next ?? showData.seasons[0]?.season ?? null;
  } catch (e) {
    showData = null;
    state.show = null;
    toast(`Couldn't open that show: ${e.message}`);
  }
}

// ------------------------------------------------------------------ helpers

const HUE_CACHE = new Map();
function hueOf(s) {
  if (HUE_CACHE.has(s)) return HUE_CACHE.get(s);
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const hue = (h >>> 0) % 360;
  HUE_CACHE.set(s, hue);
  return hue;
}
const left = (it) => (it.durationMs && it.resumeMs != null ? Math.max(1, Math.round((it.durationMs - it.resumeMs) / MIN)) : null);
const pct = (it) => (it.durationMs ? Math.min(100, ((it.resumeMs ?? (it.watched ? it.durationMs : 0)) / it.durationMs) * 100) : 0);
const blocked = (it) => it.availability === "policy-blocked" || it.availability === "unavailable";
const epName = (it) => it.subtitle || it.label || it.title;

/** A cover drawn from the title when the file has no art: a hue band, the title, a spine. */
function cover(title, sub, hueKey = title) {
  // Long words shrink the type rather than break mid-word ("WEATHERVA-NE").
  const longest = Math.max(...String(title).split(/\s+/).map((w) => w.length));
  const fit = Math.min(1, 9 / Math.max(1, longest)).toFixed(2);
  return html`<span class="od-cover" style="--h:${hueOf(hueKey)};--fit:${fit}" aria-hidden="true"><span class="od-cover-t">${title}</span>${sub ? html`<span class="od-cover-s">${sub}</span>` : ""}</span>`;
}

function meta(it) {
  return [it.label && html`<span class="ep">${it.label}</span>`, it.year && html`<span>${it.year}</span>`, it.genre && html`<span>${it.genre}</span>`,
    it.rating && html`<span class="rating">${it.rating}</span>`, it.durationMs && html`<span>${fmtDur(it.durationMs)}</span>`, raw(formatChips(it)),
    it.watched && raw('<span class="badge ok">✓ Watched</span>'), blocked(it) && html`<span class="badge bad">${it.availability === "policy-blocked" ? "Refused by provider" : "Unavailable"}</span>`]
    .filter((x) => x && String(x));
}

// ------------------------------------------------------------------ render

function render() {
  heroes.clear();
  const body = state.show && showData ? renderShow() : renderHome();
  root.innerHTML = html`
    <div class="od-backdrop" data-art-box></div>
    <header class="od-head">
      <div class="brand"><span class="brand-mark"></span>DebridTV</div>
      <h1 class="od-name">On Demand</h1>
      <label class="od-search"><span aria-hidden="true">⌕</span><input type="search" id="od-q" placeholder="Search shows, films, episodes" value="${state.q}" autocomplete="off" spellcheck="false" aria-label="Search the library"></label>
      <div class="od-filter" role="tablist" aria-label="Show">
        ${["all", "show", "movie"].map((k) => html`<button role="tab" data-kind="${k}" aria-selected="${String(state.kind === k && !state.show)}">${{ all: "All", show: "Shows", movie: "Movies" }[k]}</button>`)}
      </div>
      <button class="od-close" data-close><span aria-hidden="true">✕</span> Back to TV</button>
    </header>
    <div class="od-hero" aria-live="polite"></div>
    <div class="od-body">${body}</div>`.html;
  const first = root.querySelector("[data-k]");
  hero(first?.dataset.k);
}

function renderHome() {
  if (missing) return html`<div class="od-empty"><b>On Demand isn't on this server yet.</b><span>Update DebridTV to browse your library here. The channels work as before.</span></div>`;
  const shows = lists?.shows ?? [];
  const movies = lists?.movies ?? [];
  const eps = state.q ? (lists?.episodes ?? []) : [];
  const out = [];
  if (!state.q && state.kind === "all" && cont.length) {
    out.push(html`<section class="od-shelf"><h2>Continue watching</h2><div class="od-rail" role="list">${cont.map((it) => contCard(it))}</div></section>`);
  }
  if (shows.length) out.push(html`<section class="od-shelf"><h2>Shows <small>${shows.length}</small></h2><div class="od-grid" role="list">${shows.map(showTile)}</div></section>`);
  if (eps.length) out.push(html`<section class="od-shelf"><h2>Episodes <small>${eps.length}</small></h2><div class="od-rail" role="list">${eps.map((e) => contCard(e, "x"))}</div></section>`);
  if (movies.length) out.push(html`<section class="od-shelf"><h2>Movies <small>${movies.length}</small></h2><div class="od-grid" role="list">${movies.map(movieTile)}</div></section>`);
  if (!out.length) {
    out.push(state.q
      ? html`<div class="od-empty"><b>Nothing matches “${state.q}”.</b><span>Try part of a title, or an episode name.</span></div>`
      : html`<div class="od-empty"><b>Your library is empty.</b><span>Connect a source in Settings, then scan it. Shows and films appear here as they're found.</span></div>`);
  }
  return html`${out}`;
}

/** A wide card: Continue Watching, and episodes found by a search ("x"). */
function contCard(it, prefix = "c") {
  const k = `${prefix}:${it.id}`;
  heroes.set(k, { kind: prefix === "c" ? "continue" : "found", item: it });
  const art = artOf(it, "thumb", "fanart");
  const when = it.reason === "next" ? "Up next" : left(it) ? `${left(it)} min left` : it.watched ? "Watched" : it.durationMs ? fmtDur(it.durationMs) : "";
  const sub = [it.label, when].filter(Boolean).join(" · ");
  // The drawn cover already carries the title, so the caption names the episode instead.
  const name = art ? it.title : it.kind === "episode" ? `“${epName(it)}”` : it.year ? String(it.year) : it.title;
  return html`<button class="od-card ${art ? "has-art" : ""} ${blocked(it) ? "blocked" : ""}" data-k="${k}" data-play="${it.id}" role="listitem" style="--h:${hueOf(it.showKey ?? it.title)}" data-art-box>
    ${art ? raw(artImg(art, "od-card-art")) : cover(it.title, "", it.showKey ?? it.title)}
    <span class="od-card-text"><b>${name}</b><span>${sub}</span></span>
    ${it.reason === "next" ? raw('<span class="od-tag">NEW</span>') : it.resumeMs != null ? raw(`<span class="od-prog"><i style="width:${pct(it).toFixed(1)}%"></i></span>`) : ""}
  </button>`;
}

function showTile(s) {
  const k = `s:${s.key}`;
  heroes.set(k, { kind: "show", show: s });
  const art = artOf(s, "poster");
  const done = s.episodes && s.watchedCount >= s.episodes;
  return html`<button class="od-tile ${art ? "has-art" : ""}" data-k="${k}" data-show="${s.key}" role="listitem" aria-label="${s.name}, ${s.episodes} episodes" data-art-box>
    ${art ? raw(artImg(art, "od-tile-art")) : cover(s.name, `${s.episodes} episodes`)}
    ${s.watchedCount ? raw(`<span class="od-tile-bar" title="${s.watchedCount} of ${s.episodes} watched"><i style="width:${((s.watchedCount / s.episodes) * 100).toFixed(1)}%"></i></span>`) : ""}
    ${done ? raw('<span class="od-tick" title="All watched">✓</span>') : ""}
  </button>`;
}

function movieTile(m) {
  const k = `m:${m.id}`;
  heroes.set(k, { kind: "movie", item: m });
  const art = artOf(m, "poster");
  return html`<button class="od-tile ${art ? "has-art" : ""} ${blocked(m) ? "blocked" : ""}" data-k="${k}" data-play="${m.id}" role="listitem" aria-label="${m.title}${m.year ? `, ${m.year}` : ""}" data-art-box>
    ${art ? raw(artImg(art, "od-tile-art")) : cover(m.title, m.year)}
    ${m.resumeMs != null ? raw(`<span class="od-tile-bar"><i style="width:${pct(m).toFixed(1)}%"></i></span>`) : ""}
    ${m.watched ? raw('<span class="od-tick" title="Watched">✓</span>') : ""}
  </button>`;
}

function renderShow() {
  const s = showData;
  const season = s.seasons.find((x) => x.season === state.season) ?? s.seasons[0];
  const nx = s.nextUp;
  const total = s.seasons.reduce((n, x) => n + x.episodes.length, 0);
  heroes.set(`h:${s.key}`, { kind: "show", show: { ...s, episodes: total } });
  if (nx) heroes.set(`n:${nx.id}`, { kind: "episode", item: nx });
  const watched = s.seasons.reduce((n, x) => n + x.episodes.filter((e) => e.watched).length, 0);
  const poster = artOf(s, "poster");
  return html`<section class="od-show" style="--h:${hueOf(s.key)}">
    <aside class="od-show-side" aria-hidden="true">
      <div class="od-show-cover ${poster ? "has-art" : ""}" data-art-box>${poster ? raw(artImg(poster, "od-tile-art")) : cover(s.name, `${total} episodes`, s.key)}</div>
      <div class="od-show-stat"><b>${watched}</b> of ${total} watched</div>
      <div class="od-hero-prog"><i style="width:${total ? ((watched / total) * 100).toFixed(1) : 0}%"></i></div>
    </aside>
    <div class="od-show-main">
    <div class="od-show-head">
      <button class="od-crumb" data-home><span aria-hidden="true">‹</span> All shows</button>
      ${nx ? html`<button class="btn primary od-play" data-k="n:${nx.id}" data-play="${nx.id}" data-first>
        ▶ ${nx.resumeMs != null ? "Resume" : "Play"} ${nx.label ?? ""}${nx.subtitle ? html` · “${nx.subtitle}”` : ""}</button>` : html`<span class="od-alldone">✓ You've seen every episode</span>`}
    </div>
    ${s.seasons.length > 1 ? html`<div class="od-seasons" role="tablist" aria-label="Seasons">${s.seasons.map((x) => html`<button role="tab" data-season="${x.season}" aria-selected="${String(x.season === season?.season)}">Season ${x.season}</button>`)}</div>` : ""}
    <ol class="od-eps">${season?.episodes.map((e) => epRow(e)) ?? ""}</ol>
    </div>
  </section>`;
}

function epRow(e) {
  const k = `e:${e.id}`;
  heroes.set(k, { kind: "episode", item: e });
  const art = artOf(e, "thumb");
  return html`<li><button class="od-ep ${e.watched ? "seen" : ""} ${blocked(e) ? "blocked" : ""}" data-k="${k}" data-play="${e.id}" data-art-box>
    <span class="od-ep-n">${e.episode ?? ""}</span>
    ${art ? raw(artImg(art, "od-ep-art")) : ""}
    <span class="od-ep-t"><b>${epName(e)}</b><span>${[e.label, e.durationMs && fmtDur(e.durationMs), left(e) && `${left(e)} min left`].filter(Boolean).join(" · ")}</span></span>
    ${e.watched ? raw('<span class="od-tick" title="Watched">✓</span>') : e.resumeMs != null ? raw(`<span class="od-ep-bar"><i style="width:${pct(e).toFixed(1)}%"></i></span>`) : ""}
  </button></li>`;
}

/** The big panel at the top: whatever the remote is on, with its art behind it. */
function hero(k) {
  const box = root.querySelector(".od-hero");
  const back = root.querySelector(".od-backdrop");
  if (!box) return;
  let h = k ? heroes.get(k) : null;
  if (!h && state.show && showData) h = heroes.get(`h:${showData.key}`);
  if (!h) return void (box.innerHTML = "", back.innerHTML = "");
  const it = h.item;
  const s = h.show;
  let kicker, title, line, plot, prog = "", hint;
  if (s && !it) {
    kicker = s.genre ? `Show · ${s.genre}` : "Show";
    title = s.name;
    line = [html`<span>${s.episodes} episode${s.episodes === 1 ? "" : "s"}</span>`, s.seasons?.length > 1 && html`<span>${s.seasons.length} seasons</span>`,
      s.rating && html`<span class="rating">${s.rating}</span>`, s.watchedCount ? html`<span class="badge ok">${s.watchedCount} watched</span>` : ""].filter(Boolean);
    plot = s.description;
    hint = s.nextUp ? html`Up next: ${s.nextUp.label}${s.nextUp.subtitle ? html` “${s.nextUp.subtitle}”` : ""}` : "";
  } else {
    kicker = h.kind === "continue" ? (it.reason === "next" ? "Up next" : "Continue watching") : it.kind === "movie" ? "Movie" : it.title;
    title = it.kind === "episode" && h.kind === "episode" ? epName(it) : it.title;
    line = meta(it);
    if (it.kind === "episode" && h.kind !== "episode" && it.subtitle) line.unshift(html`<span>“${it.subtitle}”</span>`);
    plot = it.description;
    if (it.resumeMs != null) prog = raw(`<div class="od-hero-prog"><i style="width:${pct(it).toFixed(1)}%"></i></div>`);
    hint = blocked(it) ? (it.availabilityReason || "This file can't be played right now.")
      : it.resumeMs != null ? html`<kbd>OK</kbd> resume from ${fmtClock(it.resumeMs)} · ${left(it)} min left` : html`<kbd>OK</kbd> play${it.watched ? " again" : ""}`;
    if (h.kind === "continue" && it.lastAt) hint = html`${hint}<span class="od-when">Last watched ${ago(it.lastAt)}</span>`;
  }
  if (s && !it) hint = html`<kbd>OK</kbd> open${hint ? html` · ${hint}` : ""}`;
  const subject = it ?? s;
  const backArt = artOf(subject, "fanart", "thumb");
  back.innerHTML = backArt ? artImg(backArt, "od-backdrop-art").html : "";
  back.classList.toggle("has-art", !!backArt);
  root.style.setProperty("--h", hueOf(it?.showKey ?? s?.key ?? it?.title ?? ""));
  box.innerHTML = html`<div class="od-kicker">${kicker}</div><div class="od-t">${title}</div>
    <div class="od-s">${line}</div>${plot ? html`<div class="od-plot">${plot}</div>` : ""}${prog}
    ${hint ? html`<div class="od-hint">${hint}</div>` : ""}`.html;
}

function focusFirst() {
  const el = root.querySelector("[data-first]") ?? root.querySelector(".od-body [data-k]") ?? root.querySelector("#od-q");
  el?.focus({ preventScroll: false, focusVisible: document.documentElement.classList.contains("remote") });
}

// ------------------------------------------------------------------ actions

function find(id) {
  for (const it of cont) if (it.id === id) return it;
  for (const it of lists?.movies ?? []) if (it.id === id) return it;
  for (const it of lists?.episodes ?? []) if (it.id === id) return it;
  for (const s of showData?.seasons ?? []) for (const e of s.episodes) if (e.id === id) return e;
  if (showData?.nextUp?.id === id) return showData.nextUp;
  return null;
}

function choose(it) {
  if (blocked(it)) return toast(it.availabilityReason || "This file can't be played right now.");
  if (it.resumeMs == null) return play(it, 0);
  sheet(it);
}

/** Resume or start over: the only choice a pick asks for. */
function sheet(it) {
  const el = document.createElement("div");
  el.className = "od-sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", it.title);
  el.innerHTML = html`<div class="od-sheet-box">
    <div class="od-kicker">${it.kind === "episode" ? it.title : "Movie"}</div>
    <div class="od-t">${it.kind === "episode" ? epName(it) : it.title}</div>
    <div class="od-hero-prog"><i style="width:${pct(it).toFixed(1)}%"></i></div>
    <div class="od-sheet-acts">
      <button class="btn primary" data-from="${it.resumeMs}" data-first>▶ Resume from ${fmtClock(it.resumeMs)}</button>
      <button class="btn" data-from="0">↺ Start over</button>
    </div></div>`.html;
  root.append(el);
  el.querySelector("[data-first]").focus({ focusVisible: true });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-from]");
    if (b) return closeSheet(), play(it, Number(b.dataset.from));
    if (e.target === el) closeSheet();
  });
}
const sheetEl = () => root.querySelector(".od-sheet");
function closeSheet() {
  const el = sheetEl();
  if (!el) return false;
  const k = el.dataset.k;
  el.remove();
  (root.querySelector(`[data-k="${k}"]`) ?? root.querySelector(".od-body [data-k]"))?.focus({ preventScroll: true });
  return true;
}

function play(it, fromMs) {
  if (typeof player.playOnDemand !== "function") {
    toast("Playing from On Demand comes with the next player update. Until then, find it on a channel.", 5000);
    return;
  }
  nowPlaying = { ...it, fromMs };
  closeOnDemand();
  player.playOnDemand(it.id, { fromMs, item: it });
}

/** A trailer on Coming Attractions (N-23c) points at its film when the film is in the
 * library: W ("Watch it") plays the film from the start through On Demand. */
export function watchFilm(a) {
  const id = a?.trailerFor?.itemId;
  if (!id) return false;
  const name = [a.trailerFor.title ?? a.title, a.trailerFor.year && `(${a.trailerFor.year})`].filter(Boolean).join(" ");
  play({ id, kind: "movie", title: name }, 0);
  return true;
}

async function openShow(key) {
  state.show = key;
  state.season = null;
  await loadShow(key);
  render();
  focusFirst();
}

async function goHome() {
  const was = state.show;
  state.show = null;
  showData = null;
  render();
  (root.querySelector(`[data-show="${CSS.escape(was ?? "")}"]`) ?? root.querySelector(".od-body [data-k]"))?.focus({ preventScroll: false, focusVisible: true });
}

/** Back: the resume sheet, then the show, then the search field, then the layer. */
function back() {
  if (closeSheet()) return;
  if (state.show) return void goHome();
  closeOnDemand();
}

async function search(q) {
  state.q = q;
  await loadLists();
  keepFocus(root.querySelector(".od-body"), () => {
    heroes.clear();
    root.querySelector(".od-body").innerHTML = renderHome().html;
    hero(root.querySelector(".od-body [data-k]")?.dataset.k);
  });
}

root.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || !root.contains(t) || t.closest(".od-sheet")) return;
  if (t.matches("[data-close]")) return closeOnDemand();
  if (t.matches("[data-home]")) return goHome();
  if (t.dataset.kind) {
    state.kind = t.dataset.kind;
    state.show = null;
    showData = null;
    await loadLists();
    keepFocus(root, render);
    return;
  }
  if (t.dataset.season) {
    state.season = Number(t.dataset.season);
    keepFocus(root, render);
    return;
  }
  if (t.dataset.show) return openShow(t.dataset.show);
  if (t.dataset.play) {
    const it = find(t.dataset.play);
    if (it) {
      choose(it);
      const s = sheetEl();
      if (s) s.dataset.k = t.dataset.k;
    }
  }
});
root.addEventListener("focusin", (e) => {
  const k = e.target.closest?.("[data-k]")?.dataset.k;
  if (k) hero(k);
});
// A mouse shows what it points at, but only when it moves: a redraw under a resting
// pointer must not steal the hero from the remote's focus.
let hovered = "";
root.addEventListener("pointermove", (e) => {
  const k = e.target.closest?.("[data-k]")?.dataset.k;
  if (k && k !== hovered && e.pointerType === "mouse") hero(k);
  hovered = k ?? "";
});
root.addEventListener("input", (e) => {
  if (e.target.id !== "od-q") return;
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => search(q), 220);
});

// Keys: after spatial.js (which turns Back into Escape), before main.js and the guide.
addEventListener("keydown", (e) => {
  if (root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const inSearch = t?.id === "od-q";
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (inSearch && t.value) {
      t.value = "";
      return search("");
    }
    if (inSearch) return t.blur();
    return back();
  }
  if (inSearch && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(searchTimer);
    search(t.value.trim()).then(() => root.querySelector(".od-body [data-k]")?.focus({ focusVisible: true }));
    return;
  }
  if (!inSearch && e.key === "/") {
    e.preventDefault();
    root.querySelector("#od-q")?.focus();
  }
}, true);
