// Themes (parity N-11b): the three built-in looks, custom themes made from eight
// picked colours, and JSON import/export so a theme can move between PCs.
//
// A custom theme is stored in prefs.customThemes and selected with
// prefs.theme = "custom:<id>". It is applied as inline CSS variables on <html>;
// everything else (dim text, lines, panels, guide cells) is derived from the
// picks so a theme can't end up half-coloured. Only #rrggbb colours are ever
// written into CSS, so an imported file can't inject anything.
//
// panel.js (workstream C) lists themeOptions() in its theme picker and opens
// openThemeEditor() from a "Customize…" button.

import { html, raw, pref, setPref, onPrefsApplied, toast, clamp } from "./util.js";

export const FORMAT = "debridtv-theme";

/** The colours a person picks, in the order the editor shows them. */
const SLOTS = [
  ["bg", "Backdrop", "Behind everything"],
  ["panel", "Panels", "Menus, guide, cards"],
  ["ink", "Text", "Titles and body"],
  ["accent", "Accent", "Focus, buttons, now line"],
  ["highlight", "Highlight", "Links, times, meters"],
  ["accent2", "Second accent", "Gradients, favorites"],
  ["cell", "Guide cells", "Program cell tint"],
  ["osd", "Channel no.", "On channel change"],
];

const BUILTIN = {
  midnight: { name: "Midnight", colors: { bg: "#060816", panel: "#0e1230", ink: "#eef0ff", accent: "#ffb547", highlight: "#4fe3ff", accent2: "#ff5fa2", cell: "#788cff", osd: "#7dff9a" }, cellStrength: 12 },
  cable92: { name: "Cable '92", colors: { bg: "#001a5c", panel: "#001c6e", ink: "#ffffff", accent: "#ffe14d", highlight: "#9be7ff", accent2: "#ff8ac5", cell: "#2850c8", osd: "#7dff9a" }, cellStrength: 85 },
  daylight: { name: "Daylight", colors: { bg: "#e9ecf7", panel: "#f8f9ff", ink: "#12152b", accent: "#c2410c", highlight: "#0369a1", accent2: "#be185d", cell: "#1e285a", osd: "#7dff9a" }, cellStrength: 7 },
};

/** Starting points that aren't full built-ins. */
const STARTERS = {
  prevue: { name: "Prevue", colors: { bg: "#14052e", panel: "#22094a", ink: "#fff6e0", accent: "#ffd23f", highlight: "#4ad8ff", accent2: "#ff4fa8", cell: "#7a3cff", osd: "#ffd23f" }, cellStrength: 30 },
  teletext: { name: "Teletext", colors: { bg: "#000000", panel: "#05050a", ink: "#ffffff", accent: "#ffff00", highlight: "#00ffff", accent2: "#ff00ff", cell: "#0000ff", osd: "#00ff00" }, cellStrength: 45 },
  phosphor: { name: "Phosphor", colors: { bg: "#020a04", panel: "#04140a", ink: "#b8ffcc", accent: "#5dff8f", highlight: "#9dffb8", accent2: "#2fd06a", cell: "#2fd06a", osd: "#5dff8f" }, cellStrength: 12 },
  vhs: { name: "VHS Sunset", colors: { bg: "#1b0b1f", panel: "#2a1030", ink: "#ffe9f2", accent: "#ff8a3d", highlight: "#ff4f8b", accent2: "#a64dff", cell: "#ff4f8b", osd: "#7dff9a" }, cellStrength: 14 },
  saturday: { name: "Saturday Morning", colors: { bg: "#fff3d6", panel: "#fffaf0", ink: "#2a1a0a", accent: "#e8481c", highlight: "#1c7ce8", accent2: "#16a34a", cell: "#e8a21c", osd: "#7dff9a" }, cellStrength: 18 },
};

const HEX = /^#[0-9a-f]{6}$/i;
const normHex = (v) => {
  let s = String(v ?? "").trim();
  if (/^#?[0-9a-f]{3}$/i.test(s)) s = "#" + s.replace("#", "").split("").map((c) => c + c).join("");
  if (/^[0-9a-f]{6}$/i.test(s)) s = "#" + s;
  return HEX.test(s) ? s.toLowerCase() : null;
};

// ------------------------------------------------------------------ colour maths

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function luminance(h) {
  const [r, g, b] = rgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const isLight = (t) => luminance(t.colors.panel) > 0.45;

// ------------------------------------------------------------------ storage

const customs = () => (Array.isArray(pref("customThemes")) ? pref("customThemes") : []);
const findCustom = (id) => customs().find((t) => t.id === id);

/** Theme <select> options: built-ins first, then saved custom themes. */
export function themeOptions() {
  return [
    ...Object.entries(BUILTIN).map(([k, t]) => ({ value: k, label: t.name })),
    ...customs().map((t) => ({ value: `custom:${t.id}`, label: t.name })),
  ];
}

/** The active theme as { name, colors, cellStrength }, built-in or custom. */
export function currentTheme() {
  const v = String(pref("theme") ?? "midnight");
  if (v.startsWith("custom:")) return findCustom(v.slice(7)) ?? BUILTIN.midnight;
  return BUILTIN[v] ?? BUILTIN.midnight;
}

/** Validates anything (an imported file, a stored pref) into a clean theme, or throws with a reason. */
export function cleanTheme(x) {
  if (!x || typeof x !== "object") throw new Error("That isn't a theme file.");
  if (x.format && x.format !== FORMAT) throw new Error("That file is for something else, not a DebridTV theme.");
  const c = x.colors && typeof x.colors === "object" ? x.colors : null;
  if (!c) throw new Error("The theme has no colours.");
  const colors = {};
  const missing = [];
  for (const [k] of SLOTS) {
    const h = normHex(c[k]);
    if (h) colors[k] = h;
    else missing.push(k);
  }
  // Older or hand-written files may skip a few; fill them from Midnight, but not the core three.
  if (missing.some((k) => ["bg", "panel", "ink"].includes(k))) throw new Error("The theme needs at least backdrop, panel and text colours as #rrggbb.");
  for (const k of missing) colors[k] = BUILTIN.midnight.colors[k];
  const name = String(x.name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40) || "Imported theme";
  const cellStrength = clamp(Math.round(Number(x.cellStrength ?? 14)) || 0, 2, 100);
  return { name, colors, cellStrength };
}

function exportJson(t) {
  return JSON.stringify({ format: FORMAT, version: 1, name: t.name, colors: t.colors, cellStrength: t.cellStrength }, null, 2);
}

// ------------------------------------------------------------------ applying

const VARS = ["--bg", "--ink", "--dim", "--faint", "--panel", "--panel-solid", "--panel-2", "--line", "--line-strong", "--amber", "--cyan", "--magenta",
  "--focus", "--osd", "--cell", "--cell-now", "--ok", "--warn", "--bad"];

/** CSS variables for a theme. Derived shades mix the picks, so they follow any palette. */
export function themeVars(t) {
  const c = t.colors;
  const light = isLight(t);
  const s = t.cellStrength;
  const mix = (a, pct, b) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  return {
    "--bg": c.bg,
    "--ink": c.ink,
    "--dim": mix(c.ink, 68, c.panel),
    "--faint": mix(c.ink, 42, c.panel),
    "--panel": mix(c.panel, 95, "transparent"),
    "--panel-solid": c.panel,
    "--panel-2": mix(c.ink, light ? 7 : 9, c.panel),
    "--line": mix(c.ink, light ? 13 : 15, "transparent"),
    "--line-strong": mix(c.ink, light ? 26 : 30, "transparent"),
    "--amber": c.accent,
    "--cyan": c.highlight,
    "--magenta": c.accent2,
    "--focus": c.accent,
    "--osd": c.osd,
    "--cell": mix(c.cell, s, "transparent"),
    "--cell-now": mix(c.cell, Math.min(100, Math.round(s * 1.7 + 4)), "transparent"),
    "--ok": light ? "#15803d" : "#6ff2a8",
    "--warn": light ? "#a16207" : "#ffd166",
    "--bad": light ? "#b91c1c" : "#ff6b6b",
  };
}

const rootEl = document.documentElement;
function paint(t) {
  const st = rootEl.style;
  if (!t) {
    for (const k of VARS) st.removeProperty(k);
    return;
  }
  for (const [k, v] of Object.entries(themeVars(t))) st.setProperty(k, v);
}

let preview = null; // a draft shown live while the editor is open
function apply(p) {
  const v = String(p.theme ?? "midnight");
  const t = preview ?? (v.startsWith("custom:") ? findCustom(v.slice(7)) : null);
  rootEl.dataset.theme = t ? "custom" : BUILTIN[v] ? v : "midnight";
  paint(t);
  const tone = t ? (isLight(t) ? "light" : "dark") : v === "daylight" ? "light" : "dark";
  rootEl.dataset.tone = tone;
  rootEl.style.colorScheme = tone;
}
onPrefsApplied(apply);

// ------------------------------------------------------------------ editor

const root = document.createElement("div");
root.className = "ced thm";
root.hidden = true;
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-label", "Theme editor");
document.body.append(root);

let draft = null; // { id?, name, colors, cellStrength }
let onSaved = null;
let lastFocus = null;
let pasting = false;

export const themeEditorOpen = () => !root.hidden;

/** Opens the editor on the active theme (a custom one is edited; a built-in is copied). */
export function openThemeEditor(opts = {}) {
  lastFocus = document.activeElement;
  onSaved = opts.onSaved ?? null;
  const v = String(pref("theme") ?? "midnight");
  const cur = currentTheme();
  const own = v.startsWith("custom:") && findCustom(v.slice(7));
  draft = structuredClone(own ? cur : { ...cur, name: `My ${cur.name}` });
  if (own) draft.id = own.id;
  pasting = false;
  root.hidden = false;
  document.body.classList.add("ced-open");
  render();
  live();
  root.querySelector("[data-first]")?.focus();
}

export function closeThemeEditor() {
  preview = null;
  root.hidden = true;
  document.body.classList.remove("ced-open");
  apply({ theme: pref("theme") });
  lastFocus?.focus?.();
}

function live() {
  preview = draft;
  apply({ theme: pref("theme") });
  const w = root.querySelector(".thm-checks");
  if (w) w.innerHTML = checks().html;
  const t = root.querySelector(".ced-title .t");
  if (t) t.textContent = draft.name || "Untitled theme";
}

function swatches(t) {
  return raw(["bg", "panel", "accent", "highlight", "accent2"].map((k) => `<i style="background:${t.colors[k]}"></i>`).join(""));
}

function render() {
  const chips = (set, tag) => Object.entries(set).map(([k, t]) => html`<button class="thm-chip" data-start="${tag}:${k}" title="Start from ${t.name}">
    <span class="sw">${swatches(t)}</span>${t.name}</button>`);
  root.innerHTML = html`<div class="ced-sheet thm-sheet">
    <header class="ced-head">
      <span class="thm-badge" aria-hidden="true">${swatches(draft)}</span>
      <div class="ced-title"><div class="k">${draft.id ? "Edit theme" : "New theme"}</div><div class="t">${draft.name || "Untitled theme"}</div></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </header>
    <div class="ced-body thm-body">
      <div class="thm-controls">
        <div class="field"><label for="thm-name">Name</label><input id="thm-name" class="input" data-name data-first value="${draft.name}" maxlength="40"></div>
        <h4>Start from</h4>
        <div class="thm-chips">${chips(BUILTIN, "b")}${chips(STARTERS, "s")}</div>
        <h4>Colours</h4>
        <div class="thm-slots">${SLOTS.map(([k, label, desc]) => html`<div class="thm-slot">
          <label class="thm-pick" style="--c:${draft.colors[k]}"><input type="color" value="${draft.colors[k]}" data-color="${k}" aria-label="${label}"></label>
          <div class="thm-lbl"><b>${label}</b><span>${desc}</span></div>
          <input class="input thm-hex" value="${draft.colors[k]}" data-hex="${k}" maxlength="7" spellcheck="false" aria-label="${label} hex code">
        </div>`)}</div>
        <div class="field"><label for="thm-cell">Guide cell strength <output>${draft.cellStrength}%</output></label>
          <input id="thm-cell" type="range" min="2" max="100" value="${draft.cellStrength}" data-cell></div>
      </div>
      <div class="thm-side">
        <div class="thm-preview" aria-hidden="true">${previewHtml()}</div>
        <div class="thm-checks" aria-live="polite">${checks()}</div>
        <div class="thm-io">
          <h4>Share</h4>
          <p class="lead">Save the theme as a small file, or copy it as text, to use it on another PC.</p>
          <div class="row-actions">
            <button class="btn" data-export>Download .json</button>
            <button class="btn" data-copy>Copy</button>
            <button class="btn" data-import>Import file…</button>
            <button class="btn" data-paste aria-expanded="${String(pasting)}">Paste…</button>
          </div>
          ${pasting ? html`<div class="field"><label for="thm-paste">Paste a theme</label>
            <textarea id="thm-paste" class="input thm-paste" rows="5" spellcheck="false" placeholder='{"format":"debridtv-theme", …}'></textarea>
            <div class="row-actions"><button class="btn" data-paste-go>Use pasted theme</button></div></div>` : ""}
          <p class="muted">You can also drop a theme file anywhere on this window.</p>
          <input type="file" accept=".json,application/json" data-file hidden>
        </div>
      </div>
    </div>
    <footer class="ced-foot">
      ${draft.id ? html`<button class="btn danger" data-delete>Delete</button>` : ""}
      <span style="flex:1"></span>
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" data-save>${draft.id ? "Save" : "Save and use"}</button>
    </footer>
  </div>`.html;
}

/** Readability checks, shown under the pickers (WCAG AA is 4.5 for text, 3 for large marks). */
function checks() {
  const c = draft.colors;
  const rows = [
    ["Text on panels", contrast(c.ink, c.panel), 4.5],
    ["Accent on panels", contrast(c.accent, c.panel), 3],
    ["Highlight on panels", contrast(c.highlight, c.panel), 3],
  ];
  return html`${rows.map(([l, r, min]) => {
    const ok = r >= min;
    return html`<div class="thm-check ${ok ? "ok" : "low"}"><span>${ok ? "✓" : "!"}</span>${l}<b>${r.toFixed(1)}:1</b>${ok ? "" : html`<em>hard to read</em>`}</div>`;
  })}`;
}

/** A miniature banner and guide drawn with the draft's own variables. */
function previewHtml() {
  const rows = [["2", "Half Hour", "Saved by the Bell", 62, "Fresh Prince", 38], ["3", "Prime Hour", "The X-Files", 100, "", 0], ["10", "Simpsons", "Lisa's Pony", 45, "Marge vs. the Monorail", 55]];
  return html`<div class="tp-stage"><div class="tp-osd">10</div>
      <div class="tp-banner"><span class="tp-num">10</span><div><b>The Simpsons</b><small>S3 · E8 <i>LIVE</i></small><div class="tp-bar"><i></i></div></div></div></div>
    <div class="tp-guide">
      <div class="tp-time"><span>8:00</span><span>8:30</span><i></i></div>
      ${rows.map(([n, name, a, aw, b, bw], i) => html`<div class="tp-row"><span class="tp-ch"><b>${n}</b>${name}</span>
        <span class="tp-cell now ${i === 2 ? "focus" : ""}" style="flex:${aw}">${a}</span>${bw ? html`<span class="tp-cell" style="flex:${bw}">${b}</span>` : ""}</div>`)}
    </div>
    <div class="tp-buttons"><span class="tp-btn">Cancel</span><span class="tp-btn primary">Watch</span><span class="tp-link">Details</span></div>`;
}

function refreshPickers() {
  for (const [k] of SLOTS) {
    const c = draft.colors[k];
    const p = root.querySelector(`[data-color="${k}"]`);
    const h = root.querySelector(`[data-hex="${k}"]`);
    if (p && p.value !== c) p.value = c;
    if (p) p.parentElement.style.setProperty("--c", c);
    if (h && document.activeElement !== h) h.value = c;
  }
  const badge = root.querySelector(".thm-badge");
  if (badge) badge.innerHTML = swatches(draft).html;
}

function useTheme(t, { keepName = false } = {}) {
  draft = { ...draft, colors: { ...t.colors }, cellStrength: t.cellStrength, name: keepName ? draft.name : draft.id ? draft.name : t.name };
  render();
  live();
}

function importText(text) {
  let t;
  try {
    t = cleanTheme(JSON.parse(text));
  } catch (e) {
    return toast(e instanceof SyntaxError ? "That text isn't a theme file (it isn't JSON)." : e.message);
  }
  draft = { ...t }; // an import becomes a new theme, never overwrites one
  pasting = false;
  render();
  live();
  toast(`Loaded “${t.name}”. Save to keep it.`);
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = `${name.replace(/[^\w\- ']+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "theme"}.debridtv-theme.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function save() {
  const t = cleanTheme(draft);
  const list = customs();
  const id = draft.id ?? Math.random().toString(36).slice(2, 9);
  const entry = { id, ...t };
  setPref("customThemes", draft.id ? list.map((x) => (x.id === id ? entry : x)) : [...list, entry]);
  preview = null;
  setPref("theme", `custom:${id}`);
  closeThemeEditor();
  toast(`Theme “${t.name}” saved.`);
  onSaved?.(entry);
  onChange?.();
}

function remove() {
  const id = draft.id;
  const name = draft.name;
  if (!confirm(`Delete the theme “${name}”?`)) return;
  setPref("customThemes", customs().filter((x) => x.id !== id));
  preview = null;
  if (pref("theme") === `custom:${id}`) setPref("theme", "midnight");
  closeThemeEditor();
  toast(`Deleted “${name}”.`);
  onSaved?.(null);
  onChange?.();
}

let onChange = null;
/** panel.js can re-render its theme picker when a theme is saved or deleted. */
export function onThemesChanged(fn) {
  onChange = fn;
}

root.addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-close]");
  if (e.target === root) return closeThemeEditor();
  if (!b) return;
  const d = b.dataset;
  if (d.close !== undefined) return closeThemeEditor();
  if (d.save !== undefined) return save();
  if (d.delete !== undefined) return remove();
  if (d.start) {
    const [tag, k] = d.start.split(":");
    return useTheme((tag === "b" ? BUILTIN : STARTERS)[k]);
  }
  if (d.export !== undefined) return download(draft.name, exportJson(cleanTheme(draft)));
  if (d.copy !== undefined) {
    navigator.clipboard?.writeText(exportJson(cleanTheme(draft))).then(() => toast("Theme copied."), () => toast("Couldn't reach the clipboard. Use Download instead."));
    return;
  }
  if (d.import !== undefined) return root.querySelector("[data-file]").click();
  if (d.paste !== undefined) {
    pasting = !pasting;
    render();
    return root.querySelector(pasting ? "#thm-paste" : "[data-paste]")?.focus();
  }
  if (d.pasteGo !== undefined) return importText(root.querySelector("#thm-paste").value);
});

root.addEventListener("input", (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.name !== undefined) draft.name = t.value;
  else if (d.color) draft.colors[d.color] = t.value.toLowerCase();
  else if (d.hex) {
    const h = normHex(t.value);
    t.classList.toggle("bad", !h);
    if (!h) return;
    draft.colors[d.hex] = h;
  } else if (d.cell !== undefined) {
    draft.cellStrength = Number(t.value);
    t.previousElementSibling.querySelector("output").textContent = `${t.value}%`;
  } else return;
  refreshPickers();
  live();
});

root.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.hex !== undefined) t.value = draft.colors[t.dataset.hex]; // tidy a half-typed value
  if (t.dataset.file === undefined || !t.files?.[0]) return;
  readFile(t.files[0]);
  t.value = "";
});

function readFile(f) {
  if (f.size > 20_000) return toast("That file is too big to be a theme.");
  f.text().then(importText, () => toast("Couldn't read that file."));
}

root.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  e.preventDefault();
  root.classList.add("drop");
});
root.addEventListener("dragleave", (e) => {
  if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove("drop");
});
root.addEventListener("drop", (e) => {
  e.preventDefault();
  root.classList.remove("drop");
  const f = e.dataTransfer?.files?.[0];
  if (f) readFile(f);
});

addEventListener("keydown", (e) => {
  if (!themeEditorOpen() || e.key !== "Escape") return;
  e.preventDefault();
  e.stopImmediatePropagation(); // don't also close the settings panel behind
  closeThemeEditor();
}, true);
