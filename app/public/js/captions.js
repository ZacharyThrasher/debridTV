// The subtitles menu: one place to turn subtitles on or off, pick the language or
// audio track, and set how captions look. Opened from the CC button on the dock
// (mouse and touch), the guide's toolbar (a remote: Up from the top row), or the
// C key. It sits at the side, so the picture and its captions stay in view while
// the style changes. Choices are prefs, so the next program and channel follow them.

import { html, raw, setPref } from "./util.js";
import { trackChoices, pickSubtitle, pickAudio } from "./player.js";
import { trackLabel, isText, CAPTION_STYLE, capPref, captionCss } from "./tracks.js";
import { keepFocus } from "./spatial.js";

const sheet = document.createElement("aside");
sheet.className = "cc-sheet";
sheet.id = "captions";
sheet.hidden = true;
sheet.setAttribute("role", "dialog");
sheet.setAttribute("aria-modal", "true");
sheet.setAttribute("aria-label", "Subtitles");
document.body.append(sheet);

let opener = null;
let drawn = 0;

export const captionsOpen = () => !sheet.hidden;

export async function openCaptions() {
  if (!sheet.hidden) return;
  opener = document.activeElement;
  sheet.hidden = false;
  document.body.classList.add("captions-open");
  await draw();
  if (sheet.hidden) return;
  // The current subtitle choice takes the remote's focus first.
  const first = sheet.querySelector('[data-sub][aria-checked="true"]') ?? sheet.querySelector("button");
  first?.focus({ preventScroll: true, focusVisible: document.documentElement.classList.contains("remote") });
}

export function closeCaptions() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  document.body.classList.remove("captions-open");
  if (opener?.isConnected && opener !== document.body) opener.focus?.({ preventScroll: true });
  opener = null;
}

const radio = (attrs, on, body) =>
  html`<button class="cc-opt" role="menuitemradio" aria-checked="${on ? "true" : "false"}" ${raw(attrs)}><i aria-hidden="true"></i><span>${body}</span></button>`;

async function draw() {
  const n = ++drawn;
  const c = await trackChoices().catch(() => ({ why: "Couldn't read this program's tracks." }));
  if (n !== drawn || sheet.hidden) return;
  keepFocus(sheet, () => (sheet.innerHTML = render(c).html));
}

function render(c) {
  let subs;
  if (c.why) subs = html`<p class="cc-note">${c.why}</p>`;
  else if (!c.subs.length) subs = html`${raw(radio("data-sub=\"off\"", true, "Off"))}<p class="cc-note">This program has no subtitles.</p>`;
  else if (!c.ffmpeg) subs = html`<p class="cc-note">This program has subtitles, but showing them needs compatibility mode. Installing ffmpeg on the PC turns it on.</p>`;
  else
    subs = html`${raw(radio('data-sub="off"', c.subNow == null, "Off"))}${raw(
      c.subs.map((t) => radio(`data-sub="${t.index}"`, c.subNow === t.index, html`${trackLabel(t)}${isText(t) ? "" : html`<small>Drawn into the picture</small>`}`).html).join(""))}`;
  const audio = !c.why && c.ffmpeg && c.audio.length > 1
    ? html`<h4>Audio</h4><div class="cc-list" role="group" aria-label="Audio">${raw(c.audio.map((t) => radio(`data-audio="${t.index}"`, c.audioNow === t.index, trackLabel(t)).html).join(""))}</div>`
    : "";
  const burned = !c.why && c.subNow != null && c.subs.some((t) => t.index === c.subNow && !isText(t));
  const style = Object.entries(CAPTION_STYLE).map(([k, s]) => html`<div class="cc-row"><span>${s.label}</span>
    <div class="seg" role="radiogroup" aria-label="${s.label}">${raw(Object.entries(s.opts).map(([v, l]) =>
      html`<button role="radio" data-cap="${k}" data-v="${v}" aria-checked="${capPref(k) === v ? "true" : "false"}">${l}</button>`.html).join(""))}</div></div>`.html).join("");
  return html`<header class="cc-head">
      <div class="cc-title"><span class="cc-badge" aria-hidden="true">CC</span>Subtitles</div>
      <button class="icon-btn" data-close aria-label="Close subtitles">✕</button>
    </header>
    <div class="cc-body">
      <div class="cc-list" role="group" aria-label="Subtitles">${subs}</div>
      ${audio}
      <h4>Look</h4>
      <div class="cc-sample" aria-hidden="true"><span style="${captionCss({ sample: true })}">Your captions look like this.</span></div>
      ${burned ? html`<p class="cc-note">These subtitles are drawn into the picture, so the look settings don't change them.</p>` : ""}
      ${raw(style)}
      <p class="cc-foot">Your choice carries over to the next show and channel.
        <span class="kb-only">Press <kbd>C</kbd> to open this menu.</span></p>
    </div>`;
}

sheet.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.matches("[data-close]")) return closeCaptions();
  if (b.dataset.cap) {
    setPref(b.dataset.cap, b.dataset.v);
    return draw();
  }
  if (b.dataset.sub) {
    // Marked at once; the stream restarts with the new choice behind the menu.
    for (const x of sheet.querySelectorAll("[data-sub]")) x.setAttribute("aria-checked", String(x === b));
    await pickSubtitle(b.dataset.sub === "off" ? null : Number(b.dataset.sub));
    return draw();
  }
  if (b.dataset.audio) {
    for (const x of sheet.querySelectorAll("[data-audio]")) x.setAttribute("aria-checked", String(x === b));
    await pickAudio(Number(b.dataset.audio));
    return draw();
  }
});

// Escape (and a remote's Back, which spatial.js sends as Escape) or C closes it.
addEventListener("keydown", (e) => {
  if (sheet.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Escape" || e.key === "c" || e.key === "C" || e.key === "Subtitle" || e.key === "ClosedCaptionToggle") {
    e.preventDefault();
    closeCaptions();
  }
});

// A click on the picture outside the menu closes it, like any popover.
addEventListener("pointerdown", (e) => {
  if (!sheet.hidden && !sheet.contains(e.target) && !e.target.closest?.('[data-act="captions"], [data-gt="captions"]')) closeCaptions();
}, true);

// A new program (or a track change restarting this one) may have other tracks.
document.getElementById("video").addEventListener("loadstart", () => !sheet.hidden && setTimeout(draw, 50));
addEventListener("debridtv:channel", () => !sheet.hidden && setTimeout(draw, 50));
