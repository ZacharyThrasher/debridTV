// Content groups (parity N-07): named sets of shows and films with their own running
// order and a guide description. A group is a building block: a time slot can air it,
// a custom channel can include it, or it can be a channel of its own.
//
// Data contract (workstream C):
//   GET  /api/groups -> { groups: [{ id, name, description, entries: [{kind:"show",key}|{kind:"movie",id}],
//          ordering, channel, ruleKey, programs, hours, usedBy: [{ id, number, name, how: "own"|"custom"|"slot" }] }],
//          options: { shows: [{ key, name, episodes }], movies: [{ id, title, year? }] } }
//   POST /api/groups { id?, name, description, entries, ordering, channel } -> { ok, group }
//   POST /api/groups/delete { id }
// Both writes are behind the parental PIN while a locked channel is guarded (withPin).

import { api } from "./api.js";
import { html, raw, toast } from "./util.js";
import { withPin } from "./lock.js";
import { keepFocus } from "./spatial.js";

const root = document.createElement("div");
root.className = "ced grp";
root.hidden = true;
root.setAttribute("role", "dialog");
root.setAttribute("aria-modal", "true");
root.setAttribute("aria-label", "Content groups");
document.body.append(root);

export const ORDER_LABELS = {
  cyclic: "In the order below, then repeat",
  shuffle: "Fully shuffled",
  "block-cyclic": "A few episodes at a time, in order",
  "block-shuffle": "A few episodes at a time, shuffled",
  "round-robin-cyclic": "One episode of each, taking turns",
  "round-robin-shuffle": "Taking turns, episodes shuffled",
  "marathon-cyclic": "Long runs of one show, in order",
  "marathon-shuffle": "Long runs of one show, shuffled",
};
const HOW = { own: "its own channel", custom: "in this channel's lineup", slot: "in a time slot" };

let data = null; // GET /api/groups
let draft = null; // the group being edited, or null for the list
let find = ""; // the add-programs search
let lastFocus = null;
let onChange = null;

export const groupsOpen = () => !root.hidden;

/** Opens the list, or straight into one group ("new" for a new one). */
export async function openGroups({ edit = null, onChanged = null } = {}) {
  lastFocus = document.activeElement;
  onChange = onChanged;
  root.hidden = false;
  document.body.classList.add("ced-open");
  root.innerHTML = html`<div class="ced-sheet"><div class="ced-body muted">Loading groups…</div></div>`.html;
  await load();
  draft = null;
  if (edit === "new") newGroup();
  else if (edit) editGroup(edit);
  render();
  root.querySelector("[data-first]")?.focus();
}

export function closeGroups() {
  root.hidden = true;
  document.body.classList.remove("ced-open");
  lastFocus?.focus?.();
}

async function load() {
  try {
    data = await api.get("/api/groups");
  } catch (e) {
    data = { groups: [], options: { shows: [], movies: [] }, error: e.status === 404 ? "This build has no content groups yet." : e.message };
  }
}

function newGroup() {
  draft = { id: null, name: "", description: "", entries: [], ordering: "cyclic", channel: false };
  find = "";
}
function editGroup(id) {
  const g = data.groups.find((x) => x.id === id);
  if (!g) return;
  draft = { id: g.id, name: g.name, description: g.description ?? "", entries: g.entries.map((e) => ({ ...e })), ordering: g.ordering, channel: !!g.channel };
  find = "";
}

// ------------------------------------------------------------------ render

const showName = (key) => data.options.shows.find((s) => s.key === key);
const movieOf = (id) => data.options.movies.find((m) => m.id === id);
const entryKey = (e) => (e.kind === "show" ? `s:${e.key}` : `m:${e.id}`);

function render() {
  keepFocus(root, () => {
    root.innerHTML = html`<div class="ced-sheet grp-sheet">
      <header class="ced-head">
        <span class="grp-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <div class="ced-title"><div class="k">${draft ? (draft.id ? "Edit group" : "New group") : "Library"}</div><div class="t">${draft ? draft.name || "Untitled group" : "Content groups"}</div></div>
        <button class="icon-btn" data-close aria-label="Close">✕</button>
      </header>
      <div class="ced-body">${draft ? editor() : list()}</div>
      <footer class="ced-foot">
        ${draft ? html`${draft.id ? html`<button class="btn danger" data-del>Delete group</button>` : ""}<span style="flex:1"></span>
          <button class="btn" data-back>Back</button><button class="btn primary" data-save>Save group</button>`
        : html`<span style="flex:1"></span><button class="btn" data-close>Done</button>`}
      </footer>
    </div>`.html;
  });
}

function list() {
  const gs = data.groups;
  return html`
    <p class="lead">A group is a set of shows and films that air together in an order you choose, with its own description in the guide. Put a group in a time slot, add it to a custom channel, or give it a channel of its own.</p>
    ${data.error ? html`<div class="ced-warn">${data.error}</div>` : ""}
    <div class="grp-list">${gs.length ? gs.map((g) => html`<div class="grp-row">
      <button class="grp-open" data-edit="${g.id}" ${g === gs[0] ? raw("data-first") : ""}>
        <b>${g.name}</b>
        <span>${g.description || html`<i class="muted">No description</i>`}</span>
        <small>${g.entries.length} ${g.entries.length === 1 ? "entry" : "entries"} · ${g.programs} programs · ${g.hours} hours · ${ORDER_LABELS[g.ordering] ?? g.ordering}</small>
      </button>
      <div class="grp-used">${g.usedBy.length ? g.usedBy.map((u) => html`<span class="grp-chip"><b>${u.number}</b>${u.name} <em>${HOW[u.how] ?? u.how}</em></span>`)
        : html`<span class="muted">Not on the air yet. Add it to a time slot or a channel.</span>`}</div>
    </div>`) : html`<div class="grp-empty">No groups yet. Try “Saturday Morning” with your cartoons, or “Spooky Season” for October.</div>`}</div>
    <button class="btn primary" data-new ${gs.length ? "" : raw("data-first")}>+ New group</button>`;
}

function editor() {
  const d = draft;
  const has = new Set(d.entries.map(entryKey));
  const q = find.trim().toLowerCase();
  const hit = (s) => !q || s.toLowerCase().includes(q);
  const shows = data.options.shows.filter((s) => !has.has(`s:${s.key}`) && hit(s.name)).slice(0, 24);
  const movies = data.options.movies.filter((m) => !has.has(`m:${m.id}`) && hit(m.title)).slice(0, 24);
  const label = (e) => {
    if (e.kind === "show") {
      const s = showName(e.key);
      return html`<b>${s?.name ?? e.key}</b><small>${s ? `Show · ${s.episodes} episodes` : "Not in the library now"}</small>`;
    }
    const m = movieOf(e.id);
    return html`<b>${m?.title ?? "Missing film"}</b><small>${m ? `Film${m.year ? ` · ${m.year}` : ""}` : "Not in the library now"}</small>`;
  };
  return html`
    <div class="field"><label for="grp-name">Name</label><input id="grp-name" class="input" data-g="name" value="${d.name}" maxlength="40" placeholder="Saturday Morning" data-first></div>
    <div class="field"><label for="grp-desc">Guide description</label><textarea id="grp-desc" class="input" data-g="description" maxlength="500" rows="2" placeholder="Cartoons and cereal, every Saturday until noon.">${d.description}</textarea></div>
    <div class="ced-row">
      <div class="field"><label for="grp-order">Running order</label><select id="grp-order" class="input" data-g="ordering">${Object.entries(ORDER_LABELS).map(([k, v]) => html`<option value="${k}" ${k === d.ordering ? "selected" : ""}>${v}</option>`)}</select></div>
      <div class="opt" style="border:0;align-self:end"><div><div class="ol">Its own channel</div><div class="od">Also air the group around the clock on a channel of its own.</div></div>
        <label class="switch"><input type="checkbox" data-g="channel" aria-label="Its own channel" ${d.channel ? "checked" : ""}><i></i></label></div>
    </div>
    <h4>In this group <small class="muted">${d.entries.length}</small></h4>
    ${d.ordering === "cyclic" && d.entries.length > 1 ? html`<p class="lead">They air top to bottom. Move them with ▲ ▼.</p>` : ""}
    <ol class="grp-entries">${d.entries.length ? d.entries.map((e, i) => html`<li class="grp-entry">
      <span class="grp-n">${i + 1}</span><span class="grp-what">${label(e)}</span>
      <button class="icon-btn" data-up="${i}" aria-label="Move up" ${i ? "" : "disabled"}>▲</button>
      <button class="icon-btn" data-down="${i}" aria-label="Move down" ${i < d.entries.length - 1 ? "" : "disabled"}>▼</button>
      <button class="icon-btn" data-rm="${i}" aria-label="Remove">✕</button></li>`) : html`<li class="muted">Nothing yet. Add shows and films below.</li>`}</ol>
    <h4>Add shows and films</h4>
    <input class="input" type="search" id="grp-find" placeholder="Find a show or film" value="${find}" aria-label="Find a show or film">
    <div class="grp-add">
      ${shows.map((s) => html`<button class="x-chip" data-add-show="${s.key}">＋ ${s.name} <small>${s.episodes} ep</small></button>`)}
      ${movies.map((m) => html`<button class="x-chip" data-add-movie="${m.id}">＋ ${m.title}${m.year ? html` <small>${m.year}</small>` : ""}</button>`)}
      ${shows.length + movies.length ? "" : html`<span class="muted">${q ? "Nothing else matches." : "Everything is already in the group."}</span>`}
    </div>`;
}

// ------------------------------------------------------------------ input

root.addEventListener("click", async (e) => {
  if (e.target === root) return closeGroups();
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.close !== undefined) return closeGroups();
  if (d.new !== undefined) newGroup();
  else if (d.edit) editGroup(d.edit);
  else if (d.back !== undefined) draft = null;
  else if (d.save !== undefined) return save();
  else if (d.del !== undefined) return remove();
  else if (d.up || d.down) {
    const i = Number(d.up ?? d.down);
    const j = d.up ? i - 1 : i + 1;
    const list = draft.entries;
    [list[i], list[j]] = [list[j], list[i]];
    render();
    root.querySelector(`[data-${d.up ? "up" : "down"}="${j}"]:not([disabled])`)?.focus();
    return;
  } else if (d.rm) draft.entries.splice(Number(d.rm), 1);
  else if (d.addShow) draft.entries.push({ kind: "show", key: d.addShow });
  else if (d.addMovie) draft.entries.push({ kind: "movie", id: d.addMovie });
  else return;
  render();
  if (d.new !== undefined || d.edit || d.back !== undefined) root.querySelector("[data-first]")?.focus();
});

root.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "grp-find") {
    find = t.value;
    return render();
  }
  const k = t.dataset.g;
  if (!k || !draft) return;
  draft[k] = t.type === "checkbox" ? t.checked : t.value;
  if (k === "name") root.querySelector(".ced-title .t").textContent = t.value || "Untitled group";
  if (k === "ordering") render();
});

async function save() {
  if (!draft.name.trim()) return toast("Give the group a name.");
  if (!draft.entries.length) return toast("Add at least one show or film.");
  try {
    const body = { ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), description: draft.description.trim(), entries: draft.entries, ordering: draft.ordering, channel: draft.channel };
    await withPin(() => api.post("/api/groups", body), "Changing a group changes what airs.");
  } catch (e) {
    if (!e.cancelled) toast(`Couldn't save the group: ${e.message}`);
    return;
  }
  toast(draft.channel ? `Saved. “${draft.name.trim()}” has its own channel now.` : `Saved “${draft.name.trim()}”.`);
  await load();
  draft = null;
  render();
  onChange?.();
}

async function remove() {
  const g = data.groups.find((x) => x.id === draft.id);
  const used = g?.usedBy?.length ? ` It's used by ${g.usedBy.length} channel${g.usedBy.length === 1 ? "" : "s"}; those slots go back to the usual lineup.` : "";
  if (!confirm(`Delete “${draft.name}”?${used}`)) return;
  try {
    await withPin(() => api.post("/api/groups/delete", { id: draft.id }), "Deleting a group changes what airs.");
  } catch (e) {
    if (!e.cancelled) toast(`Couldn't delete the group: ${e.message}`);
    return;
  }
  await load();
  draft = null;
  render();
  onChange?.();
}

// Escape: back from a group to the list, then close. Runs after spatial.js (Back -> Escape).
addEventListener("keydown", (e) => {
  if (root.hidden || e.key !== "Escape") return;
  if (e.target?.matches?.("input, textarea, select") && e.target.value && e.target.type === "search") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (draft) {
    draft = null;
    render();
    root.querySelector("[data-first]")?.focus();
  } else closeGroups();
}, true);
