# ADR-0006: No forced breaks, free seeking

Status: accepted (2026-10-12). Asked for by Zachary: "if the user wants no ads, no
breaks, etc. they should get that. They should be able to fast forward in time as
well as go back."

## Context

DebridTV is not a cable simulator. It uses the nostalgia and browsing of a program
guide as a low-friction way to explore and pick your own media, instead of choosing
every file by hand.

Breaks came in while copying NostalgiaTV's features (N-21, N-22a/b/c) and became
part of the schedule itself. `autoRules` gave show, mix, movie and group channels
a 30-minute `slotMs`, so every program was padded out to the next half hour with a
"station break", and `midBreakFor` cut programs at their chapters (or detected
silences) for a 1 to 2 minute break. The player showed those as break cards you
couldn't skip. Pause also went back to live on resume (old A21), because "the
station never waited". On top of that, the rating card and the 4-hour auto
sign-off were on by default.

## Decision

- **Breaks are opt-in.** One station-wide switch, Settings → Look & feel →
  Watching → Station breaks, off by default (`Config.breaks`, `/api/station`).
  Off, `withoutBreaks` strips `slotMs` and `midBreakMs` from every rule, custom
  channels included, so each program starts as the last one ends. On, everything
  from before comes back unchanged: slot padding, chapter and silence breaks,
  "up next" and station idents. The break code stays; it just isn't the default.
  A change reaches each channel at the end of what's on (C7). If the player still
  lands in a break while they're off (the program on air when the switch flipped,
  or the gap before a time slot), it skips over it.
- **Free seeking on every channel.** The schedule never moves; the viewer watches
  it at another point (`shift.ms` in util.js: negative is behind, positive ahead,
  up to a week either way). ◀/▶ skip 10 s back and 30 s ahead; Shift+◀/▶, `[`/`]`
  or the remote's previous/next keys go to the previous/next program. Back (or L)
  returns to live first, then works as last channel again. A "Back to live" button
  shows while the viewer is shifted. Changing channel goes back to live.
- **Pause plays on from where you paused**, and leaves you behind live.
- **Other friction is off by default**: the rating card (`ratingCard` pref) and
  auto sign-off (`signOffHours`, default now 0 = never). Both stay one setting away.
- **The player exposes it for the controls.** `seekBy(ms)`, `seekTo(fileMs)`,
  `skipProgram(±1)`, `backToLive()`, `timeShift()`, `timeline()` (mode
  live/shifted/ondemand, posMs, durMs, liveMs, minMs, maxMs, itemId), the
  `debridtv:timeshift` and `debridtv:timeline` events, plus the
  `debridtv:seek`, `debridtv:skip` and `debridtv:backtolive` events, so a player
  bar can drive it without reaching into the tuner. A speed other than 1× on a
  shifted channel works: the shift follows the picture once a second.

## What still holds

- **The guide fetches nothing.** Seeking is a player feature only.
- **Locked stays locked.** A shifted tune asks `/api/now?at=` and gets the same
  redaction, and `/media` still answers 403 (`pinlock.test`).
- **Refused copies are never retried.** A seek reopens the same copy through the
  same final 409/451/403 rules.
- **Edge cache is filled only from bytes already streamed.** A seek inside a
  direct file is a browser range request on the same stream path; nothing is
  fetched ahead. A seek in compatibility mode restarts ffmpeg once the presses
  settle (400 ms), like On Demand.
- **Watch history** still records only time actually seen (D8).

## Consequences

- The guide without breaks has programs at odd minutes (8:43 PM) rather than on the
  half hour. That's the honest schedule of back-to-back files.
- Turning auto sign-off off means a forgotten tab can stream all night. The setting
  is still there for anyone who wants it.
- Parity: N-16, N-17b, N-21, N-22a/b/c now read "optional, off by default"; N-35
  gains seeking beyond NostalgiaTV. App audit A21 now checks pause → play on → L
  to live, and A29 checks breaks are off by default.
- Tests: `breaks.test` (default off, switch, export), `test/ui/player` ADR-0006 ×2
  (pause/resume behind live, skip back in place, next program, Back to live),
  `pinlock.test` (shifted `/api/now` stays redacted).
