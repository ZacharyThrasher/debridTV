# Handoff: workstream C, library, accounts and server (2026-10-11, second session)

Branch: `claude/project-thread-446sg8` (contains y7lgyq and a merge of `claude/debridtv-rnd-9768mu` at 2110fe4, so shared fast-forwards onto it).
Tests: `npm test` = 183 green (`test/server.test.ts` end-to-end vs the mock, `test/library.test.ts`, probe tests). `npm run typecheck` clean.
Try it: `npm run dev:mock` → http://127.0.0.1:7338 with every file state (keys printed; type `expire`/`renew` to flip premium).

## What exists now

- **Server** (`app/server.ts`): `createApp({port, bases, ffmpeg, timers})`; listens only when run directly. Disconnected sources leave the air.
- **Accounts**: `client.account()` (plan + premium end only; no username/email). Checked on connect, refresh and "Check again". Expired premium or rejected key → status `account` with its own message; `/media` returns 409 without asking for a link.
- **File states** (`fileStatus()` in `app/library.ts`): ready, needs-scan, not-ready (provider unfinished or failed: never requested), refused (never retried or fetched elsewhere), account, problem, gone, excluded, other. Each has a distinct plain message (gate D5).
- **Library tab** (`panel.js`): filters, search, Check now (one link), Keep off the air, Mark watched. Zero provider requests to open.
- **History**: hand marks stored separately (`manual`), labelled in UI; forget one; export; clear really clears.
- **Data**: `/api/export` + `/api/import` (no keys), `/api/forget` (needs `{confirm:"forget everything"}`).
- **Scan**: 429 → pause 60 s once, second → stop with reason. Stop cuts pauses short. Retry-failed button.
- **ETag**: stored per file; a change is only counted (`etagChanges`); a changed total size resets the running time. Live answer pending (runbook step 4).
- **Probe**: `tracks` (kind, index within kind = ffmpeg `0:a:N`, codec, lang, name, default, forced) for MKV/MP4; Matroska `chaptersMs`. `/api/item` returns both.
- **Mid-breaks**: chapter starts → `breakpointsMs` (3 min from either end, 5 min apart, max 3); show/mix rules get `midBreakMs` of 2/1.5/1 min only if no program spills into an extra slot.
- **Channel settings**: GET/POST/PUT `/api/channels/:id/settings` per B's contract. Name, number (taken → swap), favorite, logo (badge/text with hue/style, or inline data: image) work now. channelView carries `favorite`, `logo`, `kid`, and `hue` from the logo.
- **Meters**: busiest minute per provider vs published limit (RD 250/min all; TorBox 300/min per endpoint).
- **Live probe**: LIST, RD_PICK/TB_PICK, packs `n.m`, ETAG mode, runbook `docs/runbooks/live-probe.md`.

## Added in the second session

- **Schedule rules enforced** (`src/clock/ratings.ts`, `dayparts.ts`, `WindowPlan` in `schedule.ts`). A revision may carry `maxRating` (kid = PG) and `dayparts {timeZone, rules[]}`. Restricted hours and slots become windows on local time in a named zone ($DEBRIDTV_TZ or the PC's), DST-safe (gap → end of gap, repeated hour → first). Each window airs whole programs from its own source (usual lineup or a slot's program), filtered by the strictest limit in force; nothing straddles a window edge; a program too long for the room left is passed over for one that fits (12-item look-ahead) and goes first next time; leftover time is the last program's closing break; a window where nothing may air is off the air. Each source keeps its place across windows (Saturday cartoons continue next week). Windowed revisions are planned forward from their start and memoised per revision (still pure: same inputs, same schedule). Unknown rating never passes a limit (D7). Tests: `test/dayparts.test.ts`.
- **Lineup → clock**: `scheduleRules()` turns settings into `maxRating`/`dayparts`; slot `source` is a rule key (a missing source drops the slot); slots before restricted rules, earlier slot wins overlaps. Settings changes go through `revise()` (wait for the program on now, C7).
- **Ratings**: `.nfo` `<mpaa>`/`<certification>` (film or US TV, folded to G..NC-17); hand-set ratings per show or file in library.json `ratings` win (`/api/ratings` GET/POST; exported/imported). Library tab "Age ratings" view; `openPanel("library", "ratings")` opens it.
- **.nfo metadata** (`src/library/nfo.ts`): local folders only; own `<name>.nfo`, `movie.nfo`, nearest `tvshow.nfo` up to two folders up, never above the chosen folder. Stored as `LibItem.meta`. Airings carry `rating`, `description` (plot); subtitle/genre fall back to it.
- **Metadata channels** (`metadataRules`): network (3+ shows, #20+), genre (2+ titles and 8+ h, #30+), collection (3+ films in a set, release order, #40+). Demo library has invented genres, ratings and a "Northstar" network.
- **Specials** (N-05): season 0 is off show/mix channels unless settings `specials: true`; then they air after the last season. GET settings returns `specials`, `specialsAvailable`.
- **Chapters**: MP4 Nero `chpl` or the QuickTime chapter track (`tref/chap`; that track is no longer listed as a subtitle, matching ffmpeg's 0:s:N); Matroska Chapters after the media found through the SeekHead (two small reads).
- **Settings GET**: `enforced: true`, `timeZone`, `ratings {total, byRating, unrated, kidSafe}`.
- `addStyles()` removed from panel.js (B's styles.css has the rules; the favorite star colour is inline).

## Added later in the second session

- **Track choice for compat** (`serveLive`): `a`, `s`, `burn=1`; text subs as a second ffmpeg output (WebVTT on fd 3, `-output_ts_offset start` so cue times are file times) → `/api/livesubs?tok&since` relative to the livestart zero (`src/library/vtt.ts`). Burn-in for pgs/vobsub is untested end to end (no bitmap fixture). `-map_chapters -1`.
- **Badges** (N-37): probe reads height, HDR (PQ/HLG/DV) and channels; `mediaBadges()` adds `hdr/height/audioChannels/atmos` to airing.codecs with name-tag fallback.
- **Weighted mixes** (`MixRules` on a revision; `pickMix` in WindowPlan): weights per show/"films", balance by turns or airtime, premieres (first seen < 14 days, `LibItem.addedAt`), marathons (3%/pick, 4 h, then another show). Settings: weights, balance, marathons, premieres, watched (all/unwatched/resume), exclude; `shapeRule`/`mixRules` in lineup.ts. Global exclusions `/api/exclusions` (with options); refresh `/api/channels/:id/refresh` (seed `key~n`).
- **Backups** (`app/backups.ts`): daily settings export to `<data>/backups`, keep 14 (`backupKeep`), `/api/backups`, `/api/backups/restore`; Privacy tab UI.
- **Edge cache** (`app/edgecache.ts`, ADR-0003 from A): head 1 MiB + tail 256 KiB of tuned files, LRU 256 MiB in `<data>/cache`; filled only from proxied bytes (not yet from probe reads); meters `bytes.cached` and `cache`.
- **Panel**: Sign off after (signOffHours), bug corner/opacity, rating card, theme list from theme.js + Customize…, exclusions button, cache stat, backups.

## Added in the third session (branch `claude/project-thread-rfoift`)

- **PIN-locked channels (N-06b)**, `app/pinlock.ts`. One PIN for the TV, 4–8 digits, stored only as a salted scrypt hash (N=2^14, r=8) in `<data>/lock.json` (0600; never exported or backed up; "Forget everything" deletes it). Unlock lasts 4 h or until restart (memory only). Wrong guesses: 3 free, then 30 s doubling to 15 min; the wait is persisted, so restarting gives no extra guesses. Checks are serialised.
  - Settings `locked: boolean` (needs a PIN, else 409 `pinRequired`). A lock counts only while a PIN exists; removing the PIN clears every `locked` flag.
  - `channelView` (bootstrap, /api/now, /api/guide, /api/channels) carries `locked` and `unlocked`. Settings GET adds `locked`, `unlocked`, `pinSet`, `alsoOn [{id, number, name, programs}]` (unlocked channels that air some of the same programs; lock those too or they stay watchable there).
  - `/media/:id`, `/media/:id/live`, `/api/prefetch` → 403 `{locked:true, final:true}` for an item that only locked channels carry (unlocked channels count only within their rating limit). Checked before any link or byte, `internal=1` included.
  - While the guard is up (PIN set, a channel locked, not unlocked), anything that decides what airs needs the PIN (403 `pinRequired`): channel settings other than `favorite` and `locked:true`, custom channel save/delete, ratings, import, backup restore. Hiding and exclusions only shrink what airs, so they stay open.
  - Routes: `GET /api/lock` → `{pinSet, unlocked, untilMs, retryAfterMs?, lockedChannels}`; `POST /api/lock/pin {old?, pin}` (pin `null` removes; setter is unlocked at once); `POST /api/lock/unlock {pin}` → `{ok, untilMs}` or 403/429 `{error, retryAfterMs?}`; `POST /api/lock/lock`.
  - Panel: Privacy tab "Parental PIN" (set, unlock, lock now, change, remove); Channels tab gets a lock button per channel and a PIN row while locked. Unlocking from the panel fires `debridtv:unlocked` with `{channelId: null}` (all channels) for A's player.
  - Tests: `test/pinlock.test.ts`.

## Open, in priority order

1. **RD rerun + ETag answers**: waiting on Zachary's run. When the report arrives: record in LOG.md (D owns), and if ETags are stable across links and differ across versions, let a changed ETag reset the running time (today it only counts).
2. **Not started**: edge-cache fill from probe reads; a real PGS file check for burn-in.
3. **Rating changes apply at once**, not at the end of the current program (the clock reads ratings directly). Rarely matters; if it does, bake ratings into the revision at sync.
4. **Online metadata** (TMDB/OMDb) stays unbuilt until Zachary says yes (new outbound traffic).
5. Library tests share one `library.json` per test file; filter by name in new tests.

## Gotchas

- `pkill -f "node app/server.ts"` kills your own shell if it shares the command line; run it as its own call.
- `JsonFile` reads `DEBRIDTV_HOME` at construction: set it before `createApp()`.
- `fetch()` can't forge `Host`; use `http.get` to test the DNS-rebinding guard.
- Mock: `account.token` may be an array; `pack` groups RD files into one torrent; `state` = downloading/magnet_error; `policy` = infringing_file.
- Never call `spawnSync` against the in-process mock (deadlock); use async `execFile`.

## Note from workstream B (2026-10-11)
- B made a small a11y edit in `panel.js` while no C thread was running: `aria-label`s on the Look & feel switches (via `sw()`), the rating-card switch and the theme/startup/guideIdle/guideIdleMin/signOffHours selects. axe-core is now clean on every Settings tab in Midnight, Daylight and Cable '92.
- `--faint` is brighter in all three themes (4.5:1 on panels), so `.muted` text passes contrast.
- Gotcha: the `html` template tag renders `false` as "", so write `aria-pressed="${String(x)}"`.
- B also added one "TV set" select (pref `bezel`: off | classic | wood) to the Look & feel tab, next to the channel bug options.
