// Channel editor: identity (name, number, logo, favorite), schedule (weekday time
// slots, restricted hours) and audience (kid channel, after-hours rating limit).
// Parity N-03, N-06a, N-09a, N-16. Opened from Settings → Channels → Edit.
//
// Data contract (workstream C): GET and POST /api/channels/:id/settings with
//   { name, number, favorite, logo: null | { kind: "badge"|"text", text (≤6), hue?, style? } | { kind: "image", url: data: URL },
//     kid, maxRating?, restrictedHours: [{ from, to, maxRating }],
//     slots: [{ days: [1..7], from: "HH:MM", to: "HH:MM", source }] }
// Until that endpoint exists, the editor runs on a local draft and says so.

import { api } from "./api.js";
import { html, raw, toast, clamp } from "./util.js";
import { tv } from "./player.js";

const root = document.createElement("div");
root.className = "ced";
root.hidden = true;
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-label", "Edit channel");
document.body.append(root);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RATINGS = ["G", "PG", "PG-13", "R", "NC-17"];
const LOGO_STYLES = { block: "Block", outline: "Outline", pill: "Pill" };

let ch = null; // channel being edited (from tv.channels)
let draft = null;
let tab = "identity";
let onSaved = null;
let live = true; // false when the server has no settings endpoint yet
let info = null; // { enforced, timeZone, ratings } from the server, never sent back
let lastFocus = null;

export const editorOpen = () => !root.hidden;

export async function openChannelEditor(channel, opts = {}) {
  ch = channel;
  onSaved = opts.onSaved ?? null;
  tab = opts.tab ?? "identity";
  lastFocus = document.activeElement;
  draft = defaults(channel);
  live = true;
  try {
    const { enforced, timeZone, ratings, note, specialsAvailable, ...got } = await api.get(`/api/channels/${encodeURIComponent(channel.id)}/settings`);
    info = { enforced, timeZone, ratings, specialsAvailable: Number(specialsAvailable) || 0 };
    // Normalise: the server sends null for "not set" (logo, lists), which the form treats as defaults.
    for (const k of Object.keys(got)) if (got[k] == null) delete got[k];
    draft = { ...draft, ...got };
    draft.logo ??= defaults(channel).logo;
    draft.restrictedHours = Array.isArray(draft.restrictedHours) ? draft.restrictedHours : [];
    draft.slots = Array.isArray(draft.slots) ? draft.slots.map((x) => ({ ...x, days: Array.isArray(x.days) ? x.days : [] })) : [];
  } catch (e) {
    live = false;
    info = null;
  }
  root.hidden = false;
  document.body.classList.add("ced-open");
  render();
  root.querySelector("[data-first]")?.focus();
}

export function closeChannelEditor() {
  root.hidden = true;
  document.body.classList.remove("ced-open");
  lastFocus?.focus?.();
}

const wordFrom = (d) => (d.logo?.text && d.logo.kind === "text" ? d.logo.text : d.name.replace(/^the\s+/i, "").split(/\s+/)[0].slice(0, 6).toUpperCase());

function defaults(c) {
  return {
    name: c.name, number: c.number, favorite: !!c.favorite,
    logo: c.logo ?? { kind: "badge", text: String(c.number), hue: c.hue, style: "block" },
    kid: !!c.kid, restrictedHours: [], slots: [],
  };
}

// ------------------------------------------------------------------ render

function render() {
  const tabs = { identity: "Identity", schedule: "Schedule", audience: "Audience" };
  root.innerHTML = html`<div class="ced-sheet" style="--h:${draft.logo?.hue ?? ch.hue}">
    <header class="ced-head">
      ${raw(logoHtml(draft, "lg"))}
      <div class="ced-title"><div class="k">Edit channel</div><div class="t">${draft.name || "Untitled"}</div></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <nav class="tabs" role="tablist">${Object.entries(tabs).map(([k, v]) => html`<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${v}</button>`)}</nav>
    <div class="ced-body">${raw(({ identity, schedule, audience })[tab]())}</div>
    <footer class="ced-foot">
      ${live ? "" : html`<span class="muted">Preview only: this build can't save channel settings yet.</span>`}
      <span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save ${live ? "" : "disabled"}>Save</button>
    </footer>
  </div>`.html;
}

/** A channel's mark: its logo when it has one, else the number badge. Shared look with the guide. */
export function logoHtml(c, size = "") {
  const l = c.logo;
  if (l?.kind === "image" && /^data:image\//.test(l.url ?? "")) return html`<img class="logo img ${size}" src="${l.url}" alt="${c.name}">`.html;
  if (l?.kind === "text" && l.text) return html`<span class="logo ${l.style || "block"} ${size}" style="--h:${l.hue ?? c.hue ?? 220}">${l.text}</span>`.html;
  return html`<span class="logo badge ${size}" style="--h:${l?.hue ?? c.hue ?? 220}">${c.number}</span>`.html;
}

function identity() {
  const taken = tv.channels.find((c) => c.number === Number(draft.number) && c.id !== ch.id);
  const l = draft.logo ?? { kind: "badge" };
  return html`
    <div class="field"><label for="ced-name">Name</label><input id="ced-name" class="input" data-k="name" data-first value="${draft.name}" maxlength="40"></div>
    <div class="ced-row">
      <div class="field"><label for="ced-num">Channel number</label>
        <input id="ced-num" class="input" data-k="number" type="number" min="1" max="999" value="${draft.number}">
        ${taken ? html`<span class="ced-warn">${taken.name} is on ${draft.number}. Saving swaps them.</span>` : ""}</div>
      <div class="opt" style="border:0;align-self:end"><div><div class="ol">Favorite</div><div class="od">Listed first in the guide, with a star.</div></div>
        <label class="switch"><input type="checkbox" data-k="favorite" ${draft.favorite ? "checked" : ""}><i></i></label></div>
    </div>
    <h4>Logo</h4>
    <div class="seg" role="radiogroup" aria-label="Logo kind">
      <button role="radio" data-logo-kind="badge" aria-checked="${l.kind !== "text"}">Number badge</button>
      <button role="radio" data-logo-kind="text" aria-checked="${l.kind === "text"}">Wordmark</button>
      <button role="radio" data-logo-kind="image" aria-checked="${l.kind === "image"}">Image</button>
    </div>
    ${l.kind === "image" ? html`<div class="field"><label for="ced-img">Logo image (PNG, JPEG, WebP or SVG, up to 200 KB). It stays on this PC.</label>
      <input id="ced-img" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo-file></div>` : ""}
    ${l.kind === "text" ? html`
      <div class="ced-row">
        <div class="field"><label for="ced-lt">Wordmark (up to 6 letters)</label><input id="ced-lt" class="input" data-logo="text" maxlength="6" value="${l.text ?? ""}"></div>
        <div class="field"><label>Style</label><div class="seg">${Object.entries(LOGO_STYLES).map(([k, v]) =>
          html`<button data-logo-style="${k}" aria-pressed="${(l.style || "block") === k}">${v}</button>`)}</div></div>
      </div>` : ""}
    ${l.kind === "image" ? "" : html`<div class="field"><label for="ced-hue">Color</label><input id="ced-hue" class="hue" type="range" min="0" max="359" data-logo="hue" value="${l.hue ?? ch.hue}"></div>`}
    <h4>Preview</h4>
    <div class="ced-preview">
      <div class="pv-bug">${raw(logoHtml(draft))}<span>${draft.name}</span></div>
      <div class="pv-row" style="--h:${l.hue ?? ch.hue}">${raw(logoHtml(draft, "sm"))}<span class="nm">${draft.favorite ? "★ " : ""}${draft.name}</span></div>
    </div>`.html;
}

function schedule() {
  const slots = draft.slots;
  const sources = sourceOptions();
  return html`
    <p class="lead">Pin what plays at set times, like Saturday-morning cartoons. Outside its slots the channel plays its usual lineup.${info?.timeZone ? ` Times are in ${info.timeZone}.` : ""} Changes start when the program on now ends.</p>
    ${info?.specialsAvailable > 0 ? html`<div class="opt"><div><div class="ol">Include specials</div>
      <div class="od">${info.specialsAvailable} season 0 episode${info.specialsAvailable === 1 ? "" : "s"}. They air after the last season.</div></div>
      <label class="switch"><input type="checkbox" data-k="specials" ${draft.specials ? "checked" : ""}><i></i></label></div>` : ""}
    ${raw(weekStrip(slots))}
    <div class="list ced-slots">${slots.length ? slots.map((s, i) => html`<div class="slot">
      <div class="days">${DAYS.map((d, di) => html`<button data-slot-day="${i}:${di + 1}" aria-pressed="${s.days.includes(di + 1)}">${d.slice(0, 2)}</button>`)}</div>
      <input class="input" type="time" data-slot="${i}:from" value="${s.from}" aria-label="From">
      <span class="muted">to</span>
      <input class="input" type="time" data-slot="${i}:to" value="${s.to}" aria-label="To">
      <select class="input" data-slot="${i}:source" aria-label="What plays">${sources.map((o) => html`<option value="${o.value}" ${o.value === s.source ? "selected" : ""}>${o.label}</option>`)}</select>
      <button class="icon-btn" data-slot-del="${i}" aria-label="Remove slot">✕</button></div>`) : html`<div class="muted">No time slots yet.</div>`}</div>
    <button class="btn" data-slot-add data-first>+ Add a time slot</button>`.html;
}

function audience() {
  const rh = draft.restrictedHours;
  const rt = info?.ratings;
  const cover = rt ? html`<div class="ced-cover">
      <div class="bars">${Object.entries(rt.byRating).filter(([, n]) => n).map(([k, n]) =>
        html`<i class="r-${k.toLowerCase().replace(/[^a-z0-9]/g, "")}" style="flex:${n}" title="${k}: ${n}"><b>${k === "unrated" ? "?" : k}</b></i>`)}</div>
      <div class="muted">${rt.total} programs: ${rt.total - rt.unrated} rated, ${rt.unrated} with no rating.</div>
      ${draft.kid && rt.total - rt.kidSafe > 0 ? html`<div class="ced-warn">As a kid channel it airs ${rt.kidSafe} of ${rt.total}. ${rt.unrated ? `${rt.unrated} have no rating, so they won't air.` : ""}</div>` : ""}
      ${rt.unrated ? html`<button class="linkish" data-ratings>Set ratings in Library → Ratings</button>` : ""}
    </div>` : "";
  return html`${cover}
    <div class="opt"><div><div class="ol">Kid channel</div><div class="od">Only plays programs rated G, PG, TV-Y, TV-Y7 or TV-G. Unrated programs are left out.</div></div>
      <label class="switch"><input type="checkbox" data-k="kid" data-first ${draft.kid ? "checked" : ""}><i></i></label></div>
    <h4>Daytime limit</h4>
    <p class="lead">Keep stronger programs for late at night. Between these times the channel skips anything rated above the limit; the rest of the night, anything in its lineup can play.</p>
    <div class="list">${rh.map((r, i) => html`<div class="slot">
      <span class="muted">Between</span><input class="input" type="time" data-rh="${i}:from" value="${r.from}" aria-label="From">
      <span class="muted">and</span><input class="input" type="time" data-rh="${i}:to" value="${r.to}" aria-label="To">
      <span class="muted">allow up to</span>
      <select class="input" data-rh="${i}:maxRating" aria-label="Highest rating">${RATINGS.map((x) => html`<option ${x === r.maxRating ? "selected" : ""}>${x}</option>`)}</select>
      <button class="icon-btn" data-rh-del="${i}" aria-label="Remove">✕</button></div>`)}</div>
    ${rh.length ? "" : html`<button class="btn" data-rh-add>+ Add a daytime limit</button>`}
    <p class="muted" style="margin-top:1.2em">Ratings come from your files' metadata where present. DebridTV never looks them up online.</p>`.html;
}

/** Seven lanes of 24 hours; slots drawn as blocks so overlaps are obvious. */
function weekStrip(slots) {
  const mins = (hhmm) => {
    const [h, m] = String(hhmm || "0:0").split(":").map(Number);
    return clamp(h * 60 + (m || 0), 0, 1440);
  };
  const lanes = DAYS.map((d, di) => {
    const day = di + 1;
    const yesterday = day === 1 ? 7 : day - 1;
    const blocks = slots.flatMap((s, si) => {
      const a = mins(s.from), b = mins(s.to);
      const parts = [];
      if (s.days.includes(day)) parts.push(b > a ? [a, b] : [a, 1440]);
      if (b <= a && b > 0 && s.days.includes(yesterday)) parts.push([0, b]); // overnight slots run into the next day
      return parts.map(([x, y]) => `<i style="left:${(x / 14.4).toFixed(2)}%;width:${((y - x) / 14.4).toFixed(2)}%;--k:${si}"></i>`);
    });
    return `<div class="lane"><span>${d}</span><div>${blocks.join("")}</div></div>`;
  });
  const ticks = [0, 6, 12, 18, 24].map((h) => `<b style="left:${(h / 24) * 100}%">${h === 24 ? "" : h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`}</b>`);
  return `<div class="week" aria-hidden="true">${lanes.join("")}<div class="ticks">${ticks.join("")}</div></div>`;
}

function sourceOptions() {
  const shows = tv.channels.filter((c) => c.kind === "show").map((c) => ({ value: c.ruleKey, label: c.name }));
  const mixes = tv.channels.filter((c) => c.kind !== "show" && c.id !== ch.id).map((c) => ({ value: c.ruleKey, label: `Same as ${c.name}` }));
  return [...shows, ...mixes];
}

// ------------------------------------------------------------------ input

root.addEventListener("click", async (e) => {
  const b = e.target.closest("button, [data-close]");
  if (e.target === root) return closeChannelEditor();
  if (!b) return;
  const d = b.dataset;
  if (d.close !== undefined) return closeChannelEditor();
  if (d.tab) tab = d.tab;
  else if (d.logoKind) draft.logo = d.logoKind === "image" ? { ...draft.logo, kind: "image" } : { ...draft.logo, kind: d.logoKind, text: d.logoKind === "text" ? wordFrom(draft) : String(draft.number) };
  else if (d.logoStyle) draft.logo = { ...draft.logo, style: d.logoStyle };
  else if (d.slotAdd !== undefined) draft.slots = [...draft.slots, { days: [6], from: "08:00", to: "11:00", source: sourceOptions()[0]?.value ?? "" }];
  else if (d.slotDel) draft.slots = draft.slots.filter((_, i) => i !== Number(d.slotDel));
  else if (d.slotDay) {
    const [i, day] = d.slotDay.split(":").map(Number);
    const s = draft.slots[i];
    s.days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
  } else if (d.rhAdd !== undefined) draft.restrictedHours = [{ from: "06:00", to: "22:00", maxRating: "PG-13" }];
  else if (d.rhDel) draft.restrictedHours = draft.restrictedHours.filter((_, i) => i !== Number(d.rhDel));
  else if (d.save !== undefined) return save();
  else if (d.ratings !== undefined) {
    closeChannelEditor();
    return import("./panel.js").then((m) => m.openPanel("library", "ratings"));
  }
  else return;
  render();
  (root.querySelector(d.tab ? `[data-tab="${d.tab}"]` : "[data-first]") ?? root.querySelector("button"))?.focus();
});

root.addEventListener("change", (e) => {
  const t = e.target;
  if (!t.matches?.("[data-logo-file]") || !t.files?.[0]) return;
  const f = t.files[0];
  if (f.size > 200_000) return toast("That image is over 200 KB. Try a smaller one.");
  const rd = new FileReader();
  rd.onload = () => {
    draft.logo = { kind: "image", url: String(rd.result), hue: draft.logo.hue };
    render();
  };
  rd.readAsDataURL(f);
});

root.addEventListener("input", (e) => {
  const t = e.target;
  if (t.type === "file") return;
  const d = t.dataset;
  if (d.k) draft[d.k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
  else if (d.logo) draft.logo = { ...draft.logo, [d.logo]: d.logo === "hue" ? Number(t.value) : t.value };
  else if (d.slot) {
    const [i, k] = d.slot.split(":");
    draft.slots[Number(i)][k] = t.value;
  } else if (d.rh) {
    const [i, k] = d.rh.split(":");
    draft.restrictedHours[Number(i)][k] = t.value;
  } else return;
  // Re-render previews without stealing focus from the field being typed in.
  if (t.type === "range" || t.type === "checkbox" || t.tagName === "SELECT" || t.type === "time") {
    const sel = t.id || null;
    render();
    if (sel) document.getElementById(sel)?.focus();
  } else refreshPreview();
});

function refreshPreview() {
  const sheet = root.querySelector(".ced-sheet");
  const fresh = document.createElement("div");
  const keepTab = tab;
  fresh.innerHTML = html`${raw(logoHtml(draft, "lg"))}`.html;
  sheet.querySelector(".ced-head .logo").replaceWith(fresh.firstElementChild);
  sheet.querySelector(".ced-title .t").textContent = draft.name || "Untitled";
  if (keepTab === "identity") {
    const pv = document.createElement("div");
    pv.innerHTML = identity();
    sheet.querySelector(".ced-preview").replaceWith(pv.querySelector(".ced-preview"));
    const warn = pv.querySelector(".ced-warn");
    const old = sheet.querySelector(".ced-warn");
    if (old) old.remove();
    if (warn) document.getElementById("ced-num").after(warn);
  }
}

// Escape closes from anywhere (a re-render can drop focus to the page); the remote's
// other keys are ignored by main.js while the editor is open.
addEventListener("keydown", (e) => {
  if (!editorOpen() || e.key !== "Escape") return;
  e.preventDefault();
  closeChannelEditor();
}, true);

async function save() {
  if (!draft.name.trim()) return toast("Give the channel a name.");
  if (!(draft.number >= 1 && draft.number <= 999)) return toast("Channel numbers run from 1 to 999.");
  const body = { ...draft };
  if (body.logo?.kind === "badge") body.logo = { kind: "badge", text: String(body.number), hue: body.logo.hue };
  if (body.logo?.kind === "text" && !body.logo.text?.trim()) return toast("Type a wordmark, or pick the number badge.");
  if (body.logo?.kind === "image" && !body.logo.url) return toast("Choose an image, or pick another kind of logo.");
  let res;
  try {
    res = await api.post(`/api/channels/${encodeURIComponent(ch.id)}/settings`, body);
  } catch (e) {
    return toast(`Couldn't save: ${e.message}`);
  }
  closeChannelEditor();
  toast(`Saved ${draft.name}.${res?.note ? ` ${res.note}` : ""}`);
  onSaved?.(draft);
}
