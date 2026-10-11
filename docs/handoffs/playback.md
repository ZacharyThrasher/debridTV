# Handoff — workstream A, playback and channel flipping (2026-10-11)

Branch: `claude/project-thread-vyi2fe` (fast-forwardable onto `claude/debridtv-rnd-9768mu`).

## What landed
- **Peek for slow surfers** (ADR-0003, EXP-008): adaptive wait ≥ 700 ms → open paused at
  400 ms, show the live frame, start motion when the wait ends. `PEEK_AT`, `PEEK_MIN_WAIT` in `player.js`.
- **Edge cache** (built by C) measured in the real app: revisit tunes 1,069 → 556 ms (EXP-009).
- **Auto sign-off** `signoff.js` (N-17b): pref `signOffHours` (default 4, 0 = never), 60 s
  prompt (`signOffPromptSec`, tests only), then all streams dropped; any key/click resumes live.
- **Tracks** `tracks.js` (N-18a): A/C keys → `cycleAudio`/`cycleCaptions`; non-default audio or
  any captions → compat route with `&a=/&s=/&burn=1`; text captions polled from `/api/livesubs`;
  languages remembered in prefs `audioLang`/`subLang`. Verified end to end against C's server.
- **Picture shape** `applyAspect()` (N-17a): pref `aspect` auto/fill/4:3/zoom (Z key in main.js).
- **Errors**: after a media error the player asks `/api/item`; policy-blocked or unavailable is
  final (no compat retry). Mid-program stall → toast after 7 s; no reopen (it made hung providers worse).
- **On Demand** (N-30): `playOnDemand(itemId, {fromMs})`, `backToLive()`, `seekBy(ms)`, `tv.onDemand`
  `{itemId, fromMs, durationMs, title, positionMs}`, event `debridtv:ondemand` (detail, or null at end).
  A direct file seeks in place; a compat stream restarts 400 ms after the presses settle. Pause holds, and a compat
  stream paused for more than 30 s restarts there. The end of the file, any tune, or sign-off returns to live.
  Final errors show a toast and go back to live. Watch spans use channel "ondemand". It accepts `{ item }` from B's listing.
  Demo files are painted by synth.js from the file position, with seek, pause and end timer (`test/ui/ondemand-demo.test.ts`).
- **Music** `music.js` (N-23a): `kind: "track"` airings play through the same `<video>` path. The screen has a sleeve
  or initials, a spinning disc, track details, a progress bar and a themed LED analyser (Web Audio, routed only once
  running). C4 confirmed the shapes; an end-to-end Jukebox test runs on 5 tagged Opus songs with a cover.
- **Compat audio**: the player sends `&ac=opus` when the browser has no AAC (needs C's patch in serveLive).
  `&maxh=720|1080` comes from pref `compatMaxHeight` (ADR-0004; server side and panel control shipped by C4).
- **Tests**: `test/ui/player.test.ts` covers join at live, pause→live, surf cost, peek, lock, sign-off ×2, On Demand,
  and audio and captions (N-18a: two-language MKV plus numbered SRT; runs with C4's `&ac=opus`).

## Open
- Chrome/Edge MKV direct play with H.264/HEVC on Zachary's Windows PC (Playwright Chromium has no H.264).
- Peek and edge-cache numbers on a real provider (needs a run on Zachary's PC).
- Declined: filling the edge-cache head at probe time (~1 GB of unwatched media across 938 files breaks the core rule). The cache stays viewer-filled.
- Bitmap-subtitle burn-in has no fixture yet.
- Closed (C4 b7a7fc3): audio-only compat has no video map; `&maxh` works on the encode paths, with a panel control `compatMaxHeight`.
- No passthrough: browsers can't bitstream AC-3 or DTS (ADR-0004).

## Bench
`experiments/exp008-browser-peek.ts` (own metered server, `INDEX_CACHE`, `JITTER`, `VARIANTS`),
`experiments/exp009-app-surf.ts` (real app + mocks). Both need ffmpeg-made VP9 WebM in `MEDIA_DIR`.
