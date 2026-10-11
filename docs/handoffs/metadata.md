# Handoff: online posters and descriptions (TMDB), 2026-10-11

Branch `claude/project-thread-jmyyxx`, on top of release `14f0a5e`.

## What exists
- `app/metadata/tmdb.ts`: `OnlineMetadata`. Off until a key is saved (`tmdb-key.json` in the data folder, owner-only, never exported or sent to the browser). A v3 key goes as `api_key`, a v4 token (starts `eyJ`) as a Bearer header.
- Sends only: show name, film title, year, season number (`queryFor`). Never file names, folders, provider links or history.
- Per show: search, logo list, one request per season with episodes lacking text, then poster (w500), backdrop (w1280), clear logo (PNG). Per film: search, poster, backdrop. Cache `metadata/tmdb.json`, pictures `metadata/img/<media>-<id>-<kind>.<ext>`. Misses are retried after 30 days, errors after 15 min, 401 stops all lookups, 429 waits Retry-After and tries once more. 250 ms between requests.
- Server hooks in `app/server.ts` (small): `artView` adds TMDB kinds after local ones; `/api/art/:id/:kind` serves local first, then the cache; `airingView` description = nfo plot ?? TMDB (episode overview, else show overview) and subtitle = nfo title ?? TMDB episode name; `rebuild()` runs `online.sync(liveItems, lockedItem)` outside demo mode; `/api/forget` deletes key, cache and pictures. Remote items (TorBox, RD) get art too, not only local files.
- API: `GET /api/metadata` → `{enabled, keySet, state: off|idle|working|paused|rejected, message, titles, withPictures, waiting, requests, bytes, lastError?, attribution}`. `POST /api/metadata {key}` checks the key with TMDB (`/configuration`, one request) and saves it; `{key: null}` turns it off (hides TMDB content, keeps the cache).
- UI: `app/public/js/online.js` (Sources tab card with the TMDB credit, Privacy tab line); two hook lines in `panel.js`.
- Tests: `test/tmdb.test.ts` (5) against `test/tmdb-mock.ts` + `test/fixtures/tmdb/responses.json` (shapes from TMDB's docs, fictional titles; not recorded from the live API, since no key is used in the cloud).
- Screens: `/mnt/project-files/debridTV/screens/metadata/`.

## Open
- Real-key check on Zachary's PC: runbook step 8.
- TMDB's attribution guidelines also ask for their logo; the credit is text plus a link for now.
- Not fetched: episode stills, genres, ratings/certifications, OMDb. Language is fixed at en-US (`language` in tmdb-key.json is read but has no UI).
- Shows whose file names carry no year can match a same-named remake; the picker prefers an exact title, then year, then TMDB's order.
