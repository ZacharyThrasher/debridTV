// Next-show pre-load (ADR-0006). Late in a program, ask the server for the opening
// bytes of the program that follows on this channel, so the switch starts from
// this PC instead of waiting on the provider. Only for the channel on screen on
// this device, only once the viewer has settled there, never for locked, local,
// demo or refused files. Any channel change, pause, seek, On Demand or sign-off
// cancels it, and dropping the request stops the provider fetch at once.
// Pref preloadNext: false turns it off.

import { now, pref } from "./util.js";

/** How long before the next program starts to fetch its opening bytes. */
export const LEAD_MS = 60_000;
/** A viewer has to stay this long on a channel before anything is fetched ahead (surfing costs nothing). */
export const SETTLE_MS = 10_000;

let timer = 0;
let ctl = null;
let planned = null; // { channelId, itemId }
let settled = { channelId: null, since: 0 };

/** Drop any planned or running pre-load. */
export function cancelPreload() {
  clearTimeout(timer);
  timer = 0;
  planned = null;
  if (ctl) ctl.abort();
  ctl = null;
}

/**
 * Plan the pre-load for what follows the airing in a /api/now answer. Calling it
 * again for the same channel and next program keeps the plan (mid-program break
 * boundaries re-render without restarting anything).
 */
export function planPreload(ch, info) {
  if (!ch || !info || info.onDemand) return cancelPreload();
  if (settled.channelId !== ch.id) settled = { channelId: ch.id, since: now() };
  const a = info.airing;
  const n = info.next;
  const ok = pref("preloadNext") !== false && a && n && n.itemId && n.itemId !== a.itemId && !n.locked && !info.locked
    && n.provider && n.provider !== "demo" && n.provider !== "local"
    && n.availability !== "policy-blocked" && n.availability !== "unavailable";
  if (!ok) return cancelPreload();
  if (planned && planned.channelId === ch.id && planned.itemId === n.itemId) return;
  cancelPreload();
  const startsAt = n.start ?? a.end;
  const at = Math.max(startsAt - LEAD_MS, settled.since + SETTLE_MS);
  if (!startsAt || at >= startsAt - 1000) return;
  planned = { channelId: ch.id, itemId: n.itemId };
  const mine = planned;
  timer = setTimeout(() => run(mine), Math.max(0, at - now()));
}

function run(p) {
  if (planned !== p) return;
  timer = 0;
  const c = new AbortController();
  ctl = c;
  fetch("/api/preload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId: p.itemId }), signal: c.signal })
    .catch(() => {})
    .finally(() => ctl === c && (ctl = null));
}
