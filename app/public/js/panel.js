// Settings. Every account action here is explicit and says what it will cost:
// connecting reads your account status and library list, scanning reads a few KB
// per file, and nothing ever adds, removes or downloads anything in your accounts.
// The Library tab shows where each file stands (listed, finished at the provider,
// timed, playable, refused) without making any provider request.

import { api } from "./api.js";
import { html, raw, esc, fmtBytes, fmtDur, ago, pref, setPref, toast, fmtTime } from "./util.js";
import { tv, applyVolume } from "./player.js";
import { keepFocus } from "./spatial.js";

const panel = document.getElementById("panel");
const body = document.getElementById("panel-body");
let tab = "sources";
let poll = 0;
let onChange = () => {};

export const panelOpen = () => !panel.hidden;

export function initPanel(changed) {
  onChange = changed;
  panel.querySelector("[data-close]").addEventListener("click", closePanel);
  // The Library tab arrived after the markup; add its button if the page doesn't have one yet.
  if (!panel.querySelector('[data-tab="library"]')) {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.dataset.tab = "library";
    b.textContent = "Library";
    panel.querySelector('[data-tab="sources"]')?.after(b);
  }
  panel.querySelectorAll("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    // A remote moving along the tabs shows each one, like a TV settings menu.
    b.addEventListener("focus", () => {
      clearTimeout(tabTimer);
      if (document.documentElement.classList.contains("remote") && b.dataset.tab !== tab) tabTimer = setTimeout(() => showTab(b.dataset.tab), 180);
    });
  });
}
let tabTimer = 0;

/** `section` picks a part of a tab: openPanel("library", "ratings") opens the age ratings and focuses its search. */
export function openPanel(which = tab, section) {
  if (which === "library" && (section === "ratings" || section === "files")) lib = { ...lib, view: section };
  panel.hidden = false;
  document.body.classList.add("panel-open");
  showTab(which);
  // Put the remote on the open tab so the arrows work straight away.
  if (!panel.contains(document.activeElement)) panel.querySelector(`[data-tab="${which}"]`)?.focus({ focusVisible: document.documentElement.classList.contains("remote") });
  if (which === "library" && section === "ratings")
    setTimeout(() => {
      const q = document.getElementById("lib-q");
      q?.scrollIntoView({ block: "nearest" });
      q?.focus();
    }, 150);
}

export function closePanel() {
  if (panel.contains(document.activeElement)) document.activeElement.blur(); // so OK doesn't press a hidden button
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
    const fn = { sources, library, channels, history, meters, look, privacy }[tab];
    const out = await fn();
    if (out != null) {
      const y = body.scrollTop;
      // Keep the remote's place across the 2 s refresh (spatial.js).
      keepFocus(body, () => (body.innerHTML = String(out)));
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
      <div class="src-head"><div class="src-name"><span class="src-dot ${v.account && v.account.premium === false ? "" : "on"}"></span>${p.name}</div><span class="badge ok">Connected · read-only</span></div>
      ${accountLine(id, v.account)}
      ${stats(v, id)}
      ${id === "realdebrid" && v.packsToExpand ? html`<div class="muted">${v.packsToExpand} multi-file torrents will be opened up during the scan (one request each).</div>` : ""}
      <div class="row-actions">
        <button class="btn" data-refresh="${id}" title="Two requests: your account status and your library list">Refresh list</button>
        <button class="btn danger" data-disconnect="${id}">Disconnect &amp; delete key</button>
        <span class="muted">List updated ${v.refreshedAt ? ago(v.refreshedAt) : "never"}</span>
      </div>
      <details class="x-what"><summary>What DebridTV does with this account</summary>
        <ul>
          <li><b>Reads</b> your account status (plan and when premium ends) and your library list, when you connect or press Refresh.</li>
          <li><b>Asks for one playback link</b> per program you watch or scan, and reuses it for up to an hour.</li>
          <li><b>Reads a few KB</b> from the start of a file during a scan, to learn its running time.</li>
          <li><b>Never</b> adds, selects, deletes or downloads anything in your account. Files ${p.name} hasn't finished stay off the air.</li>
          <li><b>Never</b> retries a file ${p.name} refused, or fetches it from another provider.</li>
        </ul>
      </details>
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
      ${s.local.connected ? raw(stats(s.local, "local")) : ""}
      <div class="field"><label for="dirs">Video folders, one per line</label>
        <textarea class="input" id="dirs" rows="3" spellcheck="false" placeholder="D:\\Videos\\TV">${s.local.dirs.join("\n")}</textarea></div>
      <div class="row-actions"><button class="btn" data-local>Save folders</button></div>
    </div>

    <h3>Program lengths</h3>
    <p class="lead">A channel can only schedule a program once its exact running time is known. DebridTV learns it by reading a few kilobytes from the start of each file. It never downloads whole files, and it only runs when you start it.</p>
    <div class="src">
      ${sc.running
        ? html`<div class="src-head"><b>${sc.pausedUntil ? "Paused: the provider asked DebridTV to slow down" : html`Scanning${sc.current ? html`: ${sc.current}` : ""}`}</b><span class="muted">${sc.done} / ${sc.total}</span></div>
            <div class="progressbar"><i style="width:${pct}%"></i></div>
            <div class="row-actions"><button class="btn" data-scan-stop>Stop</button><span class="muted">${sc.pausedUntil ? `Resuming in ${Math.max(0, Math.ceil((sc.pausedUntil - Date.now()) / 1000))} s` : `Pace: ${sc.perMinute} files a minute`}</span></div>`
        : html`<div class="src-head"><b>${sc.needed ? `${sc.needed} files still need a running time` : "Every file has a running time"}</b></div>
            ${sc.stoppedReason ? html`<div class="muted" style="color:var(--warn)">Stopped: ${sc.stoppedReason}</div>` : ""}
            ${sc.lastError ? html`<div class="muted" style="color:var(--bad)">Last error: ${sc.lastError}</div>` : ""}
            <div class="row-actions">
              <button class="btn primary" data-scan-start ${sc.needed ? "" : "disabled"}>Scan now</button>
              <select class="input" style="width:auto" id="pace" aria-label="Pace">
                ${raw([10, 30, 60, 120].map((n) => `<option value="${n}" ${n === sc.perMinute ? "selected" : ""}>${n} files / min${n === 30 ? " (gentle)" : ""}</option>`).join(""))}
              </select>
              ${sc.failed ? html`<button class="btn" data-scan-retry title="Clears earlier read errors so the next scan tries those files again">Try ${sc.failed} failed file${sc.failed === 1 ? "" : "s"} again</button>` : ""}
            </div>
            <div class="muted">A scan asks for one playback link per file and reads its header. Files a provider refused or hasn't finished are skipped.</div>`}
    </div>
    <p class="muted">Your keys and library facts are stored in <code>${s.dataDir}</code>.</p>`;
}

function accountLine(id, a) {
  if (!a) return html`<div class="muted">Account status not checked yet.</div>`;
  const checked = html`<span class="muted"> · checked ${ago(a.checkedAt)}</span> <button class="linkish" data-account="${id}">Check again</button>`;
  if (a.error) return html`<div class="x-acct warn">⚠ ${a.error}.${checked}</div>`;
  if (a.premium === false)
    return html`<div class="x-acct bad">Premium ${a.premiumUntil ? html`ended ${fmtDate(a.premiumUntil)}` : "has ended"}. Programs from ${PROVIDERS[id].name} can't play until it's renewed; your channels keep their place.${checked}</div>`;
  const days = a.premiumUntil ? Math.ceil((a.premiumUntil - Date.now()) / 86400000) : null;
  const plan = a.plan ? a.plan[0].toUpperCase() + a.plan.slice(1) : null;
  return html`<div class="x-acct ${days != null && days <= 7 ? "warn" : ""}">${plan ? html`<b>${plan}</b> plan` : "Premium"}${a.premiumUntil ? html` · premium until ${fmtDate(a.premiumUntil)} (${days} day${days === 1 ? "" : "s"})` : ""}${checked}</div>`;
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function stats(v, id) {
  const c = v.counts ?? {};
  const tile = (n, label, status, cls = "") =>
    html`<button class="stat x-tile ${cls}" data-goto-library="${status}" data-provider="${id}" title="Show these in Library"><b>${n}</b><span>${label}</span></button>`;
  return html`<div class="stats">
    ${tile(v.video, "videos", "")}
    ${tile(c.ready ?? v.timed, "ready to air", "ready")}
    ${c["needs-scan"] ? tile(c["needs-scan"], "need a scan", "needs-scan") : ""}
    ${c["not-ready"] ? tile(c["not-ready"], `not ready at ${PROVIDERS[id]?.name ?? "source"}`, "not-ready", "warn") : ""}
    ${tile(c.refused ?? v.policyBlocked, "refused", "refused", (c.refused ?? v.policyBlocked) ? "bad" : "")}
    ${tile((c.problem ?? 0) + (c.account ?? 0), "problems", (c.account ? "account" : "problem"), (c.problem || c.account) ? "warn" : "")}
    ${c.gone ? tile(c.gone, "removed", "gone") : ""}
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
    } else if ("scanRetry" in b.dataset) {
      const r = await api.post("/api/scan/retry-failed");
      toast(`${r.cleared} file${r.cleared === 1 ? "" : "s"} will be tried again. Press Scan now.`);
    } else if (b.dataset.account) {
      busy("Checking…");
      const r = await api.post("/api/sources/account", { provider: b.dataset.account });
      toast(r.error ? r.error : r.premium === false ? "Premium has ended on this account." : "Account is in good standing.");
    } else if ("gotoLibrary" in b.dataset) {
      lib = { ...lib, status: b.dataset.gotoLibrary, provider: b.dataset.provider === "local" ? "local" : b.dataset.provider ?? "", q: "", limit: 50 };
      return showTab("library");
    } else if ("exclusions" in b.dataset) {
      const mod = await import("./channel-editor.js").catch(() => null);
      if (mod?.openExclusions) return void mod.openExclusions({ onSaved: () => (onChange(), render()) });
      return toast("This needs the newer channel editor.");
    } else if ("backupNow" in b.dataset) {
      await api.post("/api/backups", { now: true });
      toast("Settings backed up.");
    } else if (b.dataset.restoreBackup) {
      if (!confirm("Restore this backup? Its channels and choices are merged into what you have now.")) return;
      await api.post("/api/backups/restore", { name: b.dataset.restoreBackup });
      toast("Backup restored.");
      onChange();
    } else if ("themeEdit" in b.dataset) {
      const { openThemeEditor } = await import("./theme.js");
      return void openThemeEditor({ onSaved: () => render() });
    } else if (b.dataset.libView) {
      lib = { ...lib, view: b.dataset.libView };
      return void render();
    } else if ("libFilter" in b.dataset) {
      lib = { ...lib, status: b.dataset.libFilter, limit: 50 };
      return void libList();
    } else if ("libMore" in b.dataset) {
      lib = { ...lib, limit: lib.limit + 100 };
      return void libList();
    } else if (b.dataset.check) {
      busy("Checking…");
      try {
        const r = await api.post("/api/library/check", { id: b.dataset.check });
        toast(r.message, 5000);
      } catch (err) {
        toast(err.data?.message ?? err.message, 6000);
      }
      onChange();
      return void libList();
    } else if (b.dataset.exclude) {
      await api.post("/api/library/exclude", { id: b.dataset.exclude, excluded: b.dataset.excluded !== "1" });
      toast(b.dataset.excluded !== "1" ? "Kept off the air. Channels change after what's airing now ends." : "Back on the air.");
      onChange();
      return void libList();
    } else if (b.dataset.mark) {
      await api.post("/api/history/mark", { itemId: b.dataset.item, mark: b.dataset.mark === "clear" ? null : b.dataset.mark });
      if (tab === "library") return void libList();
    } else if (b.dataset.forget) {
      await api.post("/api/history/forget", { itemId: b.dataset.forget });
      toast("Removed from your history.");
    } else if ("importSettings" in b.dataset) {
      return void document.getElementById("import-file")?.click();
    } else if ("forgetAll" in b.dataset) {
      const typed = prompt('This deletes your keys, library facts, viewing history and channels from this PC. Your provider accounts are not touched.\n\nType "forget everything" to continue.');
      if (typed?.trim().toLowerCase() !== "forget everything") return toast("Nothing was deleted.");
      await api.post("/api/forget", { confirm: "forget everything" });
      toast("Everything DebridTV knew is gone from this PC.", 5000);
      onChange();
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
    } else if ("pinSet" in b.dataset) {
      const a = pinVal("pin-new");
      if (a !== pinVal("pin-new2")) return toast("The two PINs don't match.");
      try {
        await api.post("/api/lock/pin", { pin: a });
        toast("PIN set. Lock channels with 🔓 on the Channels tab.", 5000);
      } catch (err) {
        return pinError(err);
      }
    } else if ("pinUnlock" in b.dataset) {
      try {
        const r = await api.post("/api/lock/unlock", { pin: pinVal("pin-unlock") });
        toast(`Unlocked until ${new Date(r.untilMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
        announceUnlock();
        onChange();
      } catch (err) {
        pinError(err);
      }
    } else if ("pinLock" in b.dataset) {
      await api.post("/api/lock/lock");
      toast("Locked.");
      onChange();
    } else if ("pinChange" in b.dataset || "pinRemove" in b.dataset) {
      const remove = "pinRemove" in b.dataset;
      if (remove && !confirm("Remove the PIN? Every locked channel is unlocked for good.")) return;
      try {
        const r = await api.post("/api/lock/pin", { old: pinVal("pin-old"), pin: remove ? null : pinVal("pin-change") });
        toast(remove ? `PIN removed. ${r.unlockedChannels} channel${r.unlockedChannels === 1 ? "" : "s"} unlocked.` : "PIN changed.");
        if (remove) (announceUnlock(), onChange());
      } catch (err) {
        return pinError(err);
      }
    } else if (b.dataset.lockChannel) {
      const lock = b.dataset.on !== "1";
      try {
        await api.put(`/api/channels/${b.dataset.lockChannel}/settings`, { locked: lock });
        if (!lock) announceUnlock(b.dataset.lockChannel);
      } catch (err) {
        if (!err.data?.pinRequired) throw err;
        toast("Enter the PIN above first.");
      }
      onChange();
    } else if (b.dataset.fav) {
      await api.put(`/api/channels/${b.dataset.fav}/settings`, { favorite: b.dataset.on !== "1" });
      onChange();
    } else if (b.dataset.editChannel) {
      const r = await api.get("/api/channels");
      const ch = r.channels.find((c) => c.id === b.dataset.editChannel);
      try {
        const { openChannelEditor } = await import("./channel-editor.js");
        return void openChannelEditor(ch, { onSaved: () => (onChange(), render()) });
      } catch {
        // Until the full editor ships: name and number.
        const name = prompt(`Name for channel ${ch.number}`, ch.name);
        if (name == null) return;
        const num = prompt("Channel number", String(ch.number));
        if (num == null) return;
        await api.put(`/api/channels/${ch.id}/settings`, { name: name.trim() || null, number: Number(num) });
        onChange();
      }
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
  const [r, lk] = await Promise.all([api.get("/api/channels"), api.get("/api/lock").catch(() => null)]);
  const lockBtn = (c) => !lk?.pinSet ? "" : html`<button class="btn" data-lock-channel="${c.id}" data-on="${c.locked ? "1" : "0"}" aria-pressed="${String(!!c.locked)}"
    aria-label="${c.locked ? "Unlock" : "Lock"} ${c.name}" style="${c.locked ? "color:var(--amber);border-color:var(--amber)" : "opacity:.5"}" title="${c.locked ? "Locked: needs the PIN to watch" : "Lock with the PIN"}">${c.locked ? "🔒" : "🔓"}</button>`;
  const items = r.channels.map((c) => {
    const custom = c.ruleKey.startsWith("custom:");
    return html`<div class="li ${c.hidden ? "off" : ""}" style="--h:${c.hue}">
      <span class="n">${c.number}</span>
      <div><div class="t">${c.name}</div><div class="d">${c.items} programs · ${ORDERINGS[c.ordering] ?? c.ordering}</div></div>
      <div class="inline">
        <button class="btn x-fav" style="${c.favorite ? "color:var(--amber)" : ""}" data-fav="${c.id}" data-on="${c.favorite ? "1" : "0"}" aria-pressed="${String(!!c.favorite)}" aria-label="${c.favorite ? "Remove from" : "Add to"} favorites" title="Favorite">${c.favorite ? "★" : "☆"}</button>
        ${raw(lockBtn(c))}
        <button class="btn" data-edit-channel="${c.id}">Edit</button>
        ${custom ? html`<button class="btn danger" data-delete-custom="${c.ruleKey.slice(7)}" aria-label="Delete ${c.name}">Delete</button>` : ""}
        <button class="btn" data-hide="${c.ruleKey}" data-hidden="${c.hidden ? "1" : "0"}">${c.hidden ? "Show" : "Hide"}</button>
      </div></div>`;
  });
  return html`<h3>Channels</h3>
    <p class="lead">Channels build themselves from your library and keep their numbers when it changes. Hide the ones you don't want, or make your own.</p>
    ${lk?.pinSet && !lk.unlocked && lk.lockedChannels ? raw(pinRow("Some channels are locked, so changing channels needs the parental PIN.")) : ""}
    <div class="row-actions" style="margin-bottom:1em"><button class="btn primary" data-new-channel>+ New channel</button>
      <button class="btn" data-exclusions>Keep shows or genres off every channel…</button></div>
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
    const badge = r.manual === "watched" ? html`<span class="badge ok" title="You marked this">✓ Marked watched</span>`
      : r.manual === "unwatched" ? html`<span class="badge" title="You marked this">Marked unwatched</span>`
      : r.watched ? html`<span class="badge ok">✓ Watched</span>` : html`<span class="badge">Seen ${pct}%</span>`;
    const markBtn = r.manual
      ? html`<button class="linkish" data-mark="clear" data-item="${r.itemId}">Undo my mark</button>`
      : r.watched
        ? html`<button class="linkish" data-mark="unwatched" data-item="${r.itemId}">Mark unwatched</button>`
        : html`<button class="linkish" data-mark="watched" data-item="${r.itemId}">Mark watched</button>`;
    return html`<div class="li" style="grid-template-columns:1fr auto">
      <div><div class="t">${r.title}</div><div class="d">${ago(r.at)} · you saw ${pct}% of it</div>
        <div class="progressbar" style="max-width:16em"><i style="width:${pct}%"></i></div>
        <div class="x-acts">${markBtn}<button class="linkish" data-forget="${r.itemId}">Remove from history</button></div></div>
      ${badge}</div>`;
  });
  return html`<h3>Viewing history</h3>
    <p class="lead">A program counts as watched once you've actually seen ${Math.round(h.threshold * 100)}% of it. Catching the last few minutes doesn't count, and station breaks never do. You can mark a program by hand; DebridTV shows that it was your mark. History stays on this PC.</p>
    <div class="list">${rows.length ? raw(rows.join("")) : raw('<p class="muted">Nothing yet. Start watching!</p>')}</div>
    ${h.total > rows.length ? html`<p class="muted">Showing the latest ${rows.length} of ${h.total}. Export to see everything.</p>` : ""}
    <div class="row-actions" style="margin-top:1em">
      <a class="btn" href="/api/history/export" download>Export history</a>
      ${rows.length ? raw('<button class="btn danger" data-clear-history>Clear history</button>') : ""}
    </div>`;
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
      ${m.cache ? html`<div class="stat" title="The first 1 MB and last 256 KB of files you've tuned, kept on this PC so channel changes start sooner. Never fetched ahead.">
        <b>${fmtBytes(m.bytes.cached ?? 0)}</b><span>served from cache (${fmtBytes(m.cache.bytes)} in ${m.cache.files} files)</span></div>` : ""}
      <div class="stat"><b>${m.tunes}</b><span>channel changes</span></div>
      <div class="stat"><b>${m.streamsOpened}</b><span>streams opened</span></div>
      <div class="stat"><b>${m.streamsCancelled}</b><span>cancelled</span></div>
      <div class="stat"><b>${m.activeStreams}</b><span>open now</span></div>
      <div class="stat"><b>${m.peakStreams}</b><span>most at once</span></div>
    </div>
    ${m.apiPeak?.length ? html`<h3>Busiest minute</h3>
      <p class="lead">Your providers publish request limits. Other apps using the same key count too, so DebridTV should stay far below them.</p>
      <div class="list">${m.apiPeak.map((p) => html`<div class="li" style="grid-template-columns:1fr auto">
        <div><div class="t">${p.bucket === "realdebrid" ? "Real-Debrid" : p.bucket}</div><div class="d">limit ${p.limit} a minute, ${p.scope}</div>
          <div class="progressbar" style="max-width:16em"><i style="width:${Math.min(100, (p.peak / p.limit) * 100).toFixed(1)}%"></i></div></div>
        <b>${p.peak} / ${p.limit}</b></div>`)}</div>` : ""}
    ${api_.length ? html`<h3>Calls by type</h3><div class="list">${raw(api_.map(([k, v]) => html`<div class="li" style="grid-template-columns:1fr auto"><span>${k}</span><b>${v}</b></div>`).join(""))}</div>` : ""}
    <h3>Recent events</h3>
    <div class="events">${m.events.length ? raw(m.events.slice().reverse().map((e) => html`<div class="${e.kind}">${new Date(e.at).toLocaleTimeString()} · ${e.kind} · ${e.detail}</div>`).join("")) : raw("<div>No provider traffic yet.</div>")}</div>`;
}

// ------------------------------------------------------------------ look & feel

async function look() {
  const sw = (k, label, desc) => html`<div class="opt"><div><div class="ol">${label}</div><div class="od">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-pref="${k}" aria-label="${label}" ${pref(k) ? "checked" : ""}><i></i></label></div>`;
  // theme.js (B) lists built-in and custom themes and owns the editor; fall back to the built-ins.
  const themeMod = await import("./theme.js").catch(() => null);
  const themes = themeMod?.themeOptions?.().map((o) => [o.value, o.label]) ?? [["midnight", "Midnight"], ["cable92", "Cable '92"], ["daylight", "Daylight"]];
  return html`<h3>Look &amp; feel</h3>
    <div class="opt"><div><div class="ol">Theme</div><div class="od">Colors for the guide and menus.</div></div>
      <span style="display:flex;gap:.4em;flex-wrap:wrap">
      <select class="input" style="width:auto" data-pref-select="theme" aria-label="Theme">${raw(themes.map(([k, v]) => `<option value="${esc(k)}" ${pref("theme") === k ? "selected" : ""}>${esc(v)}</option>`).join(""))}</select>
      ${themeMod?.openThemeEditor ? html`<button class="btn" data-theme-edit>Customize…</button>` : ""}</span></div>
    <div class="opt"><div><div class="ol">TV mode</div><div class="od">Bigger text and buttons for a TV across the room, kept clear of the edges a TV can crop. Auto turns it on for TV browsers.</div></div>
      <select class="input" style="width:auto" data-pref-select="tv" aria-label="TV mode">${raw([["auto", "Auto"], ["on", "On"], ["off", "Off"]].map(([v, l]) => `<option value="${v}" ${v === (pref("tv") ?? "auto") ? "selected" : ""}>${l}</option>`).join(""))}</select></div>
    ${raw(sw("crt", "CRT screen", "Scanlines and a soft vignette, like an old set."))}
    ${raw(sw("static", "Static between channels", "Snow while the next channel tunes in."))}
    ${raw(sw("sound", "Tuner sounds", "A click and a hiss when you change channel."))}
    ${raw(sw("clock24", "24-hour clock", "Show 21:30 instead of 9:30 PM."))}
    ${raw(sw("calm", "Reduce motion", "Turn off animations."))}
    ${raw(await startupOpts())}
    ${raw(signOffOpt())}
    ${raw(bugOpts())}
    <div class="opt"><div><div class="ol">Volume</div></div><input type="range" min="0" max="1" step="0.05" value="${pref("volume")}" data-volume aria-label="Volume"></div>`;
}

body.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.pref) setPref(t.dataset.pref, t.checked);
  else if (t.dataset.prefSelect) {
    setPref(t.dataset.prefSelect, t.dataset.num ? Number(t.value) : t.value);
    if (t.dataset.prefSelect === "guideIdle") render();
  }
});

/** N-16: where the channel bug sits and how strong it is; the rating card at program start. */
function bugOpts() {
  const pos = pref("bugPos") ?? "br";
  const op = Number(pref("bugOpacity") ?? 1);
  const corners = [["br", "Bottom right"], ["bl", "Bottom left"], ["tr", "Top right"], ["tl", "Top left"]];
  const levels = [[1, "Solid"], [0.7, "70%"], [0.4, "40%"], [0.1, "Faint"]];
  return html`<div class="opt"><div><div class="ol">Channel bug</div><div class="od">The little channel logo in the corner of the picture.</div></div>
      <span style="display:flex;gap:.4em;flex-wrap:wrap">
      <select class="input" style="width:auto" data-pref-select="bugPos" aria-label="Bug corner">${raw(corners.map(([v, l]) => `<option value="${v}" ${v === pos ? "selected" : ""}>${l}</option>`).join(""))}</select>
      <select class="input" style="width:auto" data-pref-select="bugOpacity" data-num="1" aria-label="Bug opacity">${raw(levels.map(([v, l]) => `<option value="${v}" ${Math.abs(v - op) < 0.01 ? "selected" : ""}>${l}</option>`).join(""))}</select></span></div>
    <div class="opt"><div><div class="ol">TV set</div><div class="od">Frame the picture in an old set. The wood console's dial turns to the channel. Not on phones.</div></div>
      <select class="input" style="width:auto" data-pref-select="bezel" aria-label="TV set">${raw([["off", "None"], ["classic", "Classic"], ["wood", "Wood console"]].map(([v, l]) => `<option value="${v}" ${v === (pref("bezel") ?? "off") ? "selected" : ""}>${l}</option>`).join(""))}</select></div>
    <div class="opt"><div><div class="ol">Rating card</div><div class="od">Show "Rated PG-13" and the like for a few seconds when a program starts.</div></div>
      <label class="switch"><input type="checkbox" data-pref="ratingCard" aria-label="Rating card" ${pref("ratingCard") !== false ? "checked" : ""}><i></i></label></div>`;
}

/** N-17b: after this long with no key, tap or click, the set asks if you're still watching, then signs off. */
function signOffOpt() {
  const cur = Number(pref("signOffHours") ?? 4);
  const opts = [[0, "Never"], [2, "2 hours"], [3, "3 hours"], [4, "4 hours"], [6, "6 hours"], [8, "8 hours"]];
  return html`<div class="opt"><div><div class="ol">Sign off after</div><div class="od">With nobody pressing anything, ask "Still watching?" and then stop playing, so a sleeping viewer doesn't stream all night.</div></div>
    <select class="input" style="width:auto" data-pref-select="signOffHours" data-num="1" aria-label="Sign off after">${raw(opts.map(([v, l]) => `<option value="${v}" ${v === cur ? "selected" : ""}>${l}</option>`).join(""))}</select></div>`;
}

const IDLE_FALLBACK = { stay: "Stay open", close: "Close the guide", tune: "Tune to the highlighted channel" };

async function startupOpts() {
  const [{ channels }, guide] = await Promise.all([api.get("/api/bootstrap"), import("./guide.js").catch(() => ({}))]);
  const idle = guide.IDLE_ACTIONS ?? IDLE_FALLBACK;
  const label = (v) => (typeof v === "string" ? v : v?.label ?? "");
  const opt = (v, text, cur) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(text)}</option>`;
  const start = pref("startup") ?? "last";
  const idleNow = pref("guideIdle") ?? "stay";
  const mins = pref("guideIdleMin") ?? 2;
  return html`<div class="opt"><div><div class="ol">Start on</div><div class="od">What the TV shows when you open it.</div></div>
      <select class="input" style="width:auto;max-width:14em" data-pref-select="startup" aria-label="Start on">${raw(
        [opt("last", "Last channel", start), opt("guide", "The guide", start),
          ...channels.map((c) => opt(`ch:${c.id}`, `Channel ${c.number} · ${c.name}`, start))].join(""))}</select></div>
    <div class="opt"><div><div class="ol">When the guide sits idle</div><div class="od">If nobody touches the guide for a while.</div></div>
      <select class="input" style="width:auto" data-pref-select="guideIdle" aria-label="When the guide sits idle">${raw(Object.entries(idle).map(([k, v]) => opt(k, label(v), idleNow)).join(""))}</select></div>
    ${idleNow !== "stay" ? html`<div class="opt"><div><div class="ol">Idle after</div></div>
      <select class="input" style="width:auto" data-pref-select="guideIdleMin" data-num="1" aria-label="Idle minutes">${raw([1, 2, 5, 10].map((n) => `<option value="${n}" ${n === mins ? "selected" : ""}>${n} minute${n === 1 ? "" : "s"}</option>`).join(""))}</select></div>` : ""}`;
}
body.addEventListener("input", (e) => {
  if ("volume" in e.target.dataset) {
    setPref("volume", Number(e.target.value));
    applyVolume();
  }
});

// ------------------------------------------------------------------ parental PIN (N-06b)

/** One PIN for the whole TV; the server keeps only a salted hash and forgets the unlock after four hours or a restart. */
const pinInput = (id, label, auto = "current-password") =>
  html`<input class="input pin-input" id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="${auto}" aria-label="${label}" placeholder="${label}" style="width:9em">`;

function pinRow(text) {
  return html`<div class="opt"><div><div class="ol">🔒 Locked</div><div class="od">${text}</div></div>
    <div class="inline">${raw(pinInput("pin-unlock", "PIN"))}<button class="btn primary" data-pin-unlock>Unlock</button></div></div>`;
}

async function pinBlock() {
  const lk = await api.get("/api/lock").catch(() => null);
  if (!lk) return "";
  const intro = html`<h3>Parental PIN</h3>
    <p class="lead">Lock channels so they need a PIN to watch. Locked channels stay in the guide, scrambled, and nothing is fetched for them until the PIN is entered. One PIN unlocks every locked channel for four hours, or until DebridTV restarts.</p>`;
  if (!lk.pinSet)
    return intro + html`<div class="opt"><div><div class="ol">Set a PIN</div><div class="od">4 to 8 digits. Then lock channels with 🔓 on the Channels tab or in a channel's editor.</div></div>
      <div class="inline">${raw(pinInput("pin-new", "New PIN", "new-password"))}${raw(pinInput("pin-new2", "Again", "new-password"))}<button class="btn primary" data-pin-set>Set PIN</button></div></div>`;
  const until = lk.untilMs ? new Date(lk.untilMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const state = lk.unlocked
    ? html`<div class="opt"><div><div class="ol">🔓 Unlocked until ${until}</div><div class="od">${lk.lockedChannels} locked channel${lk.lockedChannels === 1 ? "" : "s"} can be watched and changed until then.</div></div>
        <button class="btn" data-pin-lock>Lock now</button></div>`
    : raw(pinRow(`${lk.lockedChannels} channel${lk.lockedChannels === 1 ? " is" : "s are"} locked.${lk.retryAfterMs ? ` Too many wrong PINs: try again in ${Math.ceil(lk.retryAfterMs / 1000)} s.` : ""}`));
  return intro + state + html`<div class="opt"><div><div class="ol">Change or remove the PIN</div>
      <div class="od">Needs the current PIN. Removing it unlocks every channel. Forgot it? "Forget everything" below clears it, along with everything else.</div></div>
    <div class="inline">${raw(pinInput("pin-old", "Current PIN"))}${raw(pinInput("pin-change", "New PIN", "new-password"))}
      <button class="btn" data-pin-change>Change</button><button class="btn danger" data-pin-remove>Remove</button></div></div>`;
}

/** Tell the player (A) that locked channels may play now. */
const announceUnlock = (channelId = null) => window.dispatchEvent(new CustomEvent("debridtv:unlocked", { detail: { channelId } }));
const pinVal = (id) => document.getElementById(id)?.value.trim() ?? "";
const pinError = (err) => {
  const wait = err.data?.retryAfterMs;
  toast(wait ? `${err.data.error} (${Math.ceil(wait / 1000)} s)` : err.data?.error ?? err.message, 5000);
};

// ------------------------------------------------------------------ privacy

/** N-27c: daily settings backups in the data folder. */
function backupsBlock(bk) {
  const keeps = [[0, "Off"], [7, "Keep 7 days"], [14, "Keep 14 days"], [30, "Keep 30 days"]];
  const rows = bk.backups.slice(0, 5).map((x) => html`<div class="li" style="grid-template-columns:1fr auto">
    <div><div class="t">${new Date(x.at).toLocaleString()}</div><div class="d">${x.name} · ${fmtBytes(x.bytes)}</div></div>
    <button class="btn" data-restore-backup="${x.name}">Restore</button></div>`);
  return html`<div class="opt" style="margin-top:1em"><div><div class="ol">Daily settings backup</div>
      <div class="od">Once a day your channels, numbers and choices are saved in the data folder (never keys). Restoring merges them back in.</div></div>
    <select class="input" style="width:auto" data-backup-keep aria-label="Backups to keep">${raw(keeps.map(([v, l]) => `<option value="${v}" ${v === bk.keep ? "selected" : ""}>${l}</option>`).join(""))}</select></div>
    ${rows.length ? html`<div class="list">${rows}</div>` : html`<p class="muted">No backups yet.</p>`}
    <div class="row-actions"><button class="btn" data-backup-now>Back up now</button></div>`;
}

async function privacy() {
  const [b, bk] = await Promise.all([api.get("/api/bootstrap"), api.get("/api/backups").catch(() => null)]);
  const gate = (on, title, desc) => html`<div class="gate"><span class="lock">${on ? "🔓" : "🔒"}</span><div><b>${title} · ${on ? "on" : "off"}</b><span>${desc}</span></div></div>`;
  return html`<h3>Privacy &amp; permissions</h3>
    <p class="lead">DebridTV runs on this PC and listens only to this PC (127.0.0.1). Nothing is shared unless you turn it on, and each of these needs its own separate yes.</p>
    ${raw(gate(b.gates.sharing, "Sharing", "Letting other people or devices watch your channels. Not built yet, and off until you say so."))}
    ${raw(gate(b.gates.cloudRelay, "Cloud relay", "Streaming through a server instead of your own PC. Off: Real-Debrid treats server traffic differently, so this needs your explicit choice."))}
    ${raw(gate(b.gates.tunerExport, "Tuner export", "Showing your channels to Plex, Jellyfin or other TV apps as a tuner. Off until you say so."))}
    ${raw(await pinBlock())}
    <h3>What leaves this PC</h3>
    <p class="lead">Only requests to the providers you connected: your account status and library list when you connect or refresh, one link request per program you watch (reused for an hour), the few KB a scan reads, and the video you actually watch. The Meters tab counts all of it.</p>
    <h3>Your data</h3>
    <p class="lead">Everything lives in one folder on this PC. Exports never include your API keys.</p>
    <div class="row-actions">
      <a class="btn" href="/api/export" download>Export settings</a>
      <a class="btn" href="/api/export?only=lineup" download title="Numbers, names, custom channels and per-channel choices; no ratings or folders">Export channels only</a>
      <button class="btn" data-import-settings>Import settings…</button>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <a class="btn" href="/api/history/export" download>Export history</a>
    </div>
    ${bk ? raw(backupsBlock(bk)) : ""}
    <div class="row-actions" style="margin-top:1.2em">
      <button class="btn danger" data-forget-all>Forget everything…</button>
      <span class="muted">Deletes keys, library facts, history and channels from this PC. Your provider accounts aren't touched.</span>
    </div>`;
}

// Enter in a PIN field presses its button.
body.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.classList?.contains("pin-input")) return;
  e.preventDefault();
  e.target.closest(".inline")?.querySelector("button")?.click();
});

body.addEventListener("change", async (e) => {
  if (e.target.id !== "import-file") return;
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await api.post("/api/import", data);
    toast(`Imported ${r.custom} custom channel${r.custom === 1 ? "" : "s"} and ${r.hidden} hidden channel${r.hidden === 1 ? "" : "s"}.`, 5000);
    onChange();
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file isn't JSON." : err.message, 5000);
  }
  e.target.value = "";
});

// ------------------------------------------------------------------ library

const STATUS = {
  "": ["All", ""],
  ready: ["Ready to air", "ok"],
  "needs-scan": ["Needs a scan", ""],
  "not-ready": ["Not ready at provider", "warn"],
  refused: ["Refused by provider", "bad"],
  account: ["Account problem", "bad"],
  problem: ["Problems", "warn"],
  gone: ["Removed", ""],
  excluded: ["Kept off air", ""],
  other: ["Not a show or movie", ""],
};
let lib = { view: "files", status: "", provider: "", q: "", limit: 50 };
let libTimer = 0;

async function library() {
  const sources = await api.get("/api/sources");
  const provs = [["", "All sources"], ...["torbox", "realdebrid", "local"].filter((p) => sources[p].connected).map((p) => [p, p === "local" ? "This PC" : PROVIDERS[p].name])];
  const views = html`<div class="x-chips" role="group" aria-label="Library view">
    <button class="x-chip" data-lib-view="files" aria-pressed="${String(lib.view !== "ratings")}">Files</button>
    <button class="x-chip" data-lib-view="ratings" aria-pressed="${String(lib.view === "ratings")}">Age ratings</button></div>`;
  if (lib.view === "ratings") {
    setTimeout(ratingsList);
    return html`<h3>Library</h3>${views}
      <p class="lead">Kid channels and restricted hours only air programs with a known rating. Ratings come from .nfo files in your own folders; files from Real-Debrid and TorBox carry none, so rate them here. Nothing is looked up online.</p>
      <div class="x-libbar" style="grid-template-columns:1fr">
        <input class="input" id="lib-q" type="search" placeholder="Search shows and films" value="${lib.q}" aria-label="Search">
      </div>
      <div id="lib-results"><p class="muted">Loading…</p></div>`;
  }
  setTimeout(libList);
  return html`<h3>Library</h3>${views}
    <p class="lead">Every file DebridTV knows about, and exactly where it stands. Being in your account isn't the same as being playable, so each step is shown separately.</p>
    <div class="x-libbar">
      <input class="input" id="lib-q" type="search" placeholder="Search titles or file names" value="${lib.q}" aria-label="Search">
      <select class="input" id="lib-prov" aria-label="Source">${raw(provs.map(([k, v]) => `<option value="${k}" ${k === lib.provider ? "selected" : ""}>${esc(v)}</option>`).join(""))}</select>
    </div>
    <div id="lib-results"><p class="muted">Loading…</p></div>`;
}

const RATING_HELP = { G: "All ages", PG: "Some material may not suit young children", "PG-13": "Teens and up", R: "Adults", "NC-17": "Adults only" };

async function ratingsList() {
  const box = document.getElementById("lib-results");
  if (!box) return;
  const r = await api.get("/api/ratings");
  const q = lib.q.toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const unrated = [...r.shows, ...r.movies].filter((x) => !x.rating).length;
  const row = (x, target, label, sub) => {
    const from = x.from === "you" ? "Set by you" : x.from === "nfo" ? `From the .nfo (${x.nfo})` : x.from === "demo" ? "Demo rating" : "No rating: kid channels and restricted hours skip it";
    return html`<div class="li x-file" style="grid-template-columns:1fr auto">
      <div><div class="t">${label}</div><div class="d">${sub}</div><div class="d x-why ${x.rating ? "" : "warn"}">${from}</div></div>
      <select class="input" style="width:auto" aria-label="Rating for ${label}" data-rate="${target}">
        <option value="">${x.rating && x.from !== "you" ? `Use ${x.from === "nfo" ? ".nfo" : "default"} (${x.rating})` : "Not rated"}</option>
        ${raw(r.scale.map((k) => `<option value="${k}" ${x.from === "you" && x.rating === k ? "selected" : ""} title="${esc(RATING_HELP[k] ?? "")}">${k}</option>`).join(""))}
      </select></div>`;
  };
  const shows = r.shows.filter((s) => match(s.name)).map((s) => row(s, `show:${s.key}`, s.name, `${s.episodes} episode${s.episodes === 1 ? "" : "s"}`));
  const movies = r.movies.filter((m) => match(m.title)).map((m) => row(m, `item:${m.id}`, m.title, "Film"));
  box.innerHTML = String(html`<p class="muted">${unrated ? `${unrated} title${unrated === 1 ? "" : "s"} without a rating.` : "Everything has a rating."} TV ratings count as their film equivalent (TV-Y to TV-G = G, TV-PG = PG, TV-14 = PG-13, TV-MA = R). Kid channels air G and PG.</p>
    ${shows.length ? html`<h4>Shows</h4><div class="list">${shows}</div>` : ""}
    ${movies.length ? html`<h4>Films</h4><div class="list">${movies}</div>` : ""}
    ${shows.length || movies.length ? "" : html`<p class="muted">${q ? "Nothing matches." : "No shows or films yet."}</p>`}`);
}

async function libList() {
  if (lib.view === "ratings") return ratingsList();
  const box = document.getElementById("lib-results");
  if (!box) return;
  const q = new URLSearchParams({ status: lib.status, provider: lib.provider, q: lib.q, limit: String(lib.limit) });
  const r = await api.get(`/api/library/files?${q}`);
  const all = Object.values(r.counts).reduce((a, b) => a + b, 0);
  const chips = Object.entries(STATUS)
    .filter(([k]) => k === "" || r.counts[k] || k === lib.status)
    .map(([k, [label, cls]]) => html`<button class="x-chip ${cls}" data-lib-filter="${k}" aria-pressed="${String(lib.status === k)}">${label} <b>${k ? r.counts[k] ?? 0 : all}</b></button>`);
  const rows = r.files.map((f) => {
    const [label, cls] = STATUS[f.status] ?? [f.status, ""];
    const facts = [
      f.provider === "local" ? "This PC" : PROVIDERS[f.provider]?.name,
      f.durationMs ? (f.durationMs < 60000 ? `${Math.round(f.durationMs / 1000)} s` : fmtDur(f.durationMs)) : null,
      f.video ? `${f.container ?? ""} ${f.video}${f.audio?.length ? "/" + f.audio.join("+") : ""}`.trim() : null,
      f.bytes ? fmtBytes(f.bytes) : null,
      f.playableAt ? `played OK ${ago(f.playableAt)}` : null,
      f.watched ? "watched" : f.seenMs ? `seen ${fmtDur(f.seenMs)}` : null,
    ].filter(Boolean).join(" · ");
    const canCheck = ["ready", "needs-scan", "problem"].includes(f.status) && f.provider !== "local";
    const pic = f.art?.thumb ?? f.art?.poster;
    return html`<div class="li x-file" style="grid-template-columns:${pic ? "auto " : ""}1fr auto">
      ${pic ? html`<img class="x-art" src="${pic}" alt="" loading="lazy" style="width:3.2em;height:4.6em;object-fit:cover;border-radius:6px;background:var(--line)" onerror="this.remove()">` : ""}
      <div><div class="t">${f.title}</div>
        <div class="d">${facts}</div>
        ${f.status === "ready" ? "" : html`<div class="d x-why ${cls}">${f.message}</div>`}
        <div class="d x-name" title="${f.name}">${f.name}</div>
        <div class="x-acts">
          ${canCheck ? html`<button class="linkish" data-check="${f.id}" title="Asks for one playback link">Check now</button>` : ""}
          ${["ready", "needs-scan", "problem", "account", "excluded"].includes(f.status) ? html`<button class="linkish" data-exclude="${f.id}" data-excluded="${f.excluded ? "1" : "0"}">${f.excluded ? "Put back on the air" : "Keep off the air"}</button>` : ""}
          ${f.kind !== "other" && f.status !== "not-ready" ? (f.watched ? html`<button class="linkish" data-mark="unwatched" data-item="${f.id}">Mark unwatched</button>` : html`<button class="linkish" data-mark="watched" data-item="${f.id}">Mark watched</button>`) : ""}
        </div></div>
      <span class="badge ${cls}">${label}</span></div>`;
  });
  box.innerHTML = String(html`<div class="x-chips">${chips}</div>
    <div class="list">${rows.length ? rows : html`<p class="muted">${all ? "Nothing matches." : "No files yet. Connect a source in Sources."}</p>`}</div>
    ${r.total > r.files.length ? html`<div class="row-actions"><button class="btn" data-lib-more>Show more (${r.total - r.files.length} left)</button></div>` : ""}
    <p class="muted" style="margin-top:1em">This list is built from what DebridTV already knows; opening it costs no provider requests. "Check now" asks for one playback link.</p>`);
}

body.addEventListener("input", (e) => {
  if (e.target.id === "lib-q") {
    clearTimeout(libTimer);
    libTimer = setTimeout(() => {
      lib = { ...lib, q: e.target.value.trim(), limit: 50 };
      libList();
    }, 200);
  }
});
body.addEventListener("change", async (e) => {
  if (e.target.dataset?.backupKeep !== undefined) {
    await api.post("/api/backups", { keep: Number(e.target.value) }).catch((err) => toast(err.message));
    return;
  }
  const rate = e.target.dataset?.rate;
  if (rate) {
    const [kind, id] = [rate.slice(0, rate.indexOf(":")), rate.slice(rate.indexOf(":") + 1)];
    try {
      await api.post("/api/ratings", { [kind === "show" ? "showKey" : "itemId"]: id, rating: e.target.value || null });
      toast(e.target.value ? `Rated ${e.target.value}. Channels change after what's airing now ends.` : "Rating cleared.");
      onChange();
    } catch (err) {
      toast(err.message, 5000);
    }
    return void ratingsList();
  }
  if (e.target.id === "lib-prov") {
    lib = { ...lib, provider: e.target.value, limit: 50 };
    libList();
  }
});
