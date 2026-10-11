// The TV set around the picture (parity N-12): pref bezel = "off" (default) | "classic" | "wood".
// Classic is a dark plastic 90s set with a brand plate and power light; Wood is a
// console set with a VHF dial that turns to the channel you're on (click it to go up).
// Purely visual: the picture, banner and bug sit inside the screen, and the set steps
// aside while the guide is open or on a phone.

import { html, raw, pref, onPrefsApplied } from "./util.js";
import { channelStep } from "./player.js";

const set = document.createElement("div");
set.id = "tvset";
set.setAttribute("aria-hidden", "true");
set.innerHTML = html`
  <div class="tv-body"></div>
  <div class="tv-glass"></div>
  <div class="tv-plate"><span class="tv-brand">DebridTV</span><span class="tv-model">Stereo · Cable ready</span><i class="tv-led"></i></div>
  <div class="tv-side">
    <div class="tv-dial" data-dial title="Channel up">
      ${raw(Array.from({ length: 13 }, (_, i) => `<b style="--a:${i * (360 / 13)}deg">${i === 0 ? "U" : i + 1}</b>`).join(""))}
      <div class="tv-knob"><i></i></div>
    </div>
    <div class="tv-dial small" data-vol><div class="tv-knob"><i></i></div><span>Volume</span></div>
    <div class="tv-grille"></div>
  </div>`.html;
document.body.prepend(set);

let number = null;

function apply() {
  const kind = ["classic", "wood"].includes(pref("bezel")) ? pref("bezel") : "off";
  document.body.dataset.bezel = kind;
  set.hidden = kind === "off";
  const v = Number(pref("muted") ? 0 : pref("volume") ?? 0.9);
  set.style.setProperty("--vol", `${-135 + v * 270}deg`);
}
onPrefsApplied(apply);
apply();

/** Turns the dial: VHF 2–13 click into place; anything else rests on U (UHF). */
function turn(n) {
  number = n;
  const pos = n >= 2 && n <= 13 ? n - 1 : 0;
  set.style.setProperty("--dial", `${pos * (360 / 13)}deg`);
}
addEventListener("debridtv:channel", (e) => turn(e.detail?.number));

set.addEventListener("click", (e) => {
  if (e.target.closest("[data-dial]")) channelStep(1);
});
