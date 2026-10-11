# Handoff: round-5 polish (2026-10-11)

Branch `claude/project-thread-8sv8fc`, on PR #2 head `b62c1d9`. `npm test` 290/290, typecheck clean, app audit 28/28.
Screens: `/mnt/project-files/debridTV/screens/polish/` (32 seasonal presets, 33 guide scrolling setting).

## What shipped

- **N-01d, one copy per title** (`app/lineup.ts` `dedupeGroups`, `usableLibrary`, `showAliases`).
  Copies match on TMDB / IMDb / TVDB ids from the `.nfo` (`<uniqueid type=…>`, `<tmdbid>`, `<imdbid>`, a bare `<id>` only when it is `tt…`;
  an episode uses its show's ids from `tvshow.nfo`, `NfoMeta.showIds`) or the TMDB cache (`OnlineMetadata.tmdbId`, cache only), else on the
  parsed name (show + S/E, or title + year). Names never join copies whose ids disagree. Runtimes within max(2 min, 5%) are one cut
  (PAL speed-up), more is another edition (D4). Kept copy: local, playable, TorBox, Real-Debrid.
  - Every copy is kept: `/api/library/files` rows carry `copies [{id, provider, airs}]` (Library tab: "Also in TorBox. This copy airs.");
    On Demand items carry `sources`. A custom channel or group that picked any copy gets the one that airs.
  - One show under two names whose ids agree ("The Office" / "The Office (US)") becomes one channel, named after the name with more episodes.
  - **Behaviour change:** a copy a provider refused now keeps the whole title off the air and out of On Demand (E6, never fetched
    elsewhere). Before, the other provider's copy quietly aired.
  - Caveat: a TMDB-cache id comes from a name search, so two different shows with the same name could share one; runtime and ids from
    `.nfo` still keep most apart. `.nfo` ids always win.
- **N-02a, seasonal presets** (`SEASONAL_PRESETS`, `presetMatches`): October Horror (10-01..10-31), Holiday Classics (12-01..12-31),
  Summer Adventures (06-21..09-01). Matched by `.nfo` genre or tag, or a holiday word in the name. Offered at 3+ titles and 3+ hours.
  `GET /api/presets`, `POST /api/presets {id}` (PIN guard) saves content group `s-…` with `channel: true` and sets its N-32 season.
  Channels tab, "Seasonal channels". Demo gained three horror and three holiday films.
- **N-15, guide scrolling**: prefs `guideScroll` (smooth .22 s, slow .6 s, instant) and `guidePage` (3, 6, screen). Page Up/Down and a
  remote's Channel Up/Down turn the view a page. Look & feel, "Guide scrolling".
- **Runbook** step 9b in `pc-checks.md`: Fire TV Silk, an Android TV browser, Chromecast tab cast; what to record.

## Open

- Parity register (D): re-score N-01d (ids, not just names), N-02a (presets), N-15 (scroll option). Tests: `library.test` N-01d ×3,
  `metadata.test` N-01d, `presets.test` N-02a ×2, `test/ui/guide.test` N-15.
- Possible follow-ups: show the copies in the custom-channel builder lists (they still list each show key once per name).
