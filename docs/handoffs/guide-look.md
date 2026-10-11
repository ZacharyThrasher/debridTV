# Handoff: workstream B (guide, station breaks, look), 2026-10-11

Branch: B's second session pushed to `claude/project-thread-k2fnes` (it is kept fast-forwardable from the shared branch `claude/debridtv-rnd-9768mu` and merges A and C3). Ask the coordinator which branch to push to. Edit only B's files.
B owns: `app/public/js/{guide,cards,ui,synth,main,channel-editor,theme,bezel,lock}.js`, `app/public/styles.css`, `app/public/index.html`, `test/ui/`.
Others: A = `player.js`/`static.js`, C = server, library and `panel.js`, D = parity docs. Requests to them go through the coordinator.

## What's done (all on the shared branch)
- **Station breaks** (`cards.js`): breaks of 2.5 min or more rotate every 10 s through up next, later on this channel, on now elsewhere and starting soon. A guide crawl runs along the bottom, with a break meter and a ghost channel number. The data comes from `/api/guide`, so there are 0 provider calls. Short breaks show only the hero. Unavailable and off-air cards get "Meanwhile, on now" chips that tune. Screen-reader-safe: the countdowns are `aria-live=off`, and a hidden summary line explains the break.
- **Guide** (`guide.js`): picture-in-guide (the stage scales into the preview, desktop only). Rows fit whole. Slot padding shows as a hatched tail. The now line runs behind opaque cells, with a triangle marker in the time bar. The aired part of current cells is shaded. Details show the program's progress, its break, rating and plot. Runs of one show lead with the episode name. Favorites come first with a ★, and wordmarks replace names. Phones can swipe (rows follow the finger and the guide re-renders on release).
- **Banner** (`ui.js`): a hatched break at the end of the progress bar and a rating badge. A rating card shows top-left for 6 s at program start (pref `ratingCard`). Prefs `bugPos` (br/bl/tr/tl) and `bugOpacity` control the bug.
- **Channel editor** (`channel-editor.js`): Identity (name, number with a swap warning, favorite, logo as a badge, a wordmark of 6 letters or fewer in block/outline/pill style, or an image data URL of 200 KB or less, plus a hue), Schedule (weekday slots with a week strip, where overnight slots run into the next day, and a specials toggle when `specialsAvailable > 0`), and Audience (kid flag, daytime rating limit, rating coverage bar, and a link to `openPanel("library","ratings")`). It runs on C's `GET`/`POST /api/channels/:id/settings`, normalises nulls, and keeps `enforced`/`timeZone`/`ratings`/`specialsAvailable` out of the saved body. C's Channels tab opens it with `openChannelEditor(ch, { onSaved })`.
- **Remote** (`main.js`): prefs `startup` ("last" | "guide" | "ch:<id>") and `guideIdle` ("stay" | "close" | "tune", after `guideIdleMin`, default 2). Z cycles `aspect` and calls `player.applyAspect?.()`. A and C call `player.cycleAudio?.()` and `cycleCaptions?.()`. Welcome hints appear only for functions that exist.
- **Themes (N-11b)** (`theme.js`): editor with 8 colour slots (bg, panel, ink, accent, highlight, accent2, cell, osd) plus cell strength, a live preview, contrast checks, and starters (Prevue, Teletext, Phosphor, VHS, Saturday). Import/export as `{format:"debridtv-theme", version:1, name, colors, cellStrength}` through a file, the clipboard or drag and drop. Stored in prefs `customThemes`, selected as `theme: "custom:<id>"`, applied as inline vars on `<html>` with `data-theme="custom"` and `data-tone="light|dark"`. Light-only CSS keys on `[data-tone="light"]`, not on the daylight theme name.
- **Format chips (N-37)** (`ui.js formatChips(a)`): 4K/1080p/720p/SD, Dolby Vision/HDR10+/HDR10/HLG, Atmos, and the codec with its channel count. Shown in the banner and guide details.
- **Mix tab (N-09, N-10)** (`channel-editor.js`): weight sliders, genre chips, balance, marathons, premieres, watched, and Reshuffle (`POST /api/channels/:id/refresh`). `openExclusions()` is the "Keep off the air" dialog on `/api/exclusions`.
- **TV set (N-12)** (`bezel.js`): pref `bezel` off|classic|wood. The VHF dial follows `debridtv:channel`, which `ui.bug()` dispatches.
- **Station ident (N-21)**: the second break slide.
- **Locked channels (N-06b)** (`lock.js`, `cards.lockedCard`): a scrambled picture with a PIN pad, redacted guide/banner/breaks/crawl (`isRedacted(a)`), the lock section in the editor's Audience tab (set or change the PIN, "also on" list), and `withPin()` for writes refused with 403 `pinRequired`. An unlock dispatches `debridtv:unlocked`.
- **Artwork (N-01c)** (`ui.js artOf/artImg`): only `/api/art/` URLs, never for redacted airings. Episodes show a still in the banner, movies a poster. Guide details get a fanart backdrop and a poster. Breaks get fanart (Ken Burns, still when calm) and a poster on the hero slide. The editor offers the show's logo or poster (`channel.art`) as an image logo, scaled into a data URL of 200 KB or less. A picture that fails to load removes itself (`data-art`) and its box's `has-art`. Image logos now show everywhere wordmarks did (`hasLogo`).
- **A11y**: axe-core is clean on B's surfaces and Settings in 3 themes. `--faint` was brightened.
- **Tests**: `test/ui/guide.test.ts` (Chromium in demo mode; it skips without Playwright).

## Open
1. **TV-distance (10-foot) pass**: larger targets and type at 1920×1080 viewed from a couch, plus focus rings for remote navigation in the editor and dialogs.
2. The A/C key hints stay hidden until `player.cycleAudio`/`cycleCaptions` exist.
3. A's `test/ui/player.test.ts` "a locked channel asks for no link" fails after merging C3. The stub sets `o.locked`, but C3 now sends `channel.locked:false`, which wins through `??`. A has to fix this; it was reported to the coordinator.
4. Prefs that still need panel.js controls (C): `startup`, `guideIdle`, `guideIdleMin`, `ratingCard`, `bugPos`, `bugOpacity`.

## How to check visuals
- The screenshot harness is `/mnt/project-files/debridTV/tools/shots.mjs`. Run `BASE=http://127.0.0.1:7340 node shots.mjs <out> [w h] [scenario…]`. It adds `?at=` to `/api/now` and offsets JSON `now` to land inside a break. `DECOR=1` stubs logos and favorites, and `PREFS='{"theme":"cable92"}'` sets a theme. To step through break slides, use `page.clock.install()` plus `runFor`.
- Start a demo server with `PORT=7340 DEBRIDTV_HOME=<tmp> node app/server.ts`. Kill it in a separate shell call.
- Screenshots so far: `/mnt/project-files/debridTV/screens/guide-look/1…20`.
- Art: there is no local art in demo mode. Stub it in Playwright by rewriting `/api/{now,guide,boot}` JSON to add `art` and by routing `/api/art/**` to sample images.

## Gotchas
- Re-rendering the guide during a touch gesture kills the gesture, because a detached target gets no more touch events. Render on release.
- The `.banner` third column has an inline `display:grid`. Hiding it on phones needs `!important`.
- `channel-editor.js` imports `player.js`, and `ui.js`, `cards.js` and `guide.js` import `channel-editor.js`. These cycles are fine because nothing is used at top level.
- `--row` is set inline by `fitRows()` and re-fit whenever `.grid-rows` height changes.
- The `html` template drops `false`, so wrap ARIA booleans in `String()`. Use `raw()` for strings that are already HTML.
- `applyPrefs()` calls `onPrefsApplied` listeners (util.js). Tests that change prefs should call it rather than reload, because the init script resets prefs on reload.
- `.card` gets `hidden`, not a class change, so wait for `.card.locked:not([hidden])`.
- Editors and dialogs swallow keys with capture listeners and `stopImmediatePropagation`. main.js also ignores keys while any of them is open.
