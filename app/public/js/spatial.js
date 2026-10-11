// Remote control navigation for the 10-foot screen. A TV remote has arrows, OK,
// Back and digits: no Tab key and no mouse. Inside any open layer (a dialog, the
// settings panel, the welcome card) the arrows move focus to the nearest control in
// that direction, OK presses it, and Back closes the layer. On the stage and in the
// guide, main.js and guide.js keep their own keys.
//
// TV mode (pref `tv`: "auto" | "on" | "off") makes type and targets bigger and keeps
// everything inside the overscan safe area. "auto" turns it on for TV browsers, for
// ?tv=1, and for screens without a hovering pointer that are wide enough to be a TV.

import { pref, onPrefsApplied } from "./util.js";

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const TYPING = 'input:not([type]), input[type="text"], input[type="search"], input[type="password"], input[type="number"], input[type="url"], input[type="email"], input[type="tel"], textarea, [contenteditable="true"]';

// ------------------------------------------------------------------ TV mode

const TV_UA = /\b(SMART-TV|SmartTV|Tizen|Web0S|webOS|NetCast|BRAVIA|AFT[A-Z]|CrKey|GoogleTV|Android TV|AndroidTV|HbbTV|Roku|PlayStation|Xbox|VIDAA|Opera TV)\b/i;
const query = new URLSearchParams(location.search);

/** True when the screen should be laid out for a couch. */
export function tvMode() {
  const p = String(pref("tv") ?? "auto");
  if (p === "on") return true;
  if (p === "off") return false;
  if (query.has("tv")) return query.get("tv") !== "0";
  return TV_UA.test(navigator.userAgent) || (matchMedia("(hover: none) and (pointer: none)").matches && innerWidth >= 960);
}

function applyTv() {
  document.documentElement.classList.toggle("tv", tvMode());
}
applyTv();
onPrefsApplied(applyTv);

// Show focus rings only for the remote: a key press turns them on, a mouse click off.
addEventListener("keydown", () => document.documentElement.classList.add("remote"), true);
addEventListener("pointerdown", (e) => e.pointerType === "mouse" && document.documentElement.classList.remove("remote"), true);

// ------------------------------------------------------------------ layers

const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
const zOf = (el) => {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const z = Number(getComputedStyle(n).zIndex);
    if (Number.isFinite(z)) return z;
  }
  return 0;
};

/** The open layer that owns the remote: the top modal dialog, then the welcome card, then settings. */
export function activeLayer() {
  const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter((m) => !m.hidden && visible(m));
  if (modals.length) return modals.reduce((a, b) => (zOf(b) >= zOf(a) ? b : a));
  for (const id of ["welcome", "panel"]) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return el;
  }
  return null;
}

export const isTyping = (el) => !!el?.matches?.(TYPING);

/** Back on a TV remote: webOS sends keyCode 461, Tizen 10009, Android TV "GoBack". */
export const isBackKey = (e) => ["GoBack", "BrowserBack", "Back", "XF86Back"].includes(e.key) || e.keyCode === 461 || e.keyCode === 10009;

/** Controls a remote can land on inside `root`, in reading order. */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.disabled || el.closest("[hidden], [inert]") || el.getAttribute("aria-hidden") === "true") return false;
    if (el.matches('input[type="file"]') && el.closest("label")) return false; // the label is the button
    const r = rectOf(el);
    if (r.right - r.left < 2 || r.bottom - r.top < 2) return false;
    return visible(el);
  });
}

function rectOf(el) {
  // A checkbox drawn as a switch or a chip hides its input; measure what is drawn.
  const shown = el.matches("input") && getComputedStyle(el).opacity === "0" ? el.closest("label") ?? el : el;
  const r = shown.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
}

const gapOf = (a1, a2, b1, b2) => (b2 < a1 ? a1 - b2 : b1 > a2 ? b1 - a2 : 0);

/** How far `b` is from `a` going `dir`; Infinity when it isn't that way at all. */
function distance(dir, a, b) {
  const horiz = dir === "left" || dir === "right";
  const ahead = { down: b.cy > a.cy + 1 && b.bottom > a.bottom - 1, up: b.cy < a.cy - 1 && b.top < a.top + 1, right: b.cx > a.cx + 1 && b.right > a.right - 1, left: b.cx < a.cx - 1 && b.left < a.left + 1 }[dir];
  if (!ahead) return Infinity;
  const main = Math.max(0, { down: b.top - a.bottom, up: a.top - b.bottom, right: b.left - a.right, left: a.left - b.right }[dir]);
  const cross = horiz ? gapOf(a.top, a.bottom, b.top, b.bottom) : gapOf(a.left, a.right, b.left, b.right);
  // Left/Right stay on the same line: a control a row up or down is Up/Down's job.
  if (horiz && cross > Math.max(8, (a.bottom - a.top) * 0.5)) return Infinity;
  const align = horiz ? Math.abs(a.cy - b.cy) : Math.abs(a.cx - b.cx);
  // Staying in line matters more than being close: a control straight below beats one
  // slightly nearer but off to the side, like moving through a form on a TV.
  return main + cross * 4 + align * 0.15;
}

const DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

function focusEl(el) {
  el.focus({ preventScroll: true, focusVisible: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Moves focus `dir` inside `root`. Returns false when there is nowhere to go. */
export function move(root, dir, from = document.activeElement) {
  const all = focusables(root);
  if (!all.length) return false;
  if (!from || !root.contains(from) || from === root) {
    focusEl(nearest(all, lastSpot.get(root)) ?? preferred(root, all));
    return true;
  }
  const a = rectOf(from);
  let best = null;
  let bestD = Infinity;
  for (const el of all) {
    if (el === from) continue;
    // A control scrolled out of its list is only reachable from inside that list,
    // so Down from a footer button doesn't dive to the hidden end of a list above it.
    const sc = scroller(el, root);
    if (sc && !sc.contains(from) && clipped(el, sc)) continue;
    const d = distance(dir, a, rectOf(el));
    if (d < bestD) {
      bestD = d;
      best = el;
    }
  }
  if (best) {
    focusEl(best);
    return true;
  }
  // Nothing that way: scroll text that has no controls in it, so it can still be read.
  const sc = scroller(from, root);
  if (sc && (dir === "up" || dir === "down")) {
    const before = sc.scrollTop;
    sc.scrollBy({ top: (dir === "down" ? 1 : -1) * sc.clientHeight * 0.4, behavior: "smooth" });
    return sc.scrollTop !== before || true;
  }
  return false;
}

function scroller(el, root) {
  for (let n = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
    const s = getComputedStyle(n).overflowY;
    if ((s === "auto" || s === "scroll") && n.scrollHeight > n.clientHeight + 2) return n;
  }
  return null;
}

function clipped(el, sc) {
  const r = rectOf(el);
  const b = sc.getBoundingClientRect();
  return r.bottom <= b.top + 2 || r.top >= b.bottom - 2;
}

function preferred(root, all) {
  return root.querySelector('[aria-selected="true"]:not([hidden])') ?? root.querySelector("[data-first]") ?? all[0];
}

function nearest(all, spot) {
  if (!spot) return null;
  let best = null;
  let bestD = Infinity;
  for (const el of all) {
    const r = rectOf(el);
    const d = Math.hypot(r.cx - spot.cx, r.cy - spot.cy);
    if (d < bestD) {
      bestD = d;
      best = el;
    }
  }
  return best;
}

// Where focus last was in each layer, so a redraw that drops focus can put it back nearby.
const lastSpot = new WeakMap();
addEventListener("focusin", (e) => {
  const layer = activeLayer();
  if (layer?.contains(e.target)) lastSpot.set(layer, rectOf(e.target));
});

/** Runs a redraw of `box` and keeps the remote's place: the same control if it is still there, else the nearest. */
export function keepFocus(box, redraw) {
  const had = document.activeElement;
  if (!had || !box.contains(had) || had === box) return redraw();
  const key = keyOf(had);
  const spot = rectOf(had);
  const out = redraw();
  const restore = () => {
    if (box.contains(document.activeElement) && document.activeElement !== box) return;
    const all = focusables(box);
    const same = all.find((el) => keyOf(el) === key);
    const el = same ?? nearest(all, spot);
    if (el) el.focus({ preventScroll: true, focusVisible: document.documentElement.classList.contains("remote") });
  };
  if (out && typeof out.then === "function") return out.then((v) => (restore(), v));
  restore();
  return out;
}

/** A control's identity across redraws: its id, else its tag, data attributes and label. */
function keyOf(el) {
  if (el.id) return `#${el.id}`;
  const data = Object.entries(el.dataset).map(([k, v]) => `${k}=${v}`).join("&");
  return `${el.tagName}|${el.getAttribute("name") ?? ""}|${data}|${data ? "" : (el.textContent ?? "").trim().slice(0, 40)}`;
}

// ------------------------------------------------------------------ keys

function caretAtEdge(el, dir) {
  try {
    const { selectionStart: s, selectionEnd: e, value } = el;
    if (s == null) return true; // number inputs have no caret API
    if (s !== e) return false;
    return dir === "left" || dir === "up" ? s === 0 : s === value.length;
  } catch {
    return true;
  }
}

/** Arrow inside a control: does the control keep it (moving a caret, a slider, a choice)? */
function controlKeeps(el, dir) {
  const horiz = dir === "left" || dir === "right";
  if (el.matches('input[type="range"]')) return horiz;
  if (el.matches("textarea")) return !caretAtEdge(el, dir);
  if (isTyping(el)) return horiz && !caretAtEdge(el, dir);
  return false;
}

/** Left/Right on a closed select steps through its choices, like a TV settings menu. */
function stepSelect(sel, dir) {
  const opts = [...sel.options];
  let i = sel.selectedIndex;
  do i += dir === "right" ? 1 : -1;
  while (opts[i]?.disabled);
  if (i < 0 || i >= opts.length) return;
  sel.selectedIndex = i;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

const press = (el) => el.matches('input[type="checkbox"], input[type="radio"], [role="button"], [role="tab"], [role="option"], [role="switch"], summary, label') || (el.matches("[tabindex]") && !el.matches("button, a, input, select, textarea"));

function synth(target, key) {
  (target ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

// Registered before every other module's key handler (main.js imports this first). Arrows
// and OK only preventDefault; Back is swallowed and re-sent as the key each layer expects.
addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const layer = activeLayer();
  const t = document.activeElement;
  // Back: Escape inside a layer and the guide, Backspace (last channel) on the stage.
  if (isBackKey(e)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    // In a text field, Back just leaves the field (and the TV's on-screen keyboard).
    if (isTyping(t)) return t.blur();
    // Sent from the page, not the focused control: main.js treats Escape on a select as "leave the field".
    return synth(document.body, layer || !document.getElementById("guide")?.hidden ? "Escape" : "Backspace");
  }
  if (!layer) return;
  // Backspace also means back inside a layer, except while typing or on a PIN pad.
  if (e.key === "Backspace" && !isTyping(t) && !layer.matches(".pin-dlg")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return synth(document.body, "Escape");
  }
  const dir = DIRS[e.key];
  if (dir) {
    if (t && layer.contains(t) && t !== layer) {
      if (controlKeeps(t, dir)) return;
      if (t.matches("select") && (dir === "left" || dir === "right")) {
        e.preventDefault();
        return stepSelect(t, dir);
      }
    }
    // preventDefault only: later listeners (sign-off's activity clock) still see the key.
    e.preventDefault();
    move(layer, dir, t);
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && t && layer.contains(t) && press(t) && !(e.key === " " && t.matches("input"))) {
    e.preventDefault();
    t.click();
  }
}, true);
