// Settings → Add (PC only). Search the indexers you added yourself and the
// Internet Archive, then press Add to send a result to TorBox or Real-Debrid.
// Also: paste magnets, hashes and links, upload a .torrent or .nzb, and a
// watched folder. Nothing reaches an account until "Allow adding" is on and you
// press Add (or drop a file in the watched folder). DebridTV ships no indexers.
// A Stremio addon the viewer adds is searched by IMDb id and only its torrents are
// listed; DebridTV never opens an addon's own play links.
// Styles use the redesign tokens only (styles.css and tokens.css belong to it; see
// docs/design/ai-tells.md: one face, 2 to 4 px corners, red only for live).

import { api } from "./api.js";
import { html, raw, fmtBytes, ago, toast } from "./util.js";

const NAMES = { torbox: "TorBox", realdebrid: "Real-Debrid" };
const KINDS = { torznab: "Torznab", newznab: "Newznab", stremio: "Stremio addon" };
let state = { q: "", type: "search", results: null, sources: [], searching: false, error: "", showIndexerForm: false };
let rerender = () => {};
let jobTimer = 0;

// tokens.css names (the redesign), with the older names as fallbacks until it lands.
const STYLE = `
.acq-gate{display:flex;gap:var(--sp-3,calc(var(--u)*.75));align-items:flex-start;padding:var(--sp-3,calc(var(--u)*.75)) var(--sp-4,var(--u));border:1px solid var(--rule-strong,var(--line-strong));border-radius:var(--r-2,3px);margin-bottom:var(--sp-4,var(--u))}
.acq-gate.on{border-left:3px solid var(--ok)}
.acq-gate .ol{font-weight:600}
.acq-search{display:flex;gap:var(--sp-2,calc(var(--u)*.5));flex-wrap:wrap}
.acq-search .input{flex:1 1 14em;min-width:0}
.acq-res{display:grid;margin-top:var(--sp-3,calc(var(--u)*.75));border-top:1px solid var(--rule,var(--line))}
.acq-row{display:grid;grid-template-columns:1fr auto;gap:var(--sp-3,calc(var(--u)*.75));align-items:center;padding:var(--sp-2,calc(var(--u)*.5)) 0;border-bottom:1px solid var(--rule,var(--line))}
.acq-row .t{overflow-wrap:anywhere;font-weight:600}
.acq-row .m{color:var(--ink-2,var(--dim));font-size:var(--fs-sm,.85em);margin-top:.2em;font-variant-numeric:tabular-nums}
.acq-row .m b{color:var(--ok);font-weight:600}
.acq-row .m b.zero{color:var(--ink-3,var(--faint))}
.acq-acts{display:flex;gap:var(--sp-1,calc(var(--u)*.25));flex-wrap:wrap;justify-content:flex-end}
.acq-src{color:var(--ink-3,var(--faint));font-size:var(--fs-sm,.85em);margin-top:var(--sp-2,calc(var(--u)*.5))}
.acq-src .bad{color:var(--bad)}
.acq-paste{width:100%;min-height:6em;resize:vertical;font-family:var(--font-ui,inherit)}
.acq-job{display:grid;grid-template-columns:auto 1fr;gap:var(--sp-3,calc(var(--u)*.75));align-items:start;padding:var(--sp-2,calc(var(--u)*.5)) 0;border-bottom:1px solid var(--rule,var(--line))}
.acq-dot{width:.6em;height:.6em;border-radius:var(--r-pill,999px);margin-top:.45em;background:var(--ink-3,var(--faint))}
.acq-dot.added{background:var(--ok)}.acq-dot.failed{background:var(--bad)}.acq-dot.adding,.acq-dot.waiting{background:var(--warn)}
.acq-ix{display:grid;grid-template-columns:1fr auto;gap:var(--sp-2,calc(var(--u)*.5));align-items:center;padding:var(--sp-2,calc(var(--u)*.5)) 0;border-bottom:1px solid var(--rule,var(--line))}
html[data-where="device"] #panel [data-tab="add"]{display:none}
@media (max-width:600px){.acq-row{grid-template-columns:1fr}.acq-acts{justify-content:flex-start}}
`;

/** Called once by panel.js with the panel body and a function that redraws the tab. */
export function initAdd(body, redraw) {
  rerender = redraw;
  if (!document.getElementById("acq-style")) {
    const s = document.createElement("style");
    s.id = "acq-style";
    s.textContent = STYLE;
    document.head.append(s);
  }
  body.addEventListener("click", onClick);
  body.addEventListener("change", onChange);
  body.addEventListener("submit", (e) => {
    if (e.target.id === "acq-search-form") {
      e.preventDefault();
      void search();
    }
  });
}

export async function addTab() {
  const [s, j] = await Promise.all([api.get("/api/acquire/settings"), api.get("/api/acquire/jobs")]);
  const busy = j.jobs.some((x) => x.state === "waiting" || x.state === "adding");
  clearTimeout(jobTimer);
  if (busy) jobTimer = setTimeout(() => document.querySelector('[data-tab="add"][aria-selected="true"]') && rerender(), 2000);
  const targets = s.targets;
  const gate = html`<div class="acq-gate ${s.allowAdding ? "on" : ""}">
    <div style="flex:1"><div class="ol">Allow adding · ${s.allowAdding ? "on" : "off"}</div>
      <div class="od muted">${s.allowAdding
        ? "Add buttons send to your account straight away. Adds count against your provider's limits like adds from any other app."
        : "While this is off, nothing is ever added to your accounts. Search still works so you can look around."}</div></div>
    <button class="btn ${s.allowAdding ? "" : "primary"}" data-acq-allow="${s.allowAdding ? "0" : "1"}">${s.allowAdding ? "Turn off" : "Turn on"}</button>
  </div>`;
  const noTargets = !targets.length
    ? html`<p class="lead">Connect TorBox or Real-Debrid in Sources first. That's where added things go.</p>` : "";
  const target = targets.length > 1
    ? html`<div class="field"><label for="acq-to">Add to</label><select class="input" id="acq-to">${raw(targets.map((t) => html`<option value="${t}" ${t === s.addTo ? "selected" : ""}>${NAMES[t]}</option>`).join(""))}</select></div>` : "";

  return html`<h3>Add</h3>
    <p class="lead">Find something and put it in your TorBox or Real-Debrid account. It joins your channels after the next scan.</p>
    ${raw(gate)}${raw(noTargets)}${raw(target)}
    <h4>Search</h4>
    ${raw(searchBox(s))}
    ${raw(resultsHtml(s))}
    <h4>Paste or upload</h4>
    <div class="field"><label for="acq-paste">Magnet links, info hashes, .torrent or .nzb links, or web links (TorBox). One per line.</label>
      <textarea class="input acq-paste" id="acq-paste" spellcheck="false" placeholder="magnet:?xt=urn:btih:…"></textarea></div>
    <div class="row-actions"><button class="btn primary" data-acq-paste ${s.allowAdding && targets.length ? "" : "disabled"}>Add</button>
      <label class="btn" for="acq-file">Upload .torrent or .nzb…</label>
      <input type="file" id="acq-file" accept=".torrent,.nzb,application/x-bittorrent,application/x-nzb" hidden ${s.allowAdding && targets.length ? "" : "disabled"}></div>
    <h4>Recent adds</h4>
    ${raw(jobsHtml(j.jobs))}
    <h4>Watched folder</h4>
    <div class="field"><label for="acq-dir">Drop .torrent, .magnet or .nzb files in this folder and DebridTV adds them (only while adding is on). Done files move into "added" or "failed" inside it.</label>
      <div class="inline"><input class="input" id="acq-dir" spellcheck="false" placeholder="C:\\Users\\you\\Downloads\\DebridTV" value="${s.watchDir}">
      <button class="btn" data-acq-dir>Save</button>${s.watchDir ? html`<button class="btn" data-acq-folder-now>Check now</button>` : ""}</div></div>
    <h4>Search sources</h4>
    ${raw(indexersHtml(s))}`;
}

function searchBox(s) {
  const has = s.indexers.some((i) => i.enabled) || s.archiveSearch;
  const addon = s.indexers.some((i) => i.enabled && i.kind === "stremio");
  return html`<form id="acq-search-form" class="acq-search" role="search">
      <input class="input" id="acq-q" type="search" placeholder="${has ? (addon ? "Title, show or film. S2E5 for an episode" : "Title, show or film") : "Add a search source below first"}" value="${state.q}" ${has ? "" : "disabled"}>
      <select class="input" id="acq-type" aria-label="What kind" style="flex:0 0 auto;width:auto">
        <option value="search" ${state.type === "search" ? "selected" : ""}>Anything</option>
        <option value="tvsearch" ${state.type === "tvsearch" ? "selected" : ""}>TV</option>
        <option value="movie" ${state.type === "movie" ? "selected" : ""}>Films</option>
      </select>
      <button class="btn primary" type="submit" ${has && !state.searching ? "" : "disabled"}>${state.searching ? "Searching…" : "Search"}</button>
    </form>`;
}

function resultsHtml(s) {
  if (state.error) return html`<p class="muted">${state.error}</p>`;
  if (!state.results) return "";
  const src = state.sources.map((x) => x.error ? html`<span class="bad">${x.source}: ${x.error}</span>` : html`${x.source}: ${x.count}${x.note ? ` (${x.note})` : ""}`).join(" · ");
  if (!state.results.length) return html`<p class="muted">Nothing found for “${state.q}”.</p><div class="acq-src">${raw(src)}</div>`;
  const canAdd = s.allowAdding && s.targets.length;
  const rows = state.results.slice(0, 80).map((r, i) => {
    const meta = [
      r.seeders != null ? html`<b class="${r.seeders ? "" : "zero"}">${r.seeders} seeding</b>` : "",
      r.size ? fmtBytes(r.size) : "",
      r.kind === "usenet" ? "Usenet" : "",
      when(r.published),
      r.source,
    ].filter(Boolean).map((x) => html`${x}`).join(" · ");
    const usenet = r.kind === "usenet";
    const btns = s.targets.filter((t) => !usenet || t === "torbox").map((t) =>
      html`<button class="btn ${t === s.addTo ? "primary" : ""}" data-acq-add="${i}" data-to="${t}" ${canAdd ? "" : "disabled"} title="${canAdd ? "" : "Turn on Allow adding first"}">Add to ${NAMES[t]}</button>`).join("");
    const info = r.infoUrl ? html`<a class="btn" href="${r.infoUrl}" target="_blank" rel="noopener noreferrer">Details</a>` : "";
    return html`<div class="acq-row"><div><div class="t">${r.title}</div><div class="m">${raw(meta)}</div></div>
      <div class="acq-acts">${raw(btns)}${raw(info)}</div></div>`;
  }).join("");
  return html`<div class="acq-res">${raw(rows)}</div><div class="acq-src">${raw(src)}</div>`;
}

/** "3 hr ago" from a date the indexer sent, or nothing when it sent none it could mean. */
function when(v) {
  const ms = typeof v === "number" ? v : Date.parse(v ?? "");
  return Number.isFinite(ms) && ms > 0 ? ago(ms) : "";
}

function jobsHtml(jobs) {
  if (!jobs.length) return html`<p class="muted">Nothing added yet.</p>`;
  const word = { waiting: "Waiting", adding: "Adding", added: "Added", failed: "Didn't add" };
  return jobs.slice(0, 15).map((j) => html`<div class="acq-job"><span class="acq-dot ${j.state}"></span>
    <div><div>${j.title}</div><div class="muted">${word[j.state]} · ${NAMES[j.provider]} · ${j.via === "folder" ? "watched folder" : j.via} · ${ago(j.doneAt ?? j.at)}${j.message ? html` · ${j.message}` : ""}</div></div></div>`).join("");
}

function indexersHtml(s) {
  const archive = html`<div class="acq-ix"><div><div>Internet Archive</div><div class="muted">Public-domain and freely licensed films and TV, seeded by the Archive itself.</div></div>
    <button class="btn" data-acq-archive="${s.archiveSearch ? "0" : "1"}">${s.archiveSearch ? "Turn off" : "Turn on"}</button></div>`;
  const list = s.indexers.map((ix) => html`<div class="acq-ix"><div><div>${ix.name}</div>
      <div class="muted">${KINDS[ix.kind] ?? "Torznab"}${ix.enabled ? "" : " · off"} · ${ix.url}${ix.hasKey ? " · key saved on this PC" : ""}</div></div>
    <div class="acq-acts"><button class="btn" data-acq-ix-test="${ix.id}">Test</button><button class="btn" data-acq-ix-remove="${ix.id}">Remove</button></div></div>`).join("");
  const form = state.showIndexerForm
    ? html`<div class="src">
        <p class="muted">Any Torznab or Newznab address works, for example from Prowlarr or Jackett running on this PC, or a Usenet indexer. So does a Stremio addon that lists streams. DebridTV doesn't come with any. You choose what to search and what to add.</p>
        <div class="field"><label for="acq-ix-kind">Kind</label><select class="input" id="acq-ix-kind"><option value="torznab">Torznab (torrents)</option><option value="newznab">Newznab (Usenet)</option><option value="stremio">Stremio addon</option></select></div>
        <div class="field"><label for="acq-ix-name">Name</label><input class="input" id="acq-ix-name" placeholder="My indexer"></div>
        <div class="field"><label for="acq-ix-url">Address</label><input class="input" id="acq-ix-url" spellcheck="false" placeholder="http://127.0.0.1:9696/1/api"></div>
        <p class="muted" id="acq-ix-addon-note" hidden>Paste the addon's manifest.json link. These links often carry your addon settings and keys, so DebridTV keeps the whole link on this PC. It only reads the addon's list of torrents and never opens its play links, so nothing reaches your account until you press Add.</p>
        <div class="field" id="acq-ix-key-field"><label for="acq-ix-key">API key (kept only on this PC)</label><input class="input" id="acq-ix-key" type="password" autocomplete="off" spellcheck="false"></div>
        <div class="row-actions"><button class="btn primary" data-acq-ix-save>Test and save</button><button class="btn" data-acq-ix-form="0">Cancel</button></div>
      </div>`
    : html`<div class="row-actions"><button class="btn" data-acq-ix-form="1">Add a search source…</button></div>`;
  return archive + list + form;
}

async function search() {
  const q = document.getElementById("acq-q")?.value.trim() ?? "";
  if (!q) return toast("Type something to search for.");
  state = { ...state, q, type: document.getElementById("acq-type")?.value ?? "search", searching: true, error: "" };
  rerender();
  try {
    const r = await api.get(`/api/acquire/search?q=${encodeURIComponent(q)}&type=${state.type}`);
    state = { ...state, results: r.results, sources: r.sources, searching: false };
  } catch (e) {
    state = { ...state, results: null, sources: [], searching: false, error: e.message };
  }
  await rerender();
  document.getElementById("acq-q")?.focus();
}

function added(r) {
  const n = r.jobs?.length ?? 0;
  const extra = [r.skipped?.length ? `${r.skipped.length} line${r.skipped.length === 1 ? "" : "s"} skipped` : "", ...(r.refused ?? [])].filter(Boolean).join(". ");
  toast(`${n === 1 ? "Adding it" : `Adding ${n}`}. Watch Recent adds below.${extra ? ` ${extra}.` : ""}`);
}

async function onClick(e) {
  const b = e.target.closest("button");
  if (!b || !Object.keys(b.dataset).some((k) => k.startsWith("acq"))) return;
  const d = b.dataset;
  try {
    if (d.acqAllow) {
      if (d.acqAllow === "1" && !confirm("Turn on adding? Add buttons and the watched folder will then put things straight into your TorBox or Real-Debrid account.")) return;
      await api.post("/api/acquire/settings", { allowAdding: d.acqAllow === "1" });
    } else if (d.acqAdd != null) {
      const r = state.results?.[Number(d.acqAdd)];
      if (!r) return;
      b.disabled = true;
      b.textContent = "Adding…";
      added(await api.post("/api/acquire/add", { result: r, provider: d.to }));
    } else if ("acqPaste" in d) {
      const text = document.getElementById("acq-paste").value;
      if (!text.trim()) return toast("Paste a magnet link, hash or link first.");
      added(await api.post("/api/acquire/add", { text, provider: document.getElementById("acq-to")?.value }));
    } else if ("acqDir" in d) {
      await api.post("/api/acquire/settings", { watchDir: document.getElementById("acq-dir").value.trim() });
      toast("Watched folder saved.");
    } else if ("acqFolderNow" in d) {
      const r = await api.post("/api/acquire/folder");
      toast(r.queued ? `Adding ${r.queued} file${r.queued === 1 ? "" : "s"} from the folder.` : "Nothing new in the folder (or adding is off).");
    } else if (d.acqArchive) {
      await api.post("/api/acquire/settings", { archiveSearch: d.acqArchive === "1" });
    } else if (d.acqIxForm) {
      state.showIndexerForm = d.acqIxForm === "1";
    } else if ("acqIxSave" in d) {
      b.disabled = true;
      b.textContent = "Testing…";
      const kind = document.getElementById("acq-ix-kind").value;
      const r = await api.post("/api/indexers", {
        name: document.getElementById("acq-ix-name").value,
        url: document.getElementById("acq-ix-url").value,
        ...(kind === "stremio" ? {} : { apiKey: document.getElementById("acq-ix-key").value }),
        kind,
      });
      state.showIndexerForm = false;
      toast(r.test.ok ? `${r.indexer.name} answered${r.test.title ? ` (${r.test.title})` : ""}. Saved.` : `Saved, but it didn't answer the test: ${r.test.error}`);
    } else if (d.acqIxTest) {
      const r = await api.post("/api/indexers/test", { id: d.acqIxTest });
      toast(r.ok ? `It answered${r.title ? ` (${r.title})` : ""}.` : `No good: ${r.error}`);
      return;
    } else if (d.acqIxRemove) {
      if (!confirm("Remove this search source and its saved key?")) return;
      await api.post("/api/indexers/remove", { id: d.acqIxRemove });
    }
  } catch (err) {
    toast(err.message);
  }
  rerender();
}

async function onChange(e) {
  if (e.target.id === "acq-ix-kind") {
    const addon = e.target.value === "stremio";
    document.getElementById("acq-ix-key-field").hidden = addon;
    document.getElementById("acq-ix-addon-note").hidden = !addon;
    const url = document.getElementById("acq-ix-url");
    url.placeholder = addon ? "https://…/manifest.json" : "http://127.0.0.1:9696/1/api";
    document.getElementById("acq-ix-name").placeholder = addon ? "Leave empty to use the addon's name" : "My indexer";
    return;
  }
  if (e.target.id === "acq-to") {
    await api.post("/api/acquire/settings", { addTo: e.target.value }).catch((err) => toast(err.message));
    return rerender();
  }
  if (e.target.id !== "acq-file") return;
  const f = e.target.files?.[0];
  if (!f) return;
  if (f.size > 700_000) return toast("That file is too big to upload here. Use its magnet link instead.");
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  try {
    added(await api.post("/api/acquire/add", { file: btoa(bin), name: f.name, provider: /\.nzb$/i.test(f.name) ? "torbox" : document.getElementById("acq-to")?.value }));
  } catch (err) {
    toast(err.message);
  }
  rerender();
}
