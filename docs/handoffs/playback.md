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
- **Tests**: `test/ui/player.test.ts` (join at live, pause→live, surf cost, peek, sign-off ×2).

## Open
- Chrome/Edge MKV direct play with H.264/HEVC on Zachary's Windows PC (Playwright Chromium has no H.264).
- Peek and edge-cache numbers on a real provider (needs a run on Zachary's PC).
- Fill the edge-cache head at library-probe time so first visits also skip two round trips (C).
- Bitmap-subtitle burn-in has no fixture yet.

## Bench
`experiments/exp008-browser-peek.ts` (own metered server, `INDEX_CACHE`, `JITTER`, `VARIANTS`),
`experiments/exp009-app-surf.ts` (real app + mocks). Both need ffmpeg-made VP9 WebM in `MEDIA_DIR`.
