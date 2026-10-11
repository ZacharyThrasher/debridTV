// Settings. Every account action here is explicit and says what it will cost:
// connecting reads your library list, scanning reads a few KB per file, and
// nothing ever adds, removes or downloads anything in your accounts.

import { api } from "./api.js";
import { html, raw, esc, fmtBytes, ago, pref, setPref, toast, fmtTime } from "./util.js";
import { tv, applyVolume } from "./player.js";

const panel = document.getElementById("panel");
const body = document.getElementById("panel-body");
let tab = "sources";
let poll = 0;
let onChange = () => {};

export const panelOpen = () => !panel.hidden;

export function initPanel(changed) {
  onChange = changed;
  panel.querySelector("[data-close]").addEventListener("click", closePanel);
  panel.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
}

export function openPanel(which = tab) {
  panel.hidden = false;
  document.body.classList.add("panel-open");
  showTab(which);
}

export function closePanel() {
  panel.hidden = true;
  document.body.classList.remove("panel-open");
  clearInterval(poll);
}

function showTab(t) {
  tab = t;
  panel.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  clearInterval(poll);
  render();
  if (t === "meters" || t === "sources") poll = setInterval(() => !panel.hidden && !editing() && render(), 2000);
}

/** Don't redraw under someone who is typing or choosing. */
const editing = () => body.contains(document.activeElement) && document.activeElement.matches("input, select, textarea");

async function render() {
  try {
    const fn = { sources, channels, history, meters, look, privacy }[tab];
    const out = await fn();
    if (out != null) {
      const y = body.scrollTop;
      body.innerHTML = String(out);
      body.scrollTop = y;
    }
  } catch (e) {
    body.innerHTML = html`<p class="lead">Couldn't load this tab: ${e.message}</p>`;
  }
}

// ------------------------------------------------------------------ sources

const PROVIDERS = {
  torbox: { name: "TorBox", where: "torbox.app → Settings → API key", placeholder: "TorBox API key" },
  realdebrid: { name: "Real-Debrid", where: "real-debrid.com/apitoken", placeholder: "Real-Debrid API token" },
};

async function sources() {
  const s = await api.get("/api/sources");
  const card = (id) => {
    const p = PROVIDERS[id];
    const v = s[id];
    if (!v.connected)
      return html`<div class="src">
        <div class="src-head"><div class="src-name"><span class="src-dot"></span>${p.name}</div><span class="badge">Not connected</span></div>
        <div class="field"><label for="key-${id}">API key (from ${p.where})</label>
          <div class="inline"><input class="input" id="key-${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${p.placeholder}">
          <button class="btn primary" data-connect="${id}">Connect</button></div></div>
        <div class="muted">Connecting reads your library list once (one request). The key is checked with ${p.name}, then kept only on this PC.</div>
      </div>`;
    return html`<div class="src">
      <div class="src-head"><div class="src-name"><span class="src-dot on"></span>${p.name}</div><span class="badge ok">Connected · read-only</span></div>
      ${stats(v)}
      ${id === "realdebrid" && v.packsToExpand ? html`<div class="muted">${v.packsToExpand} multi-file torrents will be opened up during the scan.</div>` : ""}
      <div class="row-actions">
        <button class="btn" data-refresh="${id}">Refresh list</button>
        <button class="btn danger" data-disconnect="${id}">Disconnect &amp; delete key</button>
        <span class="muted">Updated ${v.refreshedAt ? ago(v.refreshedAt) : "never"}</span>
      </div>
    </div>`;
  };
  const sc = s.scan;
  const pct = sc.total ? Math.round((sc.done / sc.total) * 100) : 0;
  return html`
    <h3>Your sources</h3>
    <p class="lead">DebridTV builds channels from libraries you already have. It only <b>reads</b>: it never adds, removes or downloads anything in your accounts.</p>
    ${raw(card("torbox"))}${raw(card("realdebrid"))}
    <div class="src">
      <div class="src-head"><div class="src-name"><span class="src-dot ${s.local.connected ? "on" : ""}"></span>This PC</div>${s.local.connected ? raw('<span class="badge ok">Watching folders</span>') : raw('<span class="badge">Optional</span>')}</div>
      ${s.local.connected ? raw(stats(s.local)) : ""}
      <div class="field"><label for="dirs">Video folders, one per line</label>
        <textarea class="input" id="dirs" rows="3" spellcheck="false" placeholder="D:\\Videos\\TV">${s.local.dirs.join("\n")}</textarea></div>
      <div class="row-actions"><button class="btn" data-local>Save folders</button></div>
    </div>

    <h3>Program lengths</h3>
    <p class="lead">A channel can only schedule a program once its exact running time is known. DebridTV learns it by reading a few kilobytes from the start of each file. It never downloads whole files, and it only runs when you start it.</p>
    <div class="src">
      ${sc.running
        ? html`<div class="src-head"><b>Scanning${sc.current ? html`: ${sc.current}` : ""}</b><span class="muted">${sc.done} / ${sc.total}</span></div>
            <div class="progressbar"><i style="width:${pct}%"></i></div>
            <div class="row-actions"><button class="btn" data-scan-stop>Stop</button><span class="muted">Pace: ${sc.perMinute} files a minute</span></div>`
        : html`<div class="src-head"><b>${sc.needed ? `${sc.needed} files still need a running time` : "Every file has a running time"}</b></div>
            ${sc.stoppedReason ? html`<div class="muted" style="color:var(--warn)">Stopped: ${sc.stoppedReason}</div>` : ""}
            ${sc.lastError ? html`<div class="muted" style="color:var(--bad)">Last error: ${sc.lastError}</div>` : ""}
            <div class="row-actions">
              <button class="btn primary" data-scan-start ${sc.needed ? "" : "disabled"}>Scan now</button>
              <select class="input" style="width:auto" id="pace" aria-label="Pace">
                ${raw([10, 30, 60, 120].map((n) => `<option value="${n}" ${n === sc.perMinute ? "selected" : ""}>${n} files / min${n === 30 ? " (gentle)" : ""}</option>`).join(""))}
              </select>
            </div>`}
    </div>
    <p class="muted">Your keys and library facts are stored in <code>${s.dataDir}</code>.</p>`;
}

function stats(v) {
  return html`<div class="stats">
    <div class="stat"><b>${v.video}</b><span>videos</span></div>
    <div class="stat"><b>${v.timed}</b><span>ready to air</span></div>
    <div class="stat"><b>${v.policyBlocked}</b><span>refused</span></div>
    <div class="stat"><b>${v.unavailable + v.probeErrors}</b><span>problems</span></div>
  </div>`;
}

body.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const busy = (label) => {
    b.disabled = true;
    b.textContent = label;
  };
  try {
    if (b.dataset.connect) {
      const id = b.dataset.connect;
      const key = document.getElementById(`key-${id}`).value.trim();
      if (!key) return toast("Paste your API key first.");
      busy("Checking…");
      const r = await api.post("/api/sources", { provider: id, key });
      toast(`${PROVIDERS[id].name} connected: ${r.files ?? 0} files found.`);
      onChange();
    } else if (b.dataset.refresh) {
      busy("Refreshing…");
      await api.post("/api/sources/refresh", { provider: b.dataset.refresh });
      onChange();
    } else if (b.dataset.disconnect) {
      const id = b.dataset.disconnect;
      if (!confirm(`Disconnect ${PROVIDERS[id].name}? Its key will be deleted from this PC. Your watch history stays.`)) return;
      await api.post("/api/sources/disconnect", { provider: id });
      toast(`${PROVIDERS[id].name} disconnected. Key deleted.`);
      onChange();
    } else if ("local" in b.dataset) {
      const dirs = document.getElementById("dirs").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const r = await api.post("/api/sources", { provider: "local", dirs });
      toast(`${r.files} files found in ${r.dirs.length} folder${r.dirs.length === 1 ? "" : "s"}.`);
      onChange();
    } else if ("scanStart" in b.dataset) {
      await api.post("/api/scan/start", { perMinute: Number(document.getElementById("pace")?.value ?? 30) });
    } else if ("scanStop" in b.dataset) {
      await api.post("/api/scan/stop");
    } else if (b.dataset.hide) {
      await api.post("/api/channels/hide", { ruleKey: b.dataset.hide, hidden: b.dataset.hidden !== "1" });
      onChange();
    } else if ("clearHistory" in b.dataset) {
      if (!confirm("Clear your whole viewing history? This can't be undone.")) return;
      await api.post("/api/history/clear");
      toast("History cleared.");
    } else if ("newChannel" in b.dataset) {
      return void (body.innerHTML = String(await builder()));
    } else if ("saveChannel" in b.dataset) {
      const name = document.getElementById("cname").value.trim();
      const showKeys = [...body.querySelectorAll("[data-show]:checked")].map((i) => i.dataset.show);
      const movieIds = [...body.querySelectorAll("[data-movie]:checked")].map((i) => i.dataset.movie);
      if (!name) return toast("Give the channel a name.");
      if (!showKeys.length && !movieIds.length) return toast("Pick at least one show or movie.");
      await api.post("/api/channels/custom", { name, showKeys, movieIds, ordering: document.getElementById("cord").value, slotMinutes: Number(document.getElementById("cslot").value) });
      toast(`${name} is on the air.`);
      onChange();
    } else if (b.dataset.deleteCustom) {
      await api.post("/api/channels/custom/delete", { id: b.dataset.deleteCustom });
      onChange();
    } else if ("cancel" in b.dataset) {
      // fallthrough to re-render
    } else return;
  } catch (err) {
    toast(err.message, 5000);
  }
  render();
});

// ------------------------------------------------------------------ channels

const ORDERINGS = {
  "block-shuffle": "Blocks of a few episodes, shuffled",
  cyclic: "In order, then repeat",
  shuffle: "Fully shuffled",
  "block-cyclic": "Blocks of a few episodes, in order",
  "round-robin-cyclic": "One episode of each show, taking turns",
  "round-robin-shuffle": "Taking turns, episodes shuffled",
  "marathon-cyclic": "Long runs of one show, in order",
  "marathon-shuffle": "Long runs of one show, shuffled",
};

async function channels() {
  const r = await api.get("/api/channels");
  const items = r.channels.map((c) => {
    const custom = c.ruleKey.startsWith("custom:");
    return html`<div class="li ${c.hidden ? "off" : ""}" style="--h:${c.hue}">
      <span class="n">${c.number}</span>
      <div><div class="t">${c.name}</div><div class="d">${c.items} programs · ${ORDERINGS[c.ordering] ?? c.ordering}</div></div>
      <div class="inline">
        ${custom ? html`<button class="btn danger" data-delete-custom="${c.ruleKey.slice(7)}" aria-label="Delete ${c.name}">Delete</button>` : ""}
        <button class="btn" data-hide="${c.ruleKey}" data-hidden="${c.hidden ? "1" : "0"}">${c.hidden ? "Show" : "Hide"}</button>
      </div></div>`;
  });
  return html`<h3>Channels</h3>
    <p class="lead">Channels build themselves from your library and keep their numbers when it changes. Hide the ones you don't want, or make your own.</p>
    <div class="row-actions" style="margin-bottom:1em"><button class="btn primary" data-new-channel>+ New channel</button></div>
    <div class="list">${raw(items.join(""))}</div>`;
}

async function builder() {
  const lib = await api.get("/api/library");
  return html`<h3>New channel</h3>
    <div class="field"><label for="cname">Name</label><input class="input" id="cname" maxlength="40" placeholder="Saturday Morning"></div>
    <div class="field"><label for="cord">Order</label><select class="input" id="cord">${raw(Object.entries(ORDERINGS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""))}</select></div>
    <div class="field"><label for="cslot">Start programs on the</label><select class="input" id="cslot">
      <option value="0">Next minute (no gaps)</option><option value="15">Quarter hour</option><option value="30" selected>Half hour</option><option value="60">Hour</option></select></div>
    <div class="field"><label>Shows</label><div class="pickgrid">${raw(lib.shows.map((s) => html`<label class="pick"><input type="checkbox" data-show="${s.key}">${s.name}<small>${s.timed}/${s.episodes} ready</small></label>`).join("") || '<span class="muted">No shows yet.</span>')}</div></div>
    <div class="field"><label>Movies</label><div class="pickgrid">${raw(lib.movies.map((m) => html`<label class="pick"><input type="checkbox" data-movie="${m.id}">${m.title}${m.year ? ` (${m.year})` : ""}<small>${m.timed ? "ready" : "needs scan"}</small></label>`).join("") || '<span class="muted">No movies yet.</span>')}</div></div>
    <div class="row-actions"><button class="btn primary" data-save-channel>Put it on the air</button><button class="btn" data-cancel>Cancel</button></div>`;
}

// ------------------------------------------------------------------ history

async function history() {
  const h = await api.get("/api/history");
  const rows = h.recent.map((r) => {
    const pct = r.durationMs ? Math.min(100, Math.round((r.seenMs / r.durationMs) * 100)) : 0;
    return html`<div class="li" style="grid-template-columns:1fr auto">
      <div><div class="t">${r.title}</div><div class="d">${ago(r.at)} · seen ${pct}%</div>
        <div class="progressbar" style="max-width:16em"><i style="width:${pct}%"></i></div></div>
      ${r.watched ? raw('<span class="badge ok">✓ Watched</span>') : raw('<span class="badge">In progress</span>')}</div>`;
  });
  return html`<h3>Viewing history</h3>
    <p class="lead">A program counts as watched once you've actually seen ${Math.round(h.threshold * 100)}% of it. Catching the last few minutes doesn't count, and station breaks never do. History stays on this PC.</p>
    <div class="list">${rows.length ? raw(rows.join("")) : raw('<p class="muted">Nothing yet. Start watching!</p>')}</div>
    ${rows.length ? raw('<div class="row-actions" style="margin-top:1em"><button class="btn danger" data-clear-history>Clear history</button></div>') : ""}`;
}

// ------------------------------------------------------------------ meters

async function meters() {
  const m = await api.get("/api/meters");
  const api_ = Object.entries(m.api).sort((a, b) => b[1] - a[1]);
  return html`<h3>Meters</h3>
    <p class="lead">Everything DebridTV asks of your providers since it started (${fmtTime(m.since)}). Browsing the guide and surfing past channels should cost nothing.</p>
    <div class="stats">
      <div class="stat"><b>${m.apiTotal}</b><span>API calls</span></div>
      <div class="stat"><b>${fmtBytes(m.bytes.playback)}</b><span>watched bytes</span></div>
      <div class="stat"><b>${fmtBytes(m.bytes.probe)}</b><span>scan bytes</span></div>
      <div class="stat"><b>${m.tunes}</b><span>channel changes</span></div>
      <div class="stat"><b>${m.streamsOpened}</b><span>streams opened</span></div>
      <div class="stat"><b>${m.streamsCancelled}</b><span>cancelled</span></div>
      <div class="stat"><b>${m.activeStreams}</b><span>open now</span></div>
      <div class="stat"><b>${m.peakStreams}</b><span>most at once</span></div>
    </div>
    ${api_.length ? html`<h3>Calls by type</h3><div class="list">${raw(api_.map(([k, v]) => html`<div class="li" style="grid-template-columns:1fr auto"><span>${k}</span><b>${v}</b></div>`).join(""))}</div>` : ""}
    <h3>Recent events</h3>
    <div class="events">${m.events.length ? raw(m.events.slice().reverse().map((e) => html`<div class="${e.kind}">${new Date(e.at).toLocaleTimeString()} · ${e.kind} · ${e.detail}</div>`).join("")) : raw("<div>No provider traffic yet.</div>")}</div>`;
}

// ------------------------------------------------------------------ look & feel

function look() {
  const sw = (k, label, desc) => html`<div class="opt"><div><div class="ol">${label}</div><div class="od">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-pref="${k}" ${pref(k) ? "checked" : ""}><i></i></label></div>`;
  const themes = [["midnight", "Midnight"], ["cable92", "Cable '92"], ["daylight", "Daylight"]];
  return html`<h3>Look &amp; feel</h3>
    <div class="opt"><div><div class="ol">Theme</div><div class="od">Colors for the guide and menus.</div></div>
      <select class="input" style="width:auto" data-pref-select="theme">${raw(themes.map(([k, v]) => `<option value="${k}" ${pref("theme") === k ? "selected" : ""}>${v}</option>`).join(""))}</select></div>
    ${raw(sw("crt", "CRT screen", "Scanlines and a soft vignette, like an old set."))}
    ${raw(sw("static", "Static between channels", "Snow while the next channel tunes in."))}
    ${raw(sw("sound", "Tuner sounds", "A click and a hiss when you change channel."))}
    ${raw(sw("clock24", "24-hour clock", "Show 21:30 instead of 9:30 PM."))}
    ${raw(sw("calm", "Reduce motion", "Turn off animations."))}
    <div class="opt"><div><div class="ol">Volume</div></div><input type="range" min="0" max="1" step="0.05" value="${pref("volume")}" data-volume aria-label="Volume"></div>`;
}

body.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.pref) setPref(t.dataset.pref, t.checked);
  else if (t.dataset.prefSelect) setPref(t.dataset.prefSelect, t.value);
});
body.addEventListener("input", (e) => {
  if ("volume" in e.target.dataset) {
    setPref("volume", Number(e.target.value));
    applyVolume();
  }
});

// ------------------------------------------------------------------ privacy

async function privacy() {
  const b = await api.get("/api/bootstrap");
  const gate = (on, title, desc) => html`<div class="gate"><span class="lock">${on ? "🔓" : "🔒"}</span><div><b>${title} · ${on ? "on" : "off"}</b><span>${desc}</span></div></div>`;
  return html`<h3>Privacy &amp; permissions</h3>
    <p class="lead">DebridTV runs on this PC and listens only to this PC (127.0.0.1). Nothing is shared unless you turn it on, and each of these needs its own separate yes.</p>
    ${raw(gate(b.gates.sharing, "Sharing", "Letting other people or devices watch your channels. Not built yet, and off until you say so."))}
    ${raw(gate(b.gates.cloudRelay, "Cloud relay", "Streaming through a server instead of your own PC. Off: Real-Debrid treats server traffic differently, so this needs your explicit choice."))}
    ${raw(gate(b.gates.tunerExport, "Tuner export", "Showing your channels to Plex, Jellyfin or other TV apps as a tuner. Off until you say so."))}
    <h3>What leaves this PC</h3>
    <p class="lead">Only requests to the providers you connected: the library list when you connect or refresh, one link request per program you watch (reused for an hour), the few KB a scan reads, and the video you actually watch. The Meters tab counts all of it.</p>`;
}
