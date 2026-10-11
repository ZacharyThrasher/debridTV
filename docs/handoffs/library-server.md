# Handoff: workstream C, library, accounts and server (2026-10-11)

Branch: `claude/project-thread-y7lgyq` (rebased on `claude/debridtv-rnd-9768mu`, fast-forwardable).
Tests: `npm test` = 144+ green (`test/server.test.ts` end-to-end vs the mock, `test/library.test.ts`, probe tests). `npm run typecheck` clean.
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

## Open, in priority order (coordinator's list, 07:44)

1. **Enforce kid / restrictedHours / slots in the clock.** They are stored and returned (GET says `enforced: false`) but don't change the schedule. Needs: ratings on items (none known today; only from local .nfo, item 5), a clock filter by time of day (DST-safe, gate C5), and `slots` as weekday blocks in `StationClock` (src/clock is shared; coordinate). Unknown rating must count as restricted (gate D7).
2. **Genre/collection channels from local `.nfo` only** (N-04, N-01c). No TMDB/OMDb: that is new outbound traffic and needs Zachary's yes.
3. **MP4 chapters** (`chpl` / chapter text track) are not read; MKV chapters after the first Cluster (SeekHead-only) are missed.
4. **Inline style injector** in `panel.js` (`addStyles`): B moved the rules into styles.css (commit 60db10d on `claude/project-thread-uy3380`). Delete `addStyles()` once both branches are combined; keep class names.
5. **RD rerun + ETag answers**: waiting on Zachary's run. When the report arrives: record in LOG.md (D owns), and if ETags are stable across links and differ across versions, let a changed ETag reset the running time (today it only counts).
6. Library tests share one `library.json` per test file; filter by name in new tests.

## Gotchas

- `JsonFile` reads `DEBRIDTV_HOME` at construction: set it before `createApp()`.
- `fetch()` can't forge `Host`; use `http.get` to test the DNS-rebinding guard.
- Mock: `account.token` may be an array; `pack` groups RD files into one torrent; `state` = downloading/magnet_error; `policy` = infringing_file.
- Never call `spawnSync` against the in-process mock (deadlock); use async `execFile`.
