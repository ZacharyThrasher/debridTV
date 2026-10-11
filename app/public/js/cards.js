// Full-screen station cards: breaks between programs, off air, and the honest
// "can't play this" card. Breaks never touch a provider: they're drawn here.

import { html, raw, fmtTime, fmtClock, now } from "./util.js";

const el = document.getElementById("card");
let countdownTo = 0;

const bars = raw(`<div class="card-bars">${"<i></i>".repeat(7)}</div>`);

function show(hue, inner, cls = "") {
  el.className = `card ${cls}`;
  el.style.setProperty("--h", hue ?? 220);
  el.innerHTML = `<div class="card-inner">${inner}</div>${bars.html}`;
  el.hidden = false;
}

export function hideCard() {
  el.hidden = true;
  el.innerHTML = "";
  countdownTo = 0;
}

/** A station break: "we'll be right back" mid-program, or the up-next ident between airings. */
export function breakCard(ch, info) {
  const seg = info.segment;
  const mid = seg.reason === "mid";
  const next = mid ? info.airing : info.next;
  countdownTo = seg.end;
  const nextLine = next
    ? html`<div class="card-next">
        <div><div class="label">${mid ? "Back in" : "Up next"}</div><div class="what">${next.title}</div>
        ${next.episode || next.subtitle ? html`<div class="label" style="letter-spacing:.06em;text-transform:none;color:rgba(255,255,255,.75)">${[next.episode, next.subtitle].filter(Boolean).join(" · ")}</div>` : ""}</div>
        <div class="when">${mid ? "" : fmtTime(seg.end)}</div>
      </div>`
    : "";
  show(
    ch.hue,
    html`<div class="card-kicker">${mid ? "We'll be right back" : "You're watching"}</div>
      <div class="card-title">${ch.name}</div>
      <div><span class="card-num">${ch.number}</span></div>
      <div class="card-sub">${ch.tagline || ""}</div>
      ${raw(nextLine)}
      <div class="card-countdown" data-countdown>${fmtClock(seg.end - now())}</div>`,
  );
}

export function offAirCard(ch) {
  countdownTo = 0;
  show(
    ch.hue,
    html`<div class="card-kicker">Off the air</div>
      <div class="card-title">${ch.name}</div>
      <div><span class="card-num">${ch.number}</span></div>
      <div class="why">This channel has nothing it can schedule yet. Programs join a channel once their running time is known: open Settings → Sources and run a library scan.</div>`,
    "warn",
  );
}

export function unavailableCard(ch, airing, { policy = false, reason = "" } = {}) {
  countdownTo = airing.end;
  const why = policy
    ? "Your provider refused this file. DebridTV won't retry it and won't fetch it from anywhere else. The channel carries on with the next program."
    : reason || "This program can't be played right now. The channel keeps time and moves on at the next program.";
  show(
    ch.hue,
    html`<div class="card-kicker">${policy ? "Not available from your provider" : "Can't play this one"}</div>
      <div class="card-title" style="font-size:calc(var(--u)*4.4)">${airing.title}</div>
      <div class="card-sub">${[airing.episode, airing.subtitle].filter(Boolean).join(" · ")}</div>
      <div class="why">${why}</div>
      <div class="card-countdown">Next program in <span data-countdown>${fmtClock(airing.end - now())}</span></div>`,
    "warn",
  );
}

export function messageCard(ch, kicker, title, why) {
  countdownTo = 0;
  show(ch?.hue ?? 220, html`<div class="card-kicker">${kicker}</div><div class="card-title" style="font-size:calc(var(--u)*4.4)">${title}</div><div class="why">${why}</div>`, "warn");
}

/** Called once a second by the main loop. */
export function tickCard() {
  if (el.hidden || !countdownTo) return;
  const c = el.querySelector("[data-countdown]");
  if (c) c.textContent = fmtClock(countdownTo - now());
}
