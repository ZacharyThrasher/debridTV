# DebridTV handoff (2026-10-11)

Branch: `claude/debridtv-rnd-9768mu` (the only branch; there is no `main` yet, so no PR).
Node ≥ 22.18 runs the `.ts` files directly. No runtime dependencies.

## 1. Architecture

| Area | Path | What it does |
|---|---|---|
| Station clock | `src/clock/` (`schedule.ts`, `ordering.ts`, `rng.ts`, `types.ts`) | Pure schedule: airing at time t from channel revisions, seed and exact durations. Prefix sums + binary search. `revise()` takes effect at the end of the current airing. Slot padding breaks and mid-breaks. 8 ordering modes. Never contacts a provider. |
| Watch history | `src/history/watched.ts` | `WatchLedger`: merged seen-spans per item; watched = ≥90% of file time actually seen. |
| Gates | `src/gates.ts` | `sharing`, `cloud-relay`, `tuner-export`; independent, default closed, nothing grants them. |
| Providers | `src/providers/` | Read-only RD/TorBox clients with call counters (`clients.ts`), error classification incl. policy codes (`types.ts`), metering mock server (`mock-server.ts`). RD lists paged; multi-file torrents become `pack:<id>` and expand via `/torrents/info`. |
| Tuner (research) | `src/tuner/` | `GrantCache` (one link per file, in-flight dedupe, 60 min fallback TTL, re-resolve once on 403/404/410) and strategy tuner used by experiments. |
| Library parsing | `src/library/parse.ts`, `probe.ts` | Filename → episode/movie/other. Header-only probing of MKV/MP4 for duration and codecs (reads a few KB). |
| App server | `app/server.ts` | Binds 127.0.0.1:7337 only; Host + Origin checks. JSON API (`/api/bootstrap`, `guide`, `now`, `prefetch`, `watch`, `history`, `meters`, `sources`, `scan/*`, `library`, `channels/*`, `livestart`), metered media proxy `/media/:id` (Range passthrough, upstream abort on client close, 451 on policy), ffmpeg compatibility stream `/media/:id/live`. |
| App state | `app/store.ts`, `library.ts`, `lineup.ts`, `meters.ts`, `demo.ts` | Data dir (`%APPDATA%\DebridTV`, `~/.debridtv` or `$DEBRIDTV_HOME`), JSON files with atomic writes (keys chmod 600). Library + paced duration scan. Lineup with stable numbers and auto rules (show channels #10+, Half Hour #2, Prime Hour #3, Marathon #4, Feature #5, Quarter Hour #6, decade cinema, custom #50+). Fictional demo library. |
| Front end | `app/public/` (`index.html`, `styles.css`, `fonts/`, `js/*.js`) | Vanilla ES modules. `player.js` tuner (adaptive-prefetch, route choice direct/compat, keyframe alignment + 1.1x catch-up, watch spans), `guide.js`, `panel.js` (settings tabs), `cards.js` (breaks/off-air/unavailable), `synth.js` (demo picture), `static.js` (snow + sounds), `ui.js` (OSD, banner, bug), `util.js`, `api.js`, `main.js` (keys, touch, welcome). Fonts self-hosted (OFL). |
| Experiments | `experiments/` | `exp001-clock`, `exp002-surf`, `exp003-chunk-amplification`, `live-probe.ts` (runs only on Zachary's PC). |
| Docs | `docs/experiments/LOG.md`, `docs/decisions/`, `docs/parity/nostalgiatv.md` | Experiment log, ADR-0001 (pure clock), ADR-0002 (grant reuse), parity register. |

## 2. Run

```sh
npm test            # node --test "test/**/*.test.ts" (114 tests, ~1 s)
npm run typecheck   # tsc --noEmit; includes app/
npm start           # app on http://127.0.0.1:7337 (demo mode with no source)
npm run exp:001     # guide cost
npm run exp:002     # surfing cost; env PRESS_MS, DWELLS (0=cancel+cache, N=dwell, -1=adaptive, -2=adaptive-prefetch), FINAL=fresh, API_LATENCY_MS, MEDIA_TTFB_MS
npm run exp:003     # link reuse / request amplification
```

Mock providers: `src/providers/mock-server.ts` starts a local fake RD/TorBox that meters API calls, 429s, bytes and open streams; experiments start it themselves. Testing the app with real files: generate media with ffmpeg into a folder, `PORT=7338 DEBRIDTV_HOME=/tmp/x npm start`, POST `/api/sources {provider:"local", dirs:[...]}`, POST `/api/scan/start`, then a custom channel with `slotMinutes: 0` for back-to-back playback. Screenshots: Playwright at `/opt/node22/lib/node_modules/playwright`, launch without the proxy.

## 3. Tuner defaults

- Strategy: adaptive-prefetch (EXP-006). Each press asks the local clock what's on (free). The link is resolved after 150 ms; media opens after an adaptive wait = 1.3 × last press gap, clamped to [150, 1200] ms. A gap over 2400 ms counts as a deliberate pick (wait 150 ms).
- Grant reuse: up to 60 min per file, one fresh fetch on expiry, no retry loop.
- Route: direct play when the browser can decode container/video/audio; else ffmpeg compatibility mode (copy video if decodable, AAC audio, fragmented MP4); one fallback direct→compat, never a loop.
- Compat alignment: the copied stream starts at the keyframe before the live point; the server finds it with ffprobe (`/api/livestart`) and the client plays at 1.1x until back on station time (verified: ~3 s caught up in ~35 s).

## 4. Open research items

- **Slow-surf gap:** surfers at ~1 press/s wait ~0.8 s more than fast surfers (LIVE-001 re-run). Candidate: predict dwell from press history, or prefetch neighbour channels' links (API cost, no bytes).
- **ETag as edition identity:** TorBox sends ETags; untested whether they distinguish two versions of the same episode.
- **Real-Debrid rerun:** the auto-picked "downloaded" file returned `infringing_file` (code 35); playback numbers still need a run with `$env:PICK=<n>` on a playable file. Policy: never retry or route such files to the other provider.
- **Chrome MKV direct play** on Windows is assumed (UA check); confirm on Zachary's PC. Playwright's Chromium has no H.264.
- **Long station breaks:** a 42-min episode in a 60-min slot leaves an 18-min break card. Idea: Prevue-style rotating break card (up next, later today, on now elsewhere), zero provider cost.

## 5. Parity status

`docs/parity/nostalgiatv.md` has 56 rows per surface/version. The DebridTV column still reflects the core only (most rows "not started"); it was **not yet updated for the app**. The app now plausibly covers: guide grid, stable channel numbers, OSD number, info banner, station breaks/slot padding, custom channels, hide channels, themes, pause→return to live, watched history, last channel, number entry. Each needs its row updated with evidence (screenshot or test), never declared from the presence of a guide.

## 6. Gotchas

- Live provider traffic runs only on Zachary's PC (RD treats cloud/VPS traffic as paid Remote Traffic). Never from the cloud container.
- Real-account actions beyond read-only, sharing, cloud relay, tuner export and any acquisition need Zachary's explicit go-ahead. Keys never go in the repo, logs or LOG.md.
- Node 22: `req.destroyed` is true after the body ends; use `res.destroyed` / `res.on("close")` in handlers.
- `pkill -f "node app/server.ts"` in the same shell command as a restart kills the shell itself; kill in a separate call.
- Lineup numbers persist in `lineup*.json`; delete the file in a test data dir to re-number.
- Browsers re-request media URLs; per-stream state on the server must be keyed (see `liveStarts` keyed by `tok`).
- Demo items have `provider: "demo"` and ids `demo-…`; the server never proxies them.

## 7. Suggested split (independent workstreams)

| Workstream | Owns | Goal |
|---|---|---|
| **A. Player & tuning** | `app/public/js/player.js`, `static.js`, `src/tuner/`, `experiments/exp002*`, `docs/decisions/` (new ADRs) | Slow-surf gap, compat-mode robustness, Chrome/Edge MKV checks, playback tests. |
| **B. Guide, breaks & look** | `app/public/js/guide.js`, `cards.js`, `ui.js`, `synth.js`, `main.js`, `styles.css`, `index.html` | Prevue-style breaks, guide polish, accessibility, phone/TV layouts, screenshot review. |
| **C. Library, sources & server** | `app/server.ts`, `app/library.ts`, `app/lineup.ts`, `app/store.ts`, `app/meters.ts`, `src/library/`, `src/providers/`, `app/public/js/panel.js` | RD rerun support (PICK), ETag edition research, scan/lineup tests, server smoke tests, settings tab. |
| **D. Parity & research log** | `docs/parity/`, `docs/experiments/LOG.md`, `README.md` | Update the 56-row register with evidence from A–C; keep the log current. Read-only on code. |

Shared contract between A/B and C: the JSON shapes of `/api/now`, `/api/guide` and `/api/bootstrap` (see `airingView`/`channelView` in `app/server.ts`). Changes to those go through C.
