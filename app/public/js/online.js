// Online posters and descriptions (TMDB) on the Sources tab. Off until the viewer
// pastes their own free TMDB key; only show and film titles and years are sent.
// TMDB's terms ask for their credit wherever their data shows; it sits here.

import { api } from "./api.js";
import { html, raw, fmtBytes, toast } from "./util.js";

const body = document.getElementById("panel-body");
let refresh = () => {};

/** The settings card. `changed` re-renders the tab after a save. */
export async function onlineCard(changed) {
  refresh = changed ?? refresh;
  let s;
  try {
    s = await api.get("/api/metadata");
  } catch {
    return "";
  }
  // TMDB's API terms: their logo with this notice, less prominent than DebridTV's own mark. Bundled, never fetched.
  const credit = html`<div class="muted tmdb-credit" style="margin-top:.8em;display:flex;align-items:center;gap:.7em;flex-wrap:wrap">
    <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer" style="display:inline-flex"><img src="/img/tmdb.svg" alt="TMDB" width="84" height="11" style="height:.8em;width:auto"></a>
    <span>${s.attribution}</span></div>`;
  const head = (badge) => html`<div class="src-head"><div class="src-name"><span class="src-dot ${s.state === "off" || s.state === "rejected" ? "" : "on"}"></span>Posters and descriptions</div>${raw(badge)}</div>`;
  if (!s.keySet)
    return html`<h3>Online artwork</h3>
    <div class="src">
      ${head('<span class="badge">Off</span>')}
      <p class="muted">Your own folder art and .nfo files always come first. For everything else, DebridTV can ask TMDB for a poster, a backdrop, a show logo and the descriptions, once per show or film, and keep them on this PC.</p>
      <div class="field"><label for="key-tmdb">TMDB API key (free, from themoviedb.org → Settings → API)</label>
        <div class="inline"><input class="input" id="key-tmdb" type="password" autocomplete="off" spellcheck="false" placeholder="API key or read access token">
        <button class="btn primary" data-tmdb-save>Turn on</button></div></div>
      <div class="muted">Sends only a show's or film's title, its year and season numbers. Never file names, folders, provider links or what you watch. Channels locked with the PIN are left out.</div>
      ${credit}
    </div>`;
  return html`<h3>Online artwork</h3>
    <div class="src">
      ${head(s.state === "rejected" ? '<span class="badge warn">Key refused</span>' : '<span class="badge ok">On · TMDB</span>')}
      <div class="muted">${s.message}${s.state === "working" && s.waiting ? html` ${s.waiting} to go.` : ""}</div>
      <div class="stats"><div class="stat"><b>${s.titles}</b><span>titles found</span></div><div class="stat"><b>${s.withPictures}</b><span>with pictures</span></div>
        <div class="stat"><b>${s.requests}</b><span>TMDB requests</span></div><div class="stat"><b>${fmtBytes(s.bytes)}</b><span>downloaded</span></div></div>
      ${s.lastError ? html`<div class="muted" style="color:var(--warn)">Last problem: ${s.lastError}</div>` : ""}
      ${s.state === "rejected" ? html`<div class="field"><label for="key-tmdb">New TMDB key</label><div class="inline"><input class="input" id="key-tmdb" type="password" autocomplete="off" spellcheck="false"><button class="btn primary" data-tmdb-save>Save</button></div></div>` : ""}
      <div class="row-actions"><button class="btn danger" data-tmdb-off title="Deletes the key. Pictures already fetched stay on this PC but are hidden.">Turn off &amp; delete key</button></div>
      ${credit}
    </div>`;
}

/** One line for the Privacy tab's "What leaves this PC". */
export async function onlinePrivacyLine() {
  try {
    const s = await api.get("/api/metadata");
    return s.keySet
      ? html`<p class="lead">With online artwork on: show and film titles, years and season numbers go to TMDB, once per title, for posters and descriptions. ${s.requests} requests so far.</p>`
      : "";
  } catch {
    return "";
  }
}

body?.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-tmdb-save], button[data-tmdb-off]");
  if (!b) return;
  e.stopPropagation();
  try {
    if ("tmdbSave" in b.dataset) {
      const key = document.getElementById("key-tmdb")?.value.trim();
      if (!key) return toast("Paste your TMDB key first.");
      b.disabled = true;
      b.textContent = "Checking…";
      await api.post("/api/metadata", { key });
      toast("Online artwork is on. Posters appear as each title is found.", 4500);
    } else {
      if (!confirm("Turn off online artwork? The TMDB key is deleted from this PC.")) return;
      await api.post("/api/metadata", { key: null });
      toast("Online artwork is off. Key deleted.");
    }
  } catch (err) {
    toast(err.message, 6000);
  }
  refresh();
});
// Enter in the key field presses Turn on.
body?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "key-tmdb") {
    e.preventDefault();
    body.querySelector("[data-tmdb-save]")?.click();
  }
});
