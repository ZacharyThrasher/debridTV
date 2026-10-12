// Skip intro, Skip credits and Next episode (Lean-back pack). A button over the corner of
// the picture while the program is in a part its chapter titles name (skips.js), and a
// Next episode button in the credits or the last half minute. They are offers: nothing
// skips or moves on unless the viewer asks, or turns that on in Settings.
//
// Costs nothing extra: chapter titles come with /api/item (a local call), the next
// episode from /api/ondemand/after and the station clock (/api/now), and pressing a
// button is an ordinary seek or tune.

import { api } from "./api.js";
import { html, pref } from "./util.js";
import * as player from "./player.js";
import { tv } from "./player.js";
import { signedOff } from "./signoff.js";
import { osd } from "./ui.js";
import { guideOpen } from "./guide.js";
import { panelOpen } from "./panel.js";
import { onDemandOpen } from "./ondemand.js";
import { activeLayer } from "./spatial.js";
import { skipParts, partAt, SKIP_LABEL } from "./skips.js";
import { sleepAtEnd, sleepNow } from "./sleep.js";

const NEXT_LEAD_MS = 30_000; // without named credits, Next episode shows for the last 30 s

const box = Object.assign(document.createElement("div"), { id: "lean", className: "lean", hidden: true });
box.setAttribute("role", "group");
box.setAttribute("aria-label", "Skip and next");
document.body.append(box);

const blocked = () => guideOpen() || panelOpen() || onDemandOpen() || signedOff() || !document.getElementById("welcome").hidden || !!activeLayer();

// ------------------------------------------------------------------ what the file says

let item = { id: null, parts: [] };
async function loadItem(id) {
  item = { id, parts: [] };
  try {
    const it = await api.get(`/api/item?id=${encodeURIComponent(id)}`);
    if (item.id !== id) return;
    item.parts = skipParts(it.chaptersMs ?? [], it.chapterNames ?? [], it.durationMs ?? 0);
  } catch {}
}

// ------------------------------------------------------------------ the next episode

let next = { key: null, value: undefined }; // value: undefined = not asked yet, null = none
const epLine = (v) => [v.label, v.subtitle].filter(Boolean).join(" · ");

/**
 * What Next episode does for the program on screen: { sub, go } or null.
 * In On Demand it plays the show's next episode. On a channel it skips ahead to the next
 * program when that is the next episode, else it plays the next episode in On Demand.
 */
async function findNext(t) {
  let after = null;
  try {
    after = (await api.get(`/api/ondemand/after?id=${encodeURIComponent(t.itemId)}`)).next;
  } catch {}
  if (!after) return null;
  const onDemand = { sub: epLine(after), go: () => player.playOnDemand(after.id, { item: after }) };
  const ch = tv.current;
  const a = tv.info?.airing;
  if (t.mode === "ondemand" || !ch || !a?.end) return onDemand;
  let nx = null;
  try {
    nx = (await api.get(`/api/now?channel=${encodeURIComponent(ch.id)}&at=${Math.round(a.end + 1)}`)).airing;
  } catch {}
  const sameShow = nx && (nx.itemId === after.id || (nx.title === after.title && nx.episode === after.label));
  return sameShow ? { sub: epLine(after), go: () => player.skipProgram(1) } : onDemand;
}

function wantNext(t) {
  const key = `${t.mode === "ondemand" ? "od" : tv.current?.id}:${t.itemId}`;
  if (next.key === key) return next.value;
  next = { key, value: undefined };
  findNext(t).then((v) => next.key === key && (next.value = v), () => next.key === key && (next.value = null));
  return undefined;
}

// ------------------------------------------------------------------ drawing

let shown = ""; // what the box holds now, so it is only redrawn on a change
let autoSkipped = new Set(); // parts skipped on their own, so rewinding into one doesn't skip it again

function tick() {
  const t = player.timeline?.();
  if (!t || blocked() || tv.paused) return hide();
  if (t.itemId !== item.id) loadItem(t.itemId);
  const part = pref("skipButtons") === false ? null : partAt(item.parts, t.posMs);
  if (part && (part.kind === "intro" || part.kind === "recap") && pref("autoSkipIntro") === true) {
    const key = `${t.itemId}:${part.from}`;
    if (!autoSkipped.has(key)) {
      autoSkipped.add(key);
      osd(part.kind === "intro" ? "INTRO" : "RECAP", "Skipped", 1800);
      return void skip(part, t);
    }
  }
  const credits = item.parts.find((p) => p.kind === "credits" || p.kind === "preview");
  const nearEnd = t.durMs > 0 && t.posMs < t.durMs && (credits ? t.posMs >= credits.from : t.posMs >= t.durMs - NEXT_LEAD_MS);
  const nx = nearEnd && t.itemId ? wantNext(t) : null;
  const buttons = [];
  if (part) buttons.push(["skip", SKIP_LABEL[part.kind], ""]);
  if (nx) buttons.push(["next", "Next episode", nx.sub]);
  const key = buttons.map((b) => b.join("|")).join("/");
  if (!buttons.length) return hide();
  if (key !== shown) {
    shown = key;
    // The last button is the main one (Next episode over Skip credits): OK presses it.
    box.innerHTML = html`${buttons.map(([act, label, sub], i) => html`<button class="lean-btn ${i === buttons.length - 1 ? "main" : ""}" data-lean="${act}"><b>${label}</b>${sub ? html`<small>${sub}</small>` : ""}</button>`)}`.html;
  }
  box.hidden = false;
}
setInterval(tick, 400);

function hide() {
  if (box.hidden) return;
  if (box.contains(document.activeElement)) document.activeElement.blur();
  box.hidden = true;
  box.innerHTML = "";
  shown = "";
}

/** Past a part. Credits that run to the end of the file go on to what's next. */
function skip(part, t) {
  const toEnd = !Number.isFinite(part.to) || (t.durMs > 0 && part.to >= t.durMs - 1000);
  if (!toEnd) return void player.seekTo(part.to);
  if (t.mode !== "ondemand") return void player.skipProgram(1);
  const nx = next.value;
  if (nx) return nx.go();
  player.seekTo(t.durMs);
}

function press(act) {
  const t = player.timeline?.();
  if (!t) return;
  if (act === "skip") {
    const part = partAt(item.parts, t.posMs);
    if (part) skip(part, t);
  } else if (act === "next") next.value?.go();
  hide();
}

box.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lean]");
  if (!b) return;
  e.stopPropagation();
  press(b.dataset.lean);
});
// Keep a click on the box from reaching the picture (which toggles the bar).
box.addEventListener("pointerup", (e) => e.stopPropagation());

// OK on the remote presses the main button while one shows, as on a streaming box.
// Registered in the capture phase (main.js imports this after the control bar), so
// OK doesn't also open the guide.
addEventListener("keydown", (e) => {
  if (box.hidden || blocked() || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== "Enter") return;
  const bar = document.getElementById("pbar");
  const focus = document.activeElement;
  if (bar?.contains(focus) || (focus && focus !== document.body && !box.contains(focus))) return;
  const btn = box.contains(focus) && focus.matches("[data-lean]") ? focus : box.querySelector(".lean-btn.main");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  press(btn.dataset.lean);
}, true);

// ------------------------------------------------------------------ end of an On Demand file

// The sleep timer set to "end of this program" signs off here; otherwise, with "Play the
// next episode on its own" turned on, the next one starts. Else the station comes back.
player.onOnDemandEnd(() => {
  if (sleepAtEnd()) return sleepNow(), true;
  if (pref("autoNext") !== true || !tv.onDemand) return false;
  const t = player.timeline();
  if (!t?.itemId) return false;
  const known = next.key === `od:${t.itemId}` ? next.value : undefined;
  const go = (nx) => (nx ? (osd("NEXT EPISODE", nx.sub, 2500), nx.go()) : player.backToLive());
  if (known !== undefined) go(known);
  else findNext(t).then(go, () => player.backToLive());
  return true;
});
