// PIN-locked channels (parity N-06b). A locked channel airs on schedule but the set
// shows a scrambled picture and fetches nothing (player.js skips the link and the
// media; the server refuses them too and redacts the listings). Typing the PIN
// unlocks every locked channel for 4 hours.
//
// Server contract (workstream C, app/pinlock.ts):
//   channelView and settings carry `locked` (only while a PIN exists) and `unlocked`;
//   settings also `pinSet` and `alsoOn: [{ id, number, name, programs }]`.
//   GET  /api/lock          -> { pinSet, unlocked, untilMs, retryAfterMs?, lockedChannels }
//   POST /api/lock/pin      { pin (4–8 digits) | null, old? }
//   POST /api/lock/unlock   { pin } -> 200 { ok, untilMs } | 403 { retryAfterMs? } | 429 { retryAfterMs }
//   POST /api/lock/lock     relocks.
//   Writes that change what airs answer 403 { pinRequired: true } while locked: askPin(), then retry.
//   Redacted airings: { itemId: null, locked: true, title: "Locked", rating: null }.
// After an unlock this module marks tv.channels and fires `debridtv:unlocked` { channelId: null }.

import { api } from "./api.js";
import { html } from "./util.js";
import { tv } from "./player.js";
import { keepFocus } from "./spatial.js";

export const PIN_MIN = 4, PIN_MAX = 8;
export const isLocked = (ch) => !!ch?.locked && !ch?.unlocked;
/** A guide or now airing the server redacted. */
export const isRedacted = (a) => !!a?.locked || (a && a.itemId === null && a.title === "Locked");

export async function lockStatus() {
  try {
    return await api.get("/api/lock");
  } catch {
    return null; // this build has no locks yet
  }
}

/** Sets, changes (old) or removes (pin null) the PIN. Returns null on success, else a sentence to show. */
export async function setPin(pin, old) {
  if (pin !== null && !new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin)) return `A PIN is ${PIN_MIN} to ${PIN_MAX} digits.`;
  try {
    await api.post("/api/lock/pin", old ? { pin, old } : { pin });
    return null;
  } catch (e) {
    if (e.status === 429) return `Too many tries. Wait ${Math.ceil((e.data?.retryAfterMs ?? 30_000) / 1000)} seconds.`;
    return e.status === 403 ? "That isn't the current PIN." : `Couldn't set the PIN: ${e.message}`;
  }
}

/** Tries a PIN. Returns { ok, untilMs } or { ok: false, message, retryAfterMs }. */
export async function unlock(pin) {
  try {
    const r = await api.post("/api/lock/unlock", { pin });
    for (const c of tv.channels) if (c.locked) c.unlocked = true;
    dispatchEvent(new CustomEvent("debridtv:unlocked", { detail: { channelId: null, untilMs: r.untilMs ?? null } }));
    return { ok: true, untilMs: r.untilMs ?? null };
  } catch (e) {
    const retryAfterMs = Number(e.data?.retryAfterMs) || 0;
    if (e.status === 429) return { ok: false, retryAfterMs, message: "Too many tries." };
    return { ok: false, retryAfterMs, message: e.status === 403 ? "Wrong PIN." : `Couldn't check the PIN: ${e.message}` };
  }
}

export async function relock() {
  try {
    await api.post("/api/lock/lock");
  } catch {}
  for (const c of tv.channels) if (c.locked) c.unlocked = false;
  dispatchEvent(new CustomEvent("debridtv:relocked"));
}

// ------------------------------------------------------------------ PIN dialog
// For settings writes the server refuses while locked (403 pinRequired): ask, unlock, retry.

const dlg = document.createElement("div");
dlg.className = "ced pin-dlg";
dlg.hidden = true;
dlg.setAttribute("role", "dialog");
dlg.setAttribute("aria-modal", "true");
dlg.setAttribute("aria-label", "Enter the PIN");
document.body.append(dlg);
let ask = null; // { entry, resolve, msg, until, busy }

export const pinDialogOpen = () => !dlg.hidden;

/** Shows a PIN pad over everything. Resolves true once unlocked, false if dismissed. */
export function askPin(reason = "Settings are locked.") {
  if (ask) return ask.promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  ask = { entry: "", resolve, promise, msg: "", until: 0, busy: false, reason, last: document.activeElement };
  dlg.hidden = false;
  drawDlg();
  dlg.querySelector('[data-pin="OK"]')?.focus();
  return promise;
}

function closeDlg(ok) {
  if (!ask) return;
  dlg.hidden = true;
  const { resolve, last } = ask;
  ask = null;
  last?.focus?.();
  resolve(ok);
}

function drawDlg() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"];
  const wait = Math.max(0, ask.until - Date.now());
  keepFocus(dlg, () => (dlg.innerHTML = html`<div class="lock-panel">
    <div class="lock-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor"/><circle cx="12" cy="15.5" r="1.7" fill="#05060f"/></svg></div>
    <div class="card-kicker">Parental PIN</div>
    <div class="lock-reason">${ask.reason} Type the PIN to go on.</div>
    <div class="lock-dots">${Array.from({ length: Math.max(PIN_MIN, ask.entry.length) }, (_, i) => html`<i class="${i < ask.entry.length ? "on" : ""}"></i>`)}</div>
    <div class="lock-msg" role="status">${wait ? `${ask.msg} Try again in ${Math.ceil(wait / 1000)} s.` : ask.msg}</div>
    <div class="lock-pad">${keys.map((k) => html`<button data-pin="${k}" aria-label="${k === "⌫" ? "Delete" : k === "OK" ? "Unlock" : k}" ${wait && k === "OK" ? "disabled" : ""}>${k}</button>`)}</div>
    <button class="btn" data-pin-cancel>Cancel</button>
  </div>`.html));
  if (wait) setTimeout(() => ask && drawDlg(), Math.min(1000, wait));
}

async function dlgKey(k) {
  if (!ask || ask.busy) return;
  if (/^[0-9]$/.test(k)) ask.entry = (ask.entry + k).slice(0, PIN_MAX);
  else if (k === "⌫" || k === "Backspace") ask.entry = ask.entry.slice(0, -1);
  else if (k === "OK" || k === "Enter") {
    if (ask.entry.length < PIN_MIN || Date.now() < ask.until) return;
    ask.busy = true;
    const r = await unlock(ask.entry);
    if (!ask) return;
    ask.busy = false;
    if (r.ok) return closeDlg(true);
    ask.entry = "";
    ask.msg = r.message;
    ask.until = Date.now() + r.retryAfterMs;
    drawDlg();
    const p = dlg.querySelector(".lock-panel");
    p.classList.add("shake");
    return;
  } else return;
  ask.msg = "";
  drawDlg();
}

dlg.addEventListener("click", (e) => {
  if (e.target === dlg || e.target.closest("[data-pin-cancel]")) return closeDlg(false);
  const b = e.target.closest("[data-pin]");
  if (b) dlgKey(b.dataset.pin);
});
addEventListener("keydown", (e) => {
  if (!pinDialogOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.key === "Escape") closeDlg(false);
  // OK on a remote presses the pad key it is on; the arrows (spatial.js) move between keys.
  else if (e.key === "Enter" && dlg.contains(document.activeElement) && document.activeElement.matches("[data-pin], [data-pin-cancel]")) document.activeElement.click();
  else dlgKey(e.key);
}, true);

/** Runs a settings write; if the server wants the PIN first, asks for it and tries once more. */
export async function withPin(write, reason) {
  try {
    return await write();
  } catch (e) {
    if (e.status !== 403 || !e.data?.pinRequired) throw e;
    if (!(await askPin(reason))) throw Object.assign(new Error("The PIN wasn't entered."), { cancelled: true });
    return await write();
  }
}
