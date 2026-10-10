# NostalgiaTV parity register (versioned, per surface)

Register version: 0.1 | Retrieved: 2026-10-10 | Handoff basis: DEBRIDTV_RESEARCH_HANDOFF_2026-10-10.md sections 2.1, 3, 12.

NostalgiaTV's Play listing, GitBook user guide and Docker companion README describe different capability sets and different versions. This register is NOT one universal spec. Each cell is evidence about one surface at one version/date. No cell was verified by running the product.

## Labels

- **D** = documented present (source id in brackets). **P** = partial, ambiguous, or only implied by wording. **X** = documented absent or explicitly server-only/client-only elsewhere. **?** = no evidence found.
- Evidence version/date follows the source id, e.g. `D [N01, Play 2026-09-30]`. `Pro` = documented as paid-tier (Go Pro page, N11); `Pro?` = paid status implied only by changelog wording.
- No feature is inferred from screenshots or marketing adjectives; those are P. Short quotes only.
- Columns: **TV** = Android TV app; **Mobile** = Android phone/tablet app; **Docker** = `purestream711/nostalgiatv-server` web/companion; **Other** = Fire TV/Chromecast/iOS etc., only if documented.
- **DebridTV status** = "not started" for every row (to be updated by implementation).
- Note: the Play listing shows one app for Phone/TV/Tablet, and the GitBook does not separate TV from mobile except where noted. So TV and Mobile cells share evidence unless a source differentiates; that is a limit of the sources, not a finding that they are identical.

## Sources retrieved (2026-10-10)

| Id | URL | Version / date shown | Retrieval |
|---|---|---|---|
| N01 | https://play.google.com/store/apps/details?hl=en&id=com.nostalgiatv | "Updated on Sep 30, 2026"; no version number; 10K+ downloads; in-app purchases; Phone/TV/Tablet; 4.7 star (560) in header, 4.6 (269) elsewhere on page | Full (via raw HTML; WebFetch alone was truncated) |
| N02 | https://hub.docker.com/r/purestream711/nostalgiatv-server | Tag `latest` = `0.10.22-20261010-1812`, digest `sha256:d09ad584cc960726f18822dad5c6c9d5b49de70bfce76b70a4cd36ce92547d6e`, pushed 2026-10-10T18:39Z; 10K+ pulls; README names no version | Full (README via WebFetch; tags/digests via Docker Hub API) |
| N03 | https://nostalgiatv.gitbook.io/user-guide/basics/sorting-methods | No date, no version | Full |
| N04 | https://nostalgiatv.gitbook.io/user-guide/basics/settings/channel-customization/adding-a-custom-channel | No date, no version | Full. Page does NOT state a preset count (handoff said "older preset count"; not confirmed here) |
| N05 | https://nostalgiatv.gitbook.io/user-guide/advanced/web-ui/profile-configuration | No date, no version | Full |
| N06 | https://nostalgiatv.gitbook.io/user-guide/advanced/web-ui/content-groups | No date, no version | Full |
| N07 | https://nostalgiatv.gitbook.io/user-guide/basics/data-syncing-and-migration | No date, no version | Full |
| N08 | https://nostalgiatv.gitbook.io/user-guide/advanced/cloud-sync.md | No date, no version | Full |
| N09 | https://nostalgiatv.gitbook.io/user-guide/basics/settings/design-new | "Introduced in v0.5.13"; no date | Full |
| N10 | https://nostalgiatv.gitbook.io/user-guide/getting-started/changelog.md | Newest entry v0.9.12 dated 2026-07-22; 13 entries back to v0.3.17 (2026-02-21) | Full text fetched, but first ~7 KB per page read in detail; older entries only skimmed. Stale vs Docker 0.10.22 |
| N11 | https://nostalgiatv.gitbook.io/user-guide/getting-started/go-pro.md | No date | Full (text contains stray "[cite: N]" artifacts) |
| N12 | .../basics/settings/guide-schedule.md | No date | Full |
| N13 | .../advanced/web-ui/channel-and-content-management/advanced-scheduling-and-weighting.md | No date | Full |
| N14 | .../advanced/web-ui/docker.md | No date | Partial (first ~7 KB) |
| N15 | .../advanced/web-ui/local-files.md | No date; "This page needs review" banner | Partial |
| N16 | .../basics/settings/commercials.md and .../advanced/web-ui/{advanced,schedule}.md | No date | Partial |
| N17 | https://nostalgiatv.gitbook.io/user-guide/llms.txt (index) | No date | Full |

Not found / not retrieved: Reddit r/NostalgiaTV developer posts (search returned only a mirror about a different product, "Nostalgex"; not used). Secondary only: a Feb 2026 sponsored blog post (blog.lon.tv) and apkcombo mirror surfaced by search, not fetched; blog snippet claims Android-only at that time and a one-time ~$20 Pro, unverified here. Play "What's new" (N01, Sep 30 2026) covers: Kodi tvshow.nfo local-folder metadata, 16:9/4:3 display redesign, web Groups browse, Docker HDHomeRun/MPEG-TS playback fixes. Docker image tags seen: 0.10.13 (2026-09-29) through 0.10.22 (2026-10-10), roughly daily.

## Parity matrix

Order follows handoff N-01..N-28; suffix letters are splits; N-29+ are additions found in sources.

| Row | Capability | TV | Mobile | Docker | Other | DebridTV status |
|---|---|---|---|---|---|---|
| N-01a | Plex/Jellyfin/Emby servers, multiple at once | D [N01, 2026-09-30; N10 v0.9.12 2026-07-22 says full Jellyfin/Emby] | D [same] | D [N02, 0.10.22] | ? | not started |
| N-01b | Local device folders, no server needed | D [N01; N10 v0.9.12] | D [same] | X [N02: local-only libraries stay on Android] / P [N02 "mirror matching"] | ? | not started |
| N-01c | Local folder metadata (Kodi nfo, OMDb, artwork) | D [N10 v0.9.12 OMDb; N01 what's-new Kodi nfo] | D [same] | ? | ? | not started |
| N-01d | Cross-server dedup (TMDB/IMDb/TVDB, preference rank) | ? | ? | D [N02, N14; 0.10.22] | ? | not started |
| N-02a | Pre-built presets | D [N01: "85+" ; N11: "70+ Standard Channels", Pro] | D [same] | ? | ? | not started |
| N-02b | Custom channels | D [N04; N01] | D [N04 steps use mobile app] | D [N02 Channels tab] | ? | not started |
| N-03 | Channel number, name, logo | D [N04; N01 renumber/hide/favorite] | D [N04] | P [N02 lists Channels tab, no detail] | ? | not started |
| N-04 | Selection by collection/playlist/genre/decade/title | D [N04: Collection, Genre, Decade, Plex Playlist, search] | D [N04] | D [N02: also studios, labels, hand-picked] | ? | not started |
| N-05 | Specials, watched-only, duplicate controls | D [N04; watched-only worded as Plex watched] | D [N04] | ? | ? | not started |
| N-06a | Kid channel flag; R-rated after-hours restriction | D [N04] | D [N04] | D [N02 mature/kid filtering] | ? | not started |
| N-06b | PIN-locked restricted channels with scrambling visuals | D [N10 v0.9.12; Pro? ] | D [same] | D [N10 "Docker/web support"] | ? | not started |
| N-07 | Content groups, order/shuffle, EPG description | D [N06; web remote on desktop browser] | P [N06 silent on mobile/TV creation] | D [N02 Groups tab; N10 Groups browse] | ? | not started |
| N-08 | Ordering modes | D 8 modes [N03] | D 8 modes [N03] | D 4 modes only [N02] | ? | core only: all 8 labels have written, unit-tested DebridTV definitions (`src/clock/ordering.ts`); same intent, not verified identical; no UI |
| N-09a | Weights (0-100 sliders), time slots w/ weekday recurrence, restricted hours | D [N13, web UI advanced tab] | P [N13 is web UI] | D [N02 weights, time slots, restricted hours] | ? | not started |
| N-09b | Exclusions | P [N02 lists exclusions for Docker] | ? | D [N02] | ? | not started |
| N-09c | Premieres (recent additions pinned) | D [N13 premiere config] | P | D [N02] | ? | not started |
| N-09d | Recently-scheduled tracking / balance by episode count or duration | D [N13 balance; N02 recent tracking] | P | D [N02] | ? | not started |
| N-09e | Marathons | D [N04: 3% per check, 4 hours; N13: toggle raises probability] (conflicting wording) | D | D [N02 marathon insertion] | ? | not started |
| N-10 | Per-channel schedule regeneration | D [N10 v0.9.12; N04 Refresh Schedule] | D [same] | D [N02] | ? | core only: `revise()` keeps current airing and other channels (test C7) |
| N-11a | Built-in themes | D 9 [N01] / 5 [N09] / Modern=Pro [N10] | D [same] | D 8 [N02] | ? | not started |
| N-11b | Custom colors/fonts, theme import/export | D [N09 clone, edit, import/export] | D [N09] | D [N02 browser-editable] | ? | not started |
| N-12 | CRT effects, bezels, tuning sounds/screens | D [N01; N05 Classic CRT bezel option] | D [N10 v0.9.12 CRT/4:3 on mobile] | D CRT/bezel [N02]; tuning sounds ? | ? | not started |
| N-13 | Number-key tuning, guide navigation | D [N01 "type the channel number"] | P [no number-key claim; N10 D-pad/controller] | ? (web /watch) | ? | core only: cancel/dwell tuner measured on mock providers (EXP-002); no UI |
| N-14 | Hover tuning, startup choices, D-pad mapping | D [N05: auto-change channel, start on On Demand, swap D-pad] | D [N05; N10 mobile D-pad] | ? | ? | not started |
| N-15 | Guide display options (scroll, time indicator, dim ended, 24h clock, idle action) | D [N05] | D [N05] | ? | ? | not started |
| N-16 | Logo overlay mode/position/opacity, rating at start | D [N05] | D [N05] | ? | ? | not started |
| N-17a | Force 4:3 / widescreen zoom | D [N05; N01 what's-new 16:9/4:3] | D [N10 mobile 4:3] | ? | ? | not started |
| N-17b | Auto sign-off (up to 8 h), guide idle | D [N05] | D [N05] | ? | ? | not started |
| N-18a | Subtitle and audio-track / language options | D [N05] | D [N05] | D [N02 watch UI track selection] | ? | not started |
| N-18b | ExoPlayer vs libmpv, live switch | D [N05; N10 v0.9.12 live switching] | D [same] | X [engine is client-side; ? not stated] | ? | not started |
| N-19 | Direct play / transcode cap, DTS transcode, passthrough, delivery badges | D [N05; N10 v0.9.12; N01 4K/HDR/DV] | D [same] | ? | ? | not started |
| N-20 | Playback reporting; 90% watched threshold | D [N05] | D [N05] | ? | ? | core only: watched = actually-seen file time ≥ 90% (test D8) |
| N-21 | Commercials between/inside programs, bumpers, idents | D [N01; Pro per N11] | D [same] | D [N02, N14] | ? | not started |
| N-22a | Break groups/sequences, padding, per-channel pools | D [N01; N02] | D [N01] | D [N02] | ? | not started |
| N-22b | Mid-break: halfway / chapters | D [N01 "chapter"; N10] | D [same] | D [N02 HALFWAY, CHAPTERS] | ? | not started |
| N-22c | Mid-break: silence detection | X [N14: server-side only] | X [same] | D [N02 ffmpeg, Docker only] | ? | not started |
| N-23a | Music/radio ("Tune Choice") | D [N01; N10 new stations] | D [same] | D [N02 + visualizer] | ? | not started |
| N-23b | Weather channels (WeatherStar 4000, Storm) | D [N01 Storm; N10 EAS crawls] | D [same] | D [N02; Storm falls back to offline simulation] | ? | not started |
| N-23c | Trailers channel ("What's On") | D [N01; N10] | D | D [N02] | ? | not started |
| N-24a | Plex / Jellyfin / Emby Live TV imports | D [N01; N02] | D [N01] | D [N02 EPG] | ? | not started |
| N-24b | M3U / XMLTV / HDHomeRun imports | D [N01; N10 editable sources] | D [same] | D [N02 External Sources, browser refresh] | ? | not started |
| N-24c | Live stream channels from URL (.m3u8) | D [N04] | D [N04] | D [N02] | ? | not started |
| N-25 | Cloud schedule/config sync via user-owned Firebase | D schedule only [N08]; config sync Pro [N10 v0.5.x, N11] | D [same] | ? | ? | not started |
| N-26a | Full-snapshot vs lineup-only config export/import | D [N07] | D [N07] | D [N02 per-profile or whole server; tokens excluded] | ? | not started |
| N-26b | Local pairing by 4-digit PIN (same Wi-Fi) | D [N07] | D [N07] | ? | ? | not started |
| N-26c | Primary/follower (cloud sync) | D [N07] | D [N07] | ? | ? | not started |
| N-26d | Docker pairing code onboarding | D [N10 v0.9.12] | D [same] | D [same] | ? | not started |
| N-27a | Browser UI (watch + configure) | X (TV app itself) / D web remote [N06, N07] | D [N01 web interface] | D [N02 ports 19850 /watch /configure] | ? | not started |
| N-27b | Long-horizon schedule | P 8h default, up to ~1 week "Extended" [N12]; Play says nothing | P [same] | D 30 d default, 24-2160 h [N02] | ? | not started |
| N-27c | Scheduled automatic backups | ? | ? | D [N02 weekly, one-click restore] | ? | not started |
| N-28 | HDHomeRun/IPTV tuner export | P [N01 "Acts as a tuner" via companion] | P | D [N02; unauthenticated by default, disable with HDHR_ENABLED=false] | ? | gate only: `tuner-export` gate exists, default closed; no export built |
| N-29 | Multi-profile (up to 6, kid/adult, PIN, Plex Home link) | D Pro [N11, N01] | D Pro [same] | D [N02] | ? | not started |
| N-30 | On Demand browse, search, voice search, Continue Watching, rent-mode channels | D [N10 v0.9.12; N01] | D [same] | D [N02 On Demand, Continue Watching; rent/voice ?] | ? | not started |
| N-31 | Chromecast | ? | D [N01; N10 v0.5.16] | ? | Chromecast: D [N01 "from compatible mobile devices"] | not started |
| N-32 | Seasonal lineups (Oct-Dec holiday) | D [N01 marketing claim] -> mark P | P | ? | ? | not started |
| N-33 | Fire TV support | ? | ? | ? | Fire TV: P [N10 mentions Fire TV stability fixes only; no listing] | not started |
| N-34 | iOS / Apple TV / Roku / web-only client | ? | ? | P [browser /watch] | iOS: ? | not started |
| N-35 | Join programs in progress | D [N01 marketing claim] -> P | P | ? | ? | not started |
| N-36 | Weather EAS alert crawls | D [N10 v0.9.12] | D | ? | ? | not started |
| N-37 | Stream/delivery status badges, HDR/audio badges | D [N10; N01] | D | ? | ? | not started |
| N-38 | Pro entitlement gating (profiles, themes, commercials, cloud sync, 70+ channels, On Demand layout) | D [N11] | D [N11] | ? entitlement for Docker not stated | ? | not started |

Reading notes: a cell like "D x / P y" means sources disagree on that surface; see Discrepancies. N-32 and N-35 are advertising claims without GitBook mechanics, so downgraded to P. "?" in the Docker column often just means the README is silent; the server may share the feature.

## Discrepancies

1. **Preset channel count.** 85+ [N01 Play, 2026-09-30] vs 70+ "Standard Channels" [N11 Go Pro, undated]. The handoff attributed 70-plus to N04; N04 as retrieved gives no count.
2. **Sorting algorithms.** 8 modes [N03, undated] vs 4 [N02, 0.10.22: RANDOM, CYCLIC_SHUFFLE, BLOCK_SHUFFLE, BLOCK_CYCLIC]. N13 names "Cyclic Shuffle" which is not among N03's eight names; N03 lacks that label. Marathon/Round-Robin availability on Docker is undocumented, not documented absent.
3. **Theme count.** 9 incl. frosted Glass [N01] vs 8 without Glass [N02] vs 5 built-ins [N09, introduced v0.5.13] vs Modern added later as Pro [N10 v0.6.x].
4. **Schedule horizon.** 8-hour default blocks [N03, N08, N12] vs up to one week "Extended" [N12, N16 Advanced] vs 30 days default, 24 h to 2160 h (90 d) [N02] vs 30-day background generation [N10 v0.9.12]. N01 says only "24/7".
5. **Media server scope.** GitBook settings pages say Plex only ("Plex library", N04, N12, N16) vs Plex/Jellyfin/Emby/local [N01, N10 v0.9.12 2026-07-22, N02]. Pages predate July 2026 or were not updated.
6. **Marathon mechanics.** 3% chance per check, plays one show 4 hours [N04] vs a toggle that raises back-to-back probability for "consecutive hours" [N13].
7. **Cloud sync scope.** Schedule only; settings/themes stay local [N08] vs syncs settings, channels, schedules, commercials, themes [N10 v0.5.16] and "theme hex palettes" [N11]. Cloud sync is Pro per N11 yet N08 says setup costs nothing.
8. **Silence-detected breaks.** Offered in app wording [N01 "chapter or silence-detected breaks"] vs server-only [N02, N14].
9. **Local libraries vs Docker.** Android-only standalone local libraries [N02] vs "Full Platform Parity ... complete web remote parity" [N10 v0.9.12].
10. **Documentation staleness.** Changelog newest = v0.9.12 (2026-07-22) [N10] while Docker is 0.10.22 (2026-10-10) [N02] and the Play listing updated 2026-09-30 [N01]. Play app version string is not shown anywhere. Play header rating 4.7/560 vs 4.6/269 in the body.
11. **Free vs Pro.** N01 lists nine themes and commercials without a paid flag; N11 and N10 mark themes, commercials, profiles, cloud sync as Pro. Entitlement for Docker is undocumented.
12. **Tuner security.** HDHR endpoints unauthenticated by default [N02] while all `/api/*` require key/session; a parity feature with a security cost.

## Versions found

- Play listing updated 2026-09-30 (app version string not shown); changelog entries v0.3.17 (2026-02-21) through v0.9.12 (2026-07-22); Docker `latest` = 0.10.22-20261010-1812 (digest above); N09 theme page cites v0.5.13.
- Pin Docker by digest, not `latest`, for any acceptance baseline (tag moves roughly daily).
