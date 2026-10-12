// "Fix this show": when DebridTV files a show under the wrong name, or joins two
// shows that aren't the same (or misses two that are), the viewer fixes it here.
// Opened from On Demand's show page and from a show channel's editor. Choices are
// kept on this PC (/api/shows/identity) and apply everywhere: On Demand, channels,
// the guide.
//
// Markup stays plain and reuses the sheet styles; the design tokens from the
// visual redesign are used where present, with today's colors as fallbacks.

import { api } from "./api.js";
import { html, toast } from "./util.js";

const WHY = {
  "same name": "same name",
  spelling: "spelling",
  "known title": "other title",
  "database id": "TMDB match",
  "you merged": "you joined",
  "you split": "you separated",
};

/**
 * Open the sheet over `host` (an element; the sheet is appended to it).
 * `onChange(key)` runs after a change with the show's key now, so the caller can reload.
 */
export async function openShowFix(key, { host = document.body, onChange = () => {} } = {}) {
  let group;
  let all = [];
  try {
    [group, { shows: all }] = await Promise.all([api.get(`/api/shows/identity?key=${encodeURIComponent(key)}`), api.get("/api/shows/identity")]);
  } catch (e) {
    toast(e.status === 404 ? "This build can't fix shows yet." : `Couldn't load that show: ${e.message}`);
    return;
  }
  const back = document.activeElement;
  const el = document.createElement("div");
  el.className = "od-sheet showfix";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", `Fix ${group.name}`);
  host.append(el);

  const close = () => {
    el.remove();
    back?.focus?.({ preventScroll: true });
  };
  const draw = () => {
    const others = all.filter((s) => s.key !== group.key);
    const several = group.members.length > 1;
    el.innerHTML = html`<div class="od-sheet-box showfix-box">
      <div class="od-kicker">Fix this show</div>
      <div class="od-t">${group.name}</div>
      <div class="showfix-row">
        <label for="sf-name">Name</label>
        <input id="sf-name" class="input" value="${group.name}" maxlength="80" data-first>
        <button class="btn" data-rename>Save name</button>
      </div>
      <h4>${several ? "Filed together from these names" : "Filed from this name"}</h4>
      <ul class="showfix-list">${group.members.map((m) => html`<li>
        <span class="showfix-n"><b>${m.name}</b><span>${m.episodes} episode${m.episodes === 1 ? "" : "s"}${m.season ? ` · Season ${m.season}` : ""}${m.arc ? ` (${m.arc})` : ""}${m.why ? ` · ${WHY[m.why] ?? m.why}` : ""}</span></span>
        ${several ? html`<button class="btn" data-split="${m.unit}" title="This name is a different show">Not this show</button>` : ""}
      </li>`)}</ul>
      ${others.length ? html`<div class="showfix-row">
        <label for="sf-into">Same show as</label>
        <select id="sf-into" class="input"><option value="">Pick a show…</option>${others.map((s) => html`<option value="${s.key}">${s.name} (${s.episodes})</option>`)}</select>
        <button class="btn" data-merge>Join them</button>
      </div>` : ""}
      <div class="od-sheet-acts">
        <button class="btn" data-reset title="Forget what you changed for this show">Undo my changes</button>
        <span style="flex:1"></span>
        <button class="btn primary" data-done>Done</button>
      </div>
    </div>`.html;
  };
  const apply = async (path, body, said) => {
    try {
      group = await api.post(`/api/shows/identity/${path}`, body);
      all = (await api.get("/api/shows/identity")).shows;
      toast(said);
      draw();
      onChange(group.key);
    } catch (e) {
      toast(e.data?.pinRequired || e.status === 403 ? "Enter the parental PIN first." : `Couldn't change that: ${e.message}`);
    }
  };

  draw();
  el.querySelector("[data-first]")?.focus({ focusVisible: true });
  el.addEventListener("click", (e) => {
    e.stopPropagation(); // the editor or On Demand behind must not act on these clicks
    if (e.target === el) return close();
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-done]")) return close();
    if (b.matches("[data-rename]")) return apply("rename", { key: group.key, name: el.querySelector("#sf-name").value.trim() || null }, "Name saved");
    if (b.dataset.split) return apply("split", { unit: b.dataset.split }, "Separated: it's its own show now");
    if (b.matches("[data-merge]")) {
      const into = el.querySelector("#sf-into").value;
      if (!into) return void toast("Pick the show it belongs with first.");
      return apply("merge", { key: group.key, into }, "Joined into one show");
    }
    if (b.matches("[data-reset]")) return apply("reset", { key: group.key }, "Back to the automatic grouping");
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  });
}
