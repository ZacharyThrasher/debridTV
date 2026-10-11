# Handoff: workstream B (guide, station breaks, look), 2026-10-11

Branch: push straight to `claude/debridtv-rnd-9768mu` (Zachary said yes on 2026-10-11). Run `git pull --rebase` first and edit only B's files.
B owns: `app/public/js/{guide,cards,ui,synth,main,channel-editor}.js`, `app/public/styles.css`, `app/public/index.html`, `test/ui/`.
Others: A = `player.js`/`static.js`, C = server, library and `panel.js`, D = parity docs. Requests to them go through the coordinator.

## What's done (all on the shared branch)
- **Station breaks** (`cards.js`): breaks of 2.5 min or more rotate every 10 s through up next, later on this channel, on now elsewhere and starting soon. A guide crawl runs along the bottom, with a break meter and a ghost channel number. The data comes from `/api/guide`, so there are 0 provider calls. Short breaks show only the hero. Unavailable and off-air cards get "Meanwhile, on now" chips that tune. Screen-reader-safe: the countdowns are `aria-live=off`, and a hidden summary line explains the break.
- **Guide** (`guide.js`): picture-in-guide (the stage scales into the preview, desktop only). Rows fit whole. Slot padding shows as a hatched tail. The now line runs behind opaque cells, with a triangle marker in the time bar. The aired part of current cells is shaded. Details show the program's progress, its break, rating and plot. Runs of one show lead with the episode name. Favorites come first with a ★, and wordmarks replace names. Phones can swipe (rows follow the finger and the guide re-renders on release).
- **Banner** (`ui.js`): a hatched break at the end of the progress bar and a rating badge. A rating card shows top-left for 6 s at program start (pref `ratingCard`). Prefs `bugPos` (br/bl/tr/tl) and `bugOpacity` control the bug.
- **Channel editor** (`channel-editor.js`): Identity (name, number with a swap warning, favorite, logo as a badge, a wordmark of 6 letters or fewer in block/outline/pill style, or an image data URL of 200 KB or less, plus a hue), Schedule (weekday slots with a week strip, where overnight slots run into the next day, and a specials toggle when `specialsAvailable > 0`), and Audience (kid flag, daytime rating limit, rating coverage bar, and a link to `openPanel("library","ratings")`). It runs on C's `GET`/`POST /api/channels/:id/settings`, normalises nulls, and keeps `enforced`/`timeZone`/`ratings`/`specialsAvailable` out of the saved body. C's Channels tab opens it with `openChannelEditor(ch, { onSaved })`.
- **Remote** (`main.js`): prefs `startup` ("last" | "guide" | "ch:<id>") and `guideIdle` ("stay" | "close" | "tune", after `guideIdleMin`, default 2). Z cycles `aspect` and calls `player.applyAspect?.()`. A and C call `player.cycleAudio?.()` and `cycleCaptions?.()`. Welcome hints appear only for functions that exist.
- **Tests**: `test/ui/guide.test.ts` (6 Chromium tests in demo mode; they skip without Playwright).

## Open (from the coordinator, in priority order)
1. **Theme editing and import/export (N-11b).** Themes are CSS variable sets on `[data-theme]` in `styles.css` (midnight, cable92, daylight). The idea is a custom theme built from a few user-picked colours stored in prefs and applied as inline `--var`s on `:root`, plus JSON export and import. The UI controls belong in panel.js (C), so send C the spec.
2. **HDR and audio-format badges in the banner (N-37).** This waits on C adding fields to airingView (for example `hdr`, `audioFormat`). Badges go in `renderBanner` in `ui.js`.
3. **Later:** UI for show and genre exclusions (N-09b) and per-channel "refresh schedule" (N-10). The shapes will come from C through the coordinator. They probably belong in channel-editor.js.
4. **Prefs that still need controls in panel.js (C):** `startup`, `guideIdle`, `guideIdleMin`, `ratingCard`, `bugPos`, `bugOpacity`. These specs were already sent for startup and idle.

## How to check visuals
- The screenshot harness is `/mnt/project-files/debridTV/tools/shots.mjs`. Run `BASE=http://127.0.0.1:7340 node shots.mjs <out> [w h] [scenario…]`. It adds `?at=` to `/api/now` and offsets JSON `now` to land inside a break. `DECOR=1` stubs logos and favorites, and `PREFS='{"theme":"cable92"}'` sets a theme. To step through break slides, use `page.clock.install()` plus `runFor`.
- Start a demo server with `PORT=7340 DEBRIDTV_HOME=<tmp> node app/server.ts`. Kill it in a separate shell call.
- Screenshots so far: `/mnt/project-files/debridTV/screens/guide-look/1…7`.

## Gotchas
- Re-rendering the guide during a touch gesture kills the gesture, because a detached target gets no more touch events. Render on release.
- The `.banner` third column has an inline `display:grid`. Hiding it on phones needs `!important`.
- `channel-editor.js` imports `player.js`, and `ui.js`, `cards.js` and `guide.js` import `channel-editor.js`. These cycles are fine because nothing is used at top level.
- `--row` is set inline by `fitRows()` and re-fit whenever `.grid-rows` height changes.
