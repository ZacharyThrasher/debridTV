// Channel editor: identity (name, number, logo, favorite), schedule (weekday time
// slots, restricted hours) and audience (kid channel, after-hours rating limit).
// Parity N-03, N-06a, N-09a, N-16. Opened from Settings → Channels → Edit.
//
// Data contract (workstream C): GET and POST /api/channels/:id/settings with
//   { name, number, favorite, logo: null | { kind: "badge"|"text", text (≤6), hue?, style? } | { kind: "image", url: data: URL },
//     kid, maxRating?, restrictedHours: [{ from, to, maxRating }],
//     slots: [{ days: [1..7], from: "HH:MM", to: "HH:MM", source }] }
//   Mix (N-09, N-10): weights { [showKey | "films"]: 0..100 } (missing = 50, 0 = never),
//   balance "episodes" | "time", marathons, premieres, watched "all" | "unwatched" | "resume",
//   exclude { shows?, genres? }; GET also returns groups [{ key, name, count, genres }].
//   POST /api/channels/:id/refresh deals a new order from the end of the program on now.
// Until that endpoint exists, the editor runs on a local draft and says so.

import { api } from "./api.js";
import { html, raw, toast, clamp, fmtTime } from "./util.js";
import { tv } from "./player.js";
import { lockStatus, setPin, withPin, PIN_MIN, PIN_MAX } from "./lock.js";

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
let lockInfo = null; // { pinSet } from /api/lock
let pinForm = null; // { old, pin, again } while setting or changing the PIN

export const editorOpen = () => !root.hidden;

export async function openChannelEditor(channel, opts = {}) {
  ch = channel;
  onSaved = opts.onSaved ?? null;
  tab = opts.tab ?? "identity";
  lastFocus = document.activeElement;
  draft = defaults(channel);
  live = true;
  try {
    const { enforced, timeZone, ratings, note, specialsAvailable, groups, unlocked, pinSet, alsoOn, ...got } = await api.get(`/api/channels/${encodeURIComponent(channel.id)}/settings`);
    info = { enforced, timeZone, ratings, specialsAvailable: Number(specialsAvailable) || 0, groups: Array.isArray(groups) ? groups : null, alsoOn: Array.isArray(alsoOn) ? alsoOn : [], pinSet };
    // Normalise: the server sends null for "not set" (logo, lists), which the form treats as defaults.
    for (const k of Object.keys(got)) if (got[k] == null) delete got[k];
    draft = { ...draft, ...got };
    draft.logo ??= defaults(channel).logo;
    draft.restrictedHours = Array.isArray(draft.restrictedHours) ? draft.restrictedHours : [];
    draft.slots = Array.isArray(draft.slots) ? draft.slots.map((x) => ({ ...x, days: Array.isArray(x.days) ? x.days : [] })) : [];
    draft.weights = { ...(draft.weights ?? {}) };
    draft.exclude = { shows: [...(draft.exclude?.shows ?? [])], genres: [...(draft.exclude?.genres ?? [])] };
  } catch (e) {
    live = false;
    info = null;
  }
  lockInfo = await lockStatus(); // null when this build has no locks
  if (lockInfo && typeof info?.pinSet === "boolean") lockInfo.pinSet = info.pinSet;
  pinForm = null;
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
  const tabs = { identity: "Identity", mix: "Mix", schedule: "Schedule", audience: "Audience" };
  root.innerHTML = html`<div class="ced-sheet" style="--h:${draft.logo?.hue ?? ch.hue}">
    <header class="ced-head">
      ${raw(logoHtml(draft, "lg"))}
      <div class="ced-title"><div class="k">Edit channel</div><div class="t">${draft.name || "Untitled"}</div></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <nav class="tabs" role="tablist">${Object.entries(tabs).map(([k, v]) => html`<button role="tab" data-tab="${k}" aria-selected="${String(k === tab)}">${v}</button>`)}</nav>
    <div class="ced-body">${raw(({ identity, mix, schedule, audience })[tab]())}</div>
    <footer class="ced-foot">
      ${live ? "" : html`<span class="muted">Preview only: this build can't save channel settings yet.</span>`}
      <span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save ${live ? "" : "disabled"}>Save</button>
    </footer>
  </div>`.html;
}

/** True when the channel has its own mark (a wordmark or an image), not just the number badge. */
export const hasLogo = (c) => !!((c?.logo?.kind === "text" && c.logo.text) || (c?.logo?.kind === "image" && /^data:image\//.test(c.logo.url ?? "")));

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
        <label class="switch"><input type="checkbox" data-k="favorite" aria-label="Favorite" ${draft.favorite ? "checked" : ""}><i></i></label></div>
    </div>
    <h4>Logo</h4>
    <div class="seg" role="radiogroup" aria-label="Logo kind">
      <button role="radio" data-logo-kind="badge" aria-checked="${String(l.kind !== "text" && l.kind !== "image")}">Number badge</button>
      <button role="radio" data-logo-kind="text" aria-checked="${String(l.kind === "text")}">Wordmark</button>
      <button role="radio" data-logo-kind="image" aria-checked="${String(l.kind === "image")}">Image</button>
    </div>
    ${l.kind === "image" ? html`${ch.art?.logo || ch.art?.poster ? html`<div class="ced-art">
        ${[["logo", "The show's logo"], ["poster", "The show's poster"]].filter(([k]) => ch.art?.[k]).map(([k, label]) => html`<button class="ced-art-pick ${k}" data-art-logo="${k}">
          <img src="${ch.art[k]}" alt="" loading="lazy"><span>${label}</span></button>`)}
        <p class="ced-hint">Found beside the episodes on this PC.</p></div>` : ""}
      <div class="field"><label for="ced-img">${ch.art?.logo || ch.art?.poster ? "Or choose an image" : "Logo image"} (PNG, JPEG, WebP or SVG, up to 200 KB). It stays on this PC.</label>
      <input id="ced-img" class="input" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo-file></div>` : ""}
    ${l.kind === "text" ? html`
      <div class="ced-row">
        <div class="field"><label for="ced-lt">Wordmark (up to 6 letters)</label><input id="ced-lt" class="input" data-logo="text" maxlength="6" value="${l.text ?? ""}"></div>
        <div class="field"><label>Style</label><div class="seg">${Object.entries(LOGO_STYLES).map(([k, v]) =>
          html`<button data-logo-style="${k}" aria-pressed="${String((l.style || "block") === k)}">${v}</button>`)}</div></div>
      </div>` : ""}
    ${l.kind === "image" ? "" : html`<div class="field"><label for="ced-hue">Color</label><input id="ced-hue" class="hue" type="range" min="0" max="359" data-logo="hue" value="${l.hue ?? ch.hue}"></div>`}
    <h4>Preview</h4>
    <div class="ced-preview">
      <div class="pv-bug">${raw(logoHtml(draft))}<span>${draft.name}</span></div>
      <div class="pv-row" style="--h:${l.hue ?? ch.hue}">${raw(logoHtml(draft, "sm"))}<span class="nm">${draft.favorite ? "★ " : ""}${draft.name}</span></div>
    </div>`.html;
}

// ------------------------------------------------------------------ mix (N-09, N-10)

const WEIGHT_WORDS = [[1, "Never"], [25, "Rarely"], [45, "Less"], [60, "Normal"], [85, "More"], [101, "Lots"]];
const weightWord = (w) => WEIGHT_WORDS.find(([max]) => w < max)?.[1] ?? "Lots";
const weightOf = (k) => draft.weights?.[k] ?? 50;
const WATCHED = { all: ["Everything", "Watched or not, in station order."], unwatched: ["Skip watched", "Only what you haven't seen, until you've seen it all."], resume: ["Pick up", "Each show carries on after the last episode you watched."] };
const genreOut = (g) => g.genres?.some((x) => draft.exclude.genres.includes(x));

/** The share of picks each show gets from its weight; shows kept off get none. */
function shares(groups) {
  const out = groups.map((g) => (genreOut(g) || draft.exclude.shows.includes(g.key) ? 0 : weightOf(g.key)));
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((w) => w / sum);
}

function mix() {
  const groups = info?.groups ?? [];
  const genres = [...new Set(groups.flatMap((g) => g.genres ?? []))].sort();
  const sh = shares(groups);
  const many = groups.length > 1;
  const onAir = groups.filter((g, i) => sh[i] > 0).length;
  const seg = (k, opts) => html`<div class="seg" role="radiogroup">${Object.entries(opts).map(([v, label]) =>
    html`<button role="radio" data-set="${k}:${v}" aria-checked="${String((draft[k] ?? Object.keys(opts)[0]) === v)}">${label}</button>`)}</div>`;
  const sw = (k, label, desc) => html`<div class="opt"><div><div class="ol">${label}</div><div class="od">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-k="${k}" aria-label="${label}" ${draft[k] ? "checked" : ""}><i></i></label></div>`;
  return html`
    <p class="lead">What this channel plays, and how often. Changes start when the program on now ends.</p>
    ${!info?.groups ? html`<div class="muted">This build can't read the channel's lineup yet.</div>` : !groups.length ? html`<div class="muted">Nothing in this channel's lineup yet.</div>` : ""}
    ${many ? html`<div class="mix-bar" aria-hidden="true">${groups.map((g, i) => sh[i] > 0
      ? html`<i style="flex:${sh[i].toFixed(4)};--k:${i}" title="${g.name}"><b>${sh[i] >= 0.1 ? g.name : ""}</b></i>` : "")}</div>
    <div class="muted mix-sum">${onAir} of ${groups.length} in the rotation${onAir < groups.length ? `, ${groups.length - onAir} kept off` : ""}.</div>` : ""}
    <div class="mix-list">${groups.map((g, i) => {
      const w = weightOf(g.key);
      const gOut = genreOut(g);
      const off = gOut || draft.exclude.shows.includes(g.key) || w === 0;
      const unit = g.key === "films" ? (g.count === 1 ? "film" : "films") : g.count === 1 ? "episode" : "episodes";
      return html`<div class="mix-row ${off ? "off" : ""}" style="--k:${i}">
        <div class="mix-name"><i class="dot"></i><div><b>${g.name}</b><span>${g.count} ${unit}${g.genres?.length ? ` · ${g.genres.slice(0, 3).join(", ")}` : ""}</span></div></div>
        ${gOut ? html`<span class="mix-why">Genre kept off</span>` : many ? html`<input type="range" class="mix-w" min="0" max="100" step="5" value="${w}" style="--v:${w}%" data-weight="${g.key}" id="mixw-${i}" aria-label="How often ${g.name} plays" aria-valuetext="${weightWord(w)}">
          <output class="mix-word">${weightWord(w)}</output>` : html`<span class="mix-why">The whole channel</span>`}
      </div>`;
    })}</div>
    ${genres.length ? html`<h4>Keep genres off</h4>
      <div class="chips">${genres.map((x) => html`<button class="chip" data-genre="${x}" aria-pressed="${String(draft.exclude.genres.includes(x))}">${x}</button>`)}</div>` : ""}
    <h4>Order</h4>
    ${many ? html`<div class="opt"><div><div class="ol">Balance</div><div class="od">${draft.balance === "time" ? "Each show gets its share of the hours, so long shows air fewer episodes." : "Each show gets its share of episodes, however long they run."}</div></div>
      ${seg("balance", { episodes: "Episodes", time: "Time" })}</div>` : ""}
    ${many ? raw(sw("marathons", "Marathons", "Now and then, several episodes of one show in a row.")) : ""}
    ${raw(sw("premieres", "Premieres", "New files air first, once, then join the order."))}
    <div class="opt"><div><div class="ol">Watched programs</div><div class="od">${WATCHED[draft.watched ?? "all"]?.[1] ?? ""}</div></div>
      ${seg("watched", Object.fromEntries(Object.entries(WATCHED).map(([k, [l]]) => [k, l])))}</div>
    <div class="mix-refresh">
      <div><div class="ol">Fresh order</div><div class="od">Deal a new shuffle now. The program on now finishes first.</div></div>
      <button class="btn" data-refresh ${onAir ? "" : "disabled"}>↻ Reshuffle</button>
    </div>`.html;
}

function schedule() {
  const slots = draft.slots;
  const sources = sourceOptions();
  return html`
    <p class="lead">Pin what plays at set times, like Saturday-morning cartoons. Outside its slots the channel plays its usual lineup.${info?.timeZone ? ` Times are in ${info.timeZone}.` : ""} Changes start when the program on now ends.</p>
    ${info?.specialsAvailable > 0 ? html`<div class="opt"><div><div class="ol">Include specials</div>
      <div class="od">${info.specialsAvailable} season 0 episode${info.specialsAvailable === 1 ? "" : "s"}. They air after the last season.</div></div>
      <label class="switch"><input type="checkbox" data-k="specials" aria-label="Include specials" ${draft.specials ? "checked" : ""}><i></i></label></div>` : ""}
    ${raw(weekStrip(slots))}
    <div class="list ced-slots">${slots.length ? slots.map((s, i) => html`<div class="slot">
      <div class="days">${DAYS.map((d, di) => html`<button data-slot-day="${i}:${di + 1}" aria-pressed="${String(s.days.includes(di + 1))}">${d.slice(0, 2)}</button>`)}</div>
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
      <label class="switch"><input type="checkbox" data-k="kid" aria-label="Kid channel" data-first ${draft.kid ? "checked" : ""}><i></i></label></div>
    <h4>Daytime limit</h4>
    <p class="lead">Keep stronger programs for late at night. Between these times the channel skips anything rated above the limit; the rest of the night, anything in its lineup can play.</p>
    <div class="list">${rh.map((r, i) => html`<div class="slot">
      <span class="muted">Between</span><input class="input" type="time" data-rh="${i}:from" value="${r.from}" aria-label="From">
      <span class="muted">and</span><input class="input" type="time" data-rh="${i}:to" value="${r.to}" aria-label="To">
      <span class="muted">allow up to</span>
      <select class="input" data-rh="${i}:maxRating" aria-label="Highest rating">${RATINGS.map((x) => html`<option ${x === r.maxRating ? "selected" : ""}>${x}</option>`)}</select>
      <button class="icon-btn" data-rh-del="${i}" aria-label="Remove">✕</button></div>`)}</div>
    ${rh.length ? "" : html`<button class="btn" data-rh-add>+ Add a daytime limit</button>`}
    ${lockInfo ? raw(lockSection()) : ""}
    <p class="muted" style="margin-top:1.2em">Ratings come from your files' metadata where present. DebridTV never looks them up online.</p>`.html;
}

/** N-06b: lock with a PIN. The PIN is shared by every locked channel. */
function lockSection() {
  const needPin = draft.locked && !lockInfo.pinSet;
  const form = pinForm ?? (needPin ? { old: "", pin: "", again: "" } : null);
  const field = (k, label) => html`<div class="field"><label for="ced-pin-${k}">${label}</label>
    <input id="ced-pin-${k}" class="input pin-in" type="password" inputmode="numeric" autocomplete="off" maxlength="${PIN_MAX}" data-pinf="${k}" value="${form[k]}"></div>`;
  return html`<h4>Lock</h4>
    <div class="opt"><div><div class="ol">Lock with a PIN</div><div class="od">The channel shows a scrambled picture until someone types the PIN. Nothing downloads while it's locked, and its listings stay hidden in the guide.</div></div>
      <label class="switch"><input type="checkbox" data-k="locked" aria-label="Lock with a PIN" ${draft.locked ? "checked" : ""}><i></i></label></div>
    ${form ? html`<div class="ced-pin">
        <p class="lead">${lockInfo.pinSet ? "Change the PIN for every locked channel." : `Choose a PIN of ${PIN_MIN} to ${PIN_MAX} digits. It works for every locked channel.`}</p>
        <div class="ced-row">${lockInfo.pinSet ? field("old", "Current PIN") : ""}${field("pin", "New PIN")}${field("again", "Type it again")}</div>
        ${lockInfo.pinSet ? html`<button class="linkish" data-pin-cancel>Keep the current PIN</button>` : ""}
      </div>` : lockInfo.pinSet ? html`<button class="linkish" data-pin-change>Change PIN</button>` : ""}
    ${draft.locked && info?.alsoOn?.length ? html`<div class="ced-also"><b>Some of these programs also air on other channels, where they can still be watched:</b>${info.alsoOn.map((o) => html`<div class="also-row">
      <span class="n">${o.number}</span><span>${o.name}<small>${o.programs} program${o.programs === 1 ? "" : "s"} in common</small></span>
      ${o.locked ? html`<span class="muted">Locked</span>` : html`<button class="btn" data-lock-also="${o.id}">Lock it too</button>`}</div>`)}</div>` : ""}`.html;
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
  if (d.artLogo) return void useArtLogo(d.artLogo);
  if (d.tab) tab = d.tab;
  else if (d.logoKind) draft.logo = d.logoKind === "image" ? { ...draft.logo, kind: "image" } : { ...draft.logo, kind: d.logoKind, text: d.logoKind === "text" ? wordFrom(draft) : String(draft.number) };
  else if (d.logoStyle) draft.logo = { ...draft.logo, style: d.logoStyle };
  else if (d.slotAdd !== undefined) draft.slots = [...draft.slots, { days: [6], from: "08:00", to: "11:00", source: sourceOptions()[0]?.value ?? "" }];
  else if (d.slotDel) draft.slots = draft.slots.filter((_, i) => i !== Number(d.slotDel));
  else if (d.slotDay) {
    const [i, day] = d.slotDay.split(":").map(Number);
    const s = draft.slots[i];
    s.days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
  } else if (d.set) {
    const [k, v] = d.set.split(":");
    draft[k] = v;
  } else if (d.genre) {
    const g = draft.exclude.genres;
    draft.exclude.genres = g.includes(d.genre) ? g.filter((x) => x !== d.genre) : [...g, d.genre];
  } else if (d.refresh !== undefined) return reshuffle(b);
  else if (d.pinChange !== undefined) pinForm = { old: "", pin: "", again: "" };
  else if (d.lockAlso) {
    b.disabled = true;
    try {
      await withPin(() => api.post(`/api/channels/${encodeURIComponent(d.lockAlso)}/settings`, { locked: true }), "Locking a channel needs the PIN.");
      const o = info.alsoOn.find((x) => x.id === d.lockAlso);
      if (o) o.locked = true;
      toast(`Locked ${o?.name ?? "that channel"} too.`);
    } catch (e) {
      if (!e.cancelled) toast(`Couldn't lock it: ${e.message}`);
      b.disabled = false;
      return;
    }
  }
  else if (d.pinCancel !== undefined) pinForm = null;
  else if (d.rhAdd !== undefined) draft.restrictedHours = [{ from: "06:00", to: "22:00", maxRating: "PG-13" }];
  else if (d.rhDel) draft.restrictedHours = draft.restrictedHours.filter((_, i) => i !== Number(d.rhDel));
  else if (d.save !== undefined) return save();
  else if (d.ratings !== undefined) {
    closeChannelEditor();
    return import("./panel.js").then((m) => m.openPanel("library", "ratings"));
  }
  else return;
  render();
  // Keep focus on the control that was pressed (same data attribute and value), else the tab's first field.
  const same = Object.entries(d).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}="${CSS.escape(v)}"]`)[0];
  (root.querySelector(d.tab ? `[data-tab="${d.tab}"]` : same ?? "[data-first]") ?? root.querySelector("[data-first]") ?? root.querySelector("button"))?.focus();
});

root.addEventListener("change", (e) => {
  const t = e.target;
  if (!t.matches?.("[data-logo-file]") || !t.files?.[0]) return;
  const f = t.files[0];
  if (f.size > 200_000) return toast("That image is over 200 KB. Try a smaller one.");
  readLogo(f);
});

function readLogo(blob) {
  const rd = new FileReader();
  rd.onload = () => {
    draft.logo = { kind: "image", url: String(rd.result), hue: draft.logo.hue };
    render();
  };
  rd.readAsDataURL(blob);
}

/** Uses the show's own clear logo or poster (channel.art, local files only) as the channel logo.
 * The server keeps logos as data: URLs, so a big picture is scaled down to fit first. */
async function useArtLogo(kind) {
  try {
    const r = await fetch(ch.art[kind]);
    if (!r.ok) throw new Error(String(r.status));
    let blob = await r.blob();
    if (blob.size > 200_000) blob = await shrink(blob, kind === "logo" ? 400 : 240);
    if (!blob || blob.size > 200_000) return toast("That picture is too big to use as a logo.");
    readLogo(blob);
  } catch {
    toast("Couldn't load that picture.");
  }
}

async function shrink(blob, max) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/webp", 0.86));
}

root.addEventListener("input", (e) => {
  const t = e.target;
  if (t.type === "file") return;
  const d = t.dataset;
  if (d.k) draft[d.k] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
  else if (d.pinf) {
    pinForm ??= { old: "", pin: "", again: "" };
    pinForm[d.pinf] = t.value.replace(/\D/g, "");
    if (t.value !== pinForm[d.pinf]) t.value = pinForm[d.pinf];
    return;
  } else if (d.weight) {
    draft.weights[d.weight] = Number(t.value);
    return refreshMix(t);
  } else if (d.logo) draft.logo = { ...draft.logo, [d.logo]: d.logo === "hue" ? Number(t.value) : t.value };
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
  e.stopImmediatePropagation(); // don't also close the settings panel behind
  closeChannelEditor();
}, true);

/** Updates the mix bar and the slider's word without re-rendering (keeps the drag alive). */
function refreshMix(input) {
  const row = input.closest(".mix-row");
  const w = Number(input.value);
  input.style.setProperty("--v", `${w}%`);
  row.querySelector(".mix-word").textContent = weightWord(w);
  input.setAttribute("aria-valuetext", weightWord(w));
  row.classList.toggle("off", w === 0);
  const pv = document.createElement("div");
  pv.innerHTML = mix();
  root.querySelector(".mix-bar")?.replaceWith(pv.querySelector(".mix-bar"));
  root.querySelector(".mix-sum")?.replaceWith(pv.querySelector(".mix-sum"));
  root.querySelector("[data-refresh]")?.toggleAttribute("disabled", !!pv.querySelector("[data-refresh][disabled]"));
}

async function reshuffle(btn) {
  if (!live) return toast("This build can't reshuffle channels yet.");
  btn.disabled = true;
  try {
    const r = await api.post(`/api/channels/${encodeURIComponent(ch.id)}/refresh`);
    toast(r.fromMs ? `New order starts at ${fmtTime(r.fromMs)}, after the program on now.` : "New order starts after the program on now.");
    onSaved?.(draft);
  } catch (e) {
    toast(`Couldn't reshuffle: ${e.message}`);
  }
  btn.disabled = false;
}

async function save() {
  if (!draft.name.trim()) return toast("Give the channel a name.");
  if (!(draft.number >= 1 && draft.number <= 999)) return toast("Channel numbers run from 1 to 999.");
  if (lockInfo && (pinForm?.pin || (draft.locked && !lockInfo.pinSet))) {
    const f = pinForm ?? { pin: "" };
    if (f.pin !== f.again) return toast("The two PINs don't match.");
    const err = await setPin(f.pin, lockInfo.pinSet ? f.old : undefined);
    if (err) return toast(err);
    lockInfo = { ...lockInfo, pinSet: true };
    pinForm = null;
  }
  const body = { ...draft };
  if (body.logo?.kind === "badge") body.logo = { kind: "badge", text: String(body.number), hue: body.logo.hue };
  if (body.logo?.kind === "text" && !body.logo.text?.trim()) return toast("Type a wordmark, or pick the number badge.");
  if (body.logo?.kind === "image" && !body.logo.url) return toast("Choose an image, or pick another kind of logo.");
  let res;
  try {
    res = await withPin(() => api.post(`/api/channels/${encodeURIComponent(ch.id)}/settings`, body), "This channel's settings are locked.");
  } catch (e) {
    if (e.cancelled) return;
    return toast(`Couldn't save: ${e.message}`);
  }
  closeChannelEditor();
  toast(`Saved ${draft.name}.${res?.note ? ` ${res.note}` : ""}`);
  onSaved?.(draft);
}

// ------------------------------------------------------------------ global exclusions (N-09b)
// "Keep off every channel": GET/PUT /api/exclusions { shows: [showKey], genres: [name] }.
// The choices come from options { shows, genres } when the server sends them, else from
// every channel's groups (all local calls). A channel left with nothing disappears.

const exRoot = document.createElement("div");
exRoot.className = "ced";
exRoot.hidden = true;
exRoot.setAttribute("role", "dialog");
exRoot.setAttribute("aria-modal", "true");
exRoot.setAttribute("aria-label", "Keep off every channel");
document.body.append(exRoot);
let ex = null; // { shows: Set, genres: Set, options: { shows, genres }, q, onSaved, lastFocus }

export const exclusionsOpen = () => !exRoot.hidden;

export async function openExclusions(opts = {}) {
  const lastFocus = document.activeElement;
  let cur = { shows: [], genres: [] }, options = null;
  try {
    const r = await api.get("/api/exclusions");
    cur = { shows: r.shows ?? [], genres: r.genres ?? [] };
    options = r.options ?? null;
  } catch {
    return toast("This build can't keep shows off every channel yet.");
  }
  if (!options) options = await optionsFromChannels();
  ex = { shows: new Set(cur.shows), genres: new Set(cur.genres), options, q: "", onSaved: opts.onSaved ?? null, lastFocus };
  exRoot.hidden = false;
  document.body.classList.add("ced-open");
  renderEx();
  exRoot.querySelector("[data-first]")?.focus();
}

async function optionsFromChannels() {
  const shows = new Map(), genres = new Map();
  const all = await Promise.all(tv.channels.map((c) => api.get(`/api/channels/${encodeURIComponent(c.id)}/settings`).catch(() => null)));
  for (const s of all) for (const g of s?.groups ?? []) {
    if (g.key !== "films" && !shows.has(g.key)) shows.set(g.key, { key: g.key, name: g.name, count: g.count });
    for (const x of g.genres ?? []) genres.set(x, Math.max(genres.get(x) ?? 0, 1));
  }
  return {
    shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    genres: [...genres.keys()].sort().map((name) => ({ name })),
  };
}

function closeExclusions() {
  exRoot.hidden = true;
  if (root.hidden) document.body.classList.remove("ced-open");
  ex?.lastFocus?.focus?.();
}

function renderEx() {
  const n = ex.shows.size + ex.genres.size;
  exRoot.innerHTML = html`<div class="ced-sheet ex-sheet">
    <header class="ced-head">
      <span class="ex-icon" aria-hidden="true">⦸</span>
      <div class="ced-title"><div class="k">Every channel</div><div class="t">Keep off the air</div></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <div class="ced-body">
      <p class="lead">Shows and genres picked here never air on any channel. They stay in your library. A channel left with nothing to play goes off the guide. Changes start when the programs on now end.</p>
      <h4>Genres</h4>
      ${ex.options.genres.length ? html`<div class="chips">${ex.options.genres.map((g) => html`<button class="chip" data-ex-genre="${g.name}" aria-pressed="${String(ex.genres.has(g.name))}">${g.name}</button>`)}</div>`
        : html`<div class="muted">Your files don't name any genres yet.</div>`}
      <h4>Shows</h4>
      ${ex.options.shows.length > 8 ? html`<input class="input ex-q" type="search" placeholder="Find a show" value="${ex.q}" data-ex-q data-first aria-label="Find a show">` : ""}
      <div class="ex-shows">${raw(showRows())}</div>
    </div>
    <footer class="ced-foot">
      <span class="muted ex-count">${n ? `${n} kept off` : "Nothing kept off"}</span>
      <span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-ex-save ${ex.options.shows.length > 8 ? "" : "data-first"}>Save</button>
    </footer>
  </div>`.html;
}

function showRows() {
  const q = ex.q.trim().toLowerCase();
  const list = ex.options.shows.filter((s) => !q || s.name.toLowerCase().includes(q));
  if (!list.length) return html`<div class="muted">${q ? "No show by that name." : "No shows in your library yet."}</div>`.html;
  return list.map((s) => html`<label class="ex-row ${ex.shows.has(s.key) ? "on" : ""}">
    <input type="checkbox" data-ex-show="${s.key}" ${ex.shows.has(s.key) ? "checked" : ""}>
    <span class="ex-box" aria-hidden="true"></span><b>${s.name}</b>${s.count ? html`<span class="muted">${s.count} ep.</span>` : ""}</label>`.html).join("");
}

exRoot.addEventListener("click", async (e) => {
  if (e.target === exRoot) return closeExclusions();
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.close !== undefined) return closeExclusions();
  if (d.exGenre) {
    ex.genres.has(d.exGenre) ? ex.genres.delete(d.exGenre) : ex.genres.add(d.exGenre);
    b.setAttribute("aria-pressed", String(ex.genres.has(d.exGenre)));
    return countEx();
  }
  if (d.exSave !== undefined) {
    try {
      await api.post("/api/exclusions", { shows: [...ex.shows], genres: [...ex.genres] });
    } catch (err) {
      return toast(`Couldn't save: ${err.message}`);
    }
    closeExclusions();
    toast(ex.shows.size + ex.genres.size ? "Saved. They're off the air once the programs on now end." : "Saved. Everything is back in rotation.");
    ex.onSaved?.();
  }
});
exRoot.addEventListener("change", (e) => {
  const k = e.target.dataset?.exShow;
  if (!k) return;
  e.target.checked ? ex.shows.add(k) : ex.shows.delete(k);
  e.target.closest(".ex-row").classList.toggle("on", e.target.checked);
  countEx();
});
exRoot.addEventListener("input", (e) => {
  if (e.target.dataset?.exQ === undefined) return;
  ex.q = e.target.value;
  exRoot.querySelector(".ex-shows").innerHTML = showRows();
});
function countEx() {
  const n = ex.shows.size + ex.genres.size;
  exRoot.querySelector(".ex-count").textContent = n ? `${n} kept off` : "Nothing kept off";
}
addEventListener("keydown", (e) => {
  if (!exclusionsOpen() || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeExclusions();
}, true);
