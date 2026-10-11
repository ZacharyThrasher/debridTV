# NostalgiaTV parity register (versioned, per surface)

Register version: 0.4 | NostalgiaTV sources retrieved: 2026-10-10 | DebridTV column audited: 2026-10-11 (round 3) against the shared release `97666b5` | Handoff basis: DEBRIDTV_RESEARCH_HANDOFF_2026-10-10.md sections 2.1, 3, 12.

NostalgiaTV's Play listing, GitBook user guide and Docker companion README describe different capability sets and different versions. This register is NOT one universal spec. Each cell is evidence about one surface at one version/date. No cell was verified by running the product.

## Labels

- **D** = documented present (source id in brackets). **P** = partial, ambiguous, or only implied by wording. **X** = documented absent or explicitly server-only/client-only elsewhere. **?** = no evidence found.
- Evidence version/date follows the source id, e.g. `D [N01, Play 2026-09-30]`. `Pro` = documented as paid-tier (Go Pro page, N11); `Pro?` = paid status implied only by changelog wording.
- No feature is inferred from screenshots or marketing adjectives; those are P. Short quotes only.
- Columns: **TV** = Android TV app; **Mobile** = Android phone/tablet app; **Docker** = `purestream711/nostalgiatv-server` web/companion; **Other** = Fire TV/Chromecast/iOS etc., only if documented.
- **DebridTV status** is scored only from behaviour that a test or the app audit exercised, never from code or a guide existing:
  - **V** verified: an audit check (`[A01]`…, see [App audit](#app-audit)) or a named test passes.
  - **P/V** partly there, and the part that exists is verified. **P** partly there, evidence is a unit test or code only.
  - **C** core only: the clock or library supports it and is unit-tested, but the app doesn't use it.
  - **G** gate: a closed permission gate exists; nothing is built behind it.
  - **(branch)** evidence lives on a thread branch not yet merged into `claude/debridtv-rnd-9768mu`.
  - **—** not started. **N/A** doesn't apply to a personal app.
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

| Row | Capability | TV | Mobile | Docker | Other | DebridTV status (2026-10-11) |
|---|---|---|---|---|---|---|
| N-01a | Plex/Jellyfin/Emby servers, multiple at once | D [N01, 2026-09-30; N10 v0.9.12 2026-07-22 says full Jellyfin/Emby] | D [same] | D [N02, 0.10.22] | ? | — not started. Sources are Real-Debrid, TorBox and local folders instead (different source model, by project scope). |
| N-01b | Local device folders, no server needed | D [N01; N10 v0.9.12] | D [same] | X [N02: local-only libraries stay on Android] / P [N02 "mirror matching"] | ? | **V** local folders become channels after a header scan [A13]. |
| N-01c | Local folder metadata (Kodi nfo, OMDb, artwork) | D [N10 v0.9.12 OMDb; N01 what's-new Kodi nfo] | D [same] | ? | ? | **P/V** local only, all tested: Kodi `.nfo` for movies, episodes and shows (`metadata.test` N-01c ×3); local stills, posters, fanart and show logos, served without exposing paths (`art.test` N-01c ×3, `test/ui` artwork). Online (approved by Zachary 2026-10-11): TMDB posters, backdrops, show logos, show/film/episode descriptions and episode names fill only what local files lack; off without the viewer's own key; only titles, years and season numbers sent; cached on disk; PIN-locked items skipped (`tmdb.test` N-01c online ×5, against a mock). Real-key check pending (PC runbook step 8). No OMDb. |
| N-01d | Cross-server dedup (TMDB/IMDb/TVDB, preference rank) | ? | ? | D [N02, N14; 0.10.22] | ? | **P/V** same file in two places airs once [A15]; keyed on parsed name + runtime, not TMDB/IMDb ids; rank local > playable > TorBox > RD (`app/lineup.ts` dedupe). |
| N-02a | Pre-built presets | D [N01: "85+" ; N11: "70+ Standard Channels", Pro] | D [same] | ? | ? | **P/V** 7 automatic channel rules (Half Hour, Prime Hour, Marathon, Feature, Quarter Hour, decade cinema, one per show) [A01 demo, A14 local]; NTV claims 70-85+ presets. |
| N-02b | Custom channels | D [N04; N01] | D [N04 steps use mobile app] | D [N02 Channels tab] | ? | **V** builder with show/movie picks, 8 orderings, slot choice; goes on air at #50+ [A09, A18]. |
| N-03 | Channel number, name, logo | D [N04; N01 renumber/hide/favorite] | D [N04] | P [N02 lists Channels tab, no detail] | ? | **V** number + name on bug and OSD [A02]; numbers stable across restart, hiding and a channel returning [A11, A19, `library.test` N-03]; rename, renumber (a taken number swaps), favorite and logo stored and editable (`server.test` N-03/N-16, `test/ui` channel editor). |
| N-04 | Selection by collection/playlist/genre/decade/title | D [N04: Collection, Genre, Decade, Plex Playlist, search] | D [N04] | D [N02: also studios, labels, hand-picked] | ? | **V** network, genre and collection channels from metadata with thresholds (`metadata.test` N-04); decade channels [A01]; pick by title [A18]. No Plex playlists (no Plex source). |
| N-05 | Specials, watched-only, duplicate controls | D [N04; watched-only worded as Plex watched] | D [N04] | ? | ? | **P/V** duplicates removed [A15, D3]; season-0 specials per channel (`bc06cbc`); watched rule all / unwatched only / resume after last watched (Mix tab, `test/ui` "Mix tab saves…"; no unit test of the rule itself yet). |
| N-06a | Kid channel flag; R-rated after-hours restriction | D [N04] | D [N04] | D [N02 mature/kid filtering] | ? | **V** kid channels air only ≤PG, unrated stays off; restricted hours keep higher ratings out and nothing straddles the edge (`dayparts.test` N-06a ×2, `server.test` N-06a). |
| N-06b | PIN-locked restricted channels with scrambling visuals | D [N10 v0.9.12; Pro? ] | D [same] | D [N10 "Docker/web support"] | ? | **V** scrypt-hashed PIN, slowed guesses, 4 h unlock; locked channels cost 0 bytes and 0 calls until unlocked, guide/banner/breaks redacted, picture scrambled (`pinlock.test`, `server.test` N-06b ×6, `test/ui` locked channels ×2, `test/ui/player` N-06b). |
| N-07 | Content groups, order/shuffle, EPG description | D [N06; web remote on desktop browser] | P [N06 silent on mobile/TV creation] | D [N02 Groups tab; N10 Groups browse] | ? | — not started. |
| N-08 | Ordering modes | D 8 modes [N03] | D 8 modes [N03] | D 4 modes only [N02] | ? | **V** all 8 modes unit-tested (F2 in `test/clock.test.ts`) and offered in the builder [A09]. Same intent as NTV, not verified identical. |
| N-09a | Weights (0-100 sliders), time slots w/ weekday recurrence, restricted hours | D [N13, web UI advanced tab] | P [N13 is web UI] | D [N02 weights, time slots, restricted hours] | ? | **V** weights (0 never airs) (`mix.test` N-09a), weekday time slots and restricted hours (`dayparts.test` N-09a, N-06a), set in the channel editor and Mix tab. |
| N-09b | Exclusions | P [N02 lists exclusions for Docker] | ? | D [N02] | ? | **V** per-file exclude, reversible (`server.test`); genre exclusions and "keep off the air" in the Mix tab (`test/ui` channel mix and exclusions); excluded files never air (`library.test` B5/E6). |
| N-09c | Premieres (recent additions pinned) | D [N13 premiere config] | P | D [N02] | ? | **V** premieres air first, once each (`mix.test` N-09c). |
| N-09d | Recently-scheduled tracking / balance by episode count or duration | D [N13 balance; N02 recent tracking] | P | D [N02] | ? | **V** balance by airtime or by turns (`mix.test` N-09d); round-robin turns (F2). |
| N-09e | Marathons | D [N04: 3% per check, 4 hours; N13: toggle raises probability] (conflicting wording) | D | D [N02 marathon insertion] | ? | **V** marathons inside a mix stay on one show up to their length, then the mix resumes (`mix.test` N-09e); dedicated Marathon channel [A01]. |
| N-10 | Per-channel schedule regeneration | D [N10 v0.9.12; N04 Refresh Schedule] | D [same] | D [N02] | ? | **V** reshuffle a channel from the Mix tab (`test/ui` "…and reshuffles"); changes wait for the current airing to end (C7). |
| N-11a | Built-in themes | D 9 [N01] / 5 [N09] / Modern=Pro [N10] | D [same] | D 8 [N02] | ? | **V** 3 built-ins: Midnight, Cable '92, Daylight [A07]. |
| N-11b | Custom colors/fonts, theme import/export | D [N09 clone, edit, import/export] | D [N09] | D [N02 browser-editable] | ? | **V** theme editor: build, apply live, save, cancel restores; import/export (`test/ui` themes N-11b ×2, `93b9d1d`). |
| N-12 | CRT effects, bezels, tuning sounds/screens | D [N01; N05 Classic CRT bezel option] | D [N10 v0.9.12 CRT/4:3 on mobile] | D CRT/bezel [N02]; tuning sounds ? | ? | **V** CRT, static, tuner sounds [A08]; optional TV set (plastic or wood console with a VHF dial) (`test/ui` TV set N-12). |
| N-13 | Number-key tuning, guide navigation | D [N01 "type the channel number"] | P [no number-key claim; N10 D-pad/controller] | ? (web /watch) | ? | **V** number entry [A02], up/down, last channel [A03], guide arrows [A05, A06]; fast surfing requests media only where it lands [A25] (cost measured in EXP-002/006). |
| N-14 | Hover tuning, startup choices, D-pad mapping | D [N05: auto-change channel, start on On Demand, swap D-pad] | D [N05; N10 mobile D-pad] | ? | ? | **P/V** start on last channel [A10] or the guide, guide idle action (`test/ui`); full remote/D-pad navigation in TV mode (`test/ui` remote 10-foot). No hover-tune. |
| N-15 | Guide display options (scroll, time indicator, dim ended, 24h clock, idle action) | D [N05] | D [N05] | ? | ? | **P/V** 12 h grid, now line, 24-hour clock [A05, A06, A08]; aired-part shading, picture-in-guide, padding tails, idle action (`test/ui` guide). No scroll-speed option. |
| N-16 | Logo overlay mode/position/opacity, rating at start | D [N05] | D [N05] | ? | ? | **V** channel bug with corner and opacity settings, logos, rating card at program start (`fc8f20b`, `7e3bc92`; `server.test` N-03/N-16) [A02]. |
| N-17a | Force 4:3 / widescreen zoom | D [N05; N01 what's-new 16:9/4:3] | D [N10 mobile 4:3] | ? | ? | **V** Z cycles auto, fill, 4:3 and zoom [A28]. |
| N-17b | Auto sign-off (up to 8 h), guide idle | D [N05] | D [N05] | ? | ? | **V** "Still watching?" after the idle limit, then streaming stops and a key returns to live (`test/ui/player` N-17b ×2). |
| N-18a | Subtitle and audio-track / language options | D [N05] | D [N05] | D [N02 watch UI track selection] | ? | **P/V** compatibility stream plays the chosen audio track and sends text subtitles beside it, image subtitles burned in (`compat.test` N-18a); A/C keys choose audio and captions (`4543139`). Track choice isn't driven in a browser test yet. |
| N-18b | ExoPlayer vs libmpv, live switch | D [N05; N10 v0.9.12 live switching] | D [same] | X [engine is client-side; ? not stated] | ? | **P (different design)** browser player with one direct → compatibility fallback, never a loop [A20, A24]; no engine choice. |
| N-19 | Direct play / transcode cap, DTS transcode, passthrough, delivery badges | D [N05; N10 v0.9.12; N01 4K/HDR/DV] | D [same] | ? | ? | **P/V** direct play [A20]; compatibility mode for undecodable audio [A24] with track choice and subtitle burn-in (`compat.test`). No transcode cap or passthrough. |
| N-20 | Playback reporting; 90% watched threshold | D [N05] | D [N05] | ? | ? | **V** seen file time is reported [A22]; watched flips between 85% and 92% [A23]; D8; mark/forget/export history (`server.test` history). |
| N-21 | Commercials between/inside programs, bumpers, idents | D [N01; Pro per N11] | D [same] | D [N02, N14] | ? | **P/V (by design)** no commercials or bumpers (they'd fetch media nobody asked for). Long breaks rotate up next / later / on now elsewhere plus a station ident slide, 0 media requests (`test/ui` station breaks). |
| N-22a | Break groups/sequences, padding, per-channel pools | D [N01; N02] | D [N01] | D [N02] | ? | **P/V** slot padding becomes a station break [A16]; no break groups or per-channel pools. |
| N-22b | Mid-break: halfway / chapters | D [N01 "chapter"; N10] | D [same] | D [N02 HALFWAY, CHAPTERS] | ? | **V** chapters become mid-program breaks where they fit the slot [A17; `server.test` N-22b; MKV and MP4 chapters]. No halfway mode for files without chapters (by design: breaks aren't guessed). |
| N-22c | Mid-break: silence detection | X [N14: server-side only] | X [same] | D [N02 ffmpeg, Docker only] | ? | — not started. |
| N-23a | Music/radio ("Tune Choice") | D [N01; N10 new stations] | D [same] | D [N02 + visualizer] | ? | — not started. |
| N-23b | Weather channels (WeatherStar 4000, Storm) | D [N01 Storm; N10 EAS crawls] | D [same] | D [N02; Storm falls back to offline simulation] | ? | — not started. |
| N-23c | Trailers channel ("What's On") | D [N01; N10] | D | D [N02] | ? | — not started. |
| N-24a | Plex / Jellyfin / Emby Live TV imports | D [N01; N02] | D [N01] | D [N02 EPG] | ? | — not started. |
| N-24b | M3U / XMLTV / HDHomeRun imports | D [N01; N10 editable sources] | D [same] | D [N02 External Sources, browser refresh] | ? | — not started. |
| N-24c | Live stream channels from URL (.m3u8) | D [N04] | D [N04] | D [N02] | ? | — not started. |
| N-25 | Cloud schedule/config sync via user-owned Firebase | D schedule only [N08]; config sync Pro [N10 v0.5.x, N11] | D [same] | ? | ? | — not started. Any cloud path sits behind the closed `cloud-relay` gate. |
| N-26a | Full-snapshot vs lineup-only config export/import | D [N07] | D [N07] | D [N02 per-profile or whole server; tokens excluded] | ? | **V** export of settings or channels only, never keys or the PIN hash; lineup round-trips without stealing numbers (`server.test` F4, N-06b; `library.test` F4; `64a0382`). |
| N-26b | Local pairing by 4-digit PIN (same Wi-Fi) | D [N07] | D [N07] | ? | ? | — not started (needs the `sharing` gate). |
| N-26c | Primary/follower (cloud sync) | D [N07] | D [N07] | ? | ? | — not started. |
| N-26d | Docker pairing code onboarding | D [N10 v0.9.12] | D [same] | D [same] | ? | — not applicable yet (no companion server). |
| N-27a | Browser UI (watch + configure) | X (TV app itself) / D web remote [N06, N07] | D [N01 web interface] | D [N02 ports 19850 /watch /configure] | ? | **V** watch and configure in one browser page on 127.0.0.1 [A01-A27]. |
| N-27b | Long-horizon schedule | P 8h default, up to ~1 week "Extended" [N12]; Play says nothing | P [same] | D 30 d default, 24-2160 h [N02] | ? | **V** schedule is computed, so any horizon is free: 12 h guide costs 0 calls [A05], the airing 3 h ahead is identical across restarts [A12], 100 ch × 30 d = 0 calls (EXP-001). |
| N-27c | Scheduled automatic backups | ? | ? | D [N02 weekly, one-click restore] | ? | **V** daily settings backups, listed, trimmed, restorable, no keys inside (`server.test` N-27c). |
| N-28 | HDHomeRun/IPTV tuner export | P [N01 "Acts as a tuner" via companion] | P | D [N02; unauthenticated by default, disable with HDHR_ENABLED=false] | ? | **G** `tuner-export` gate exists, closed by default (test "gates default closed"); nothing built behind it. |
| N-29 | Multi-profile (up to 6, kid/adult, PIN, Plex Home link) | D Pro [N11, N01] | D Pro [same] | D [N02] | ? | — not started. |
| N-30 | On Demand browse, search, voice search, Continue Watching, rent-mode channels | D [N10 v0.9.12; N01] | D [same] | D [N02 On Demand, Continue Watching; rent/voice ?] | ? | — not started. |
| N-31 | Chromecast | ? | D [N01; N10 v0.5.16] | ? | Chromecast: D [N01 "from compatible mobile devices"] | — not started. |
| N-32 | Seasonal lineups (Oct-Dec holiday) | D [N01 marketing claim] -> mark P | P | ? | ? | — not started. |
| N-33 | Fire TV support | ? | ? | ? | Fire TV: P [N10 mentions Fire TV stability fixes only; no listing] | — not started. |
| N-34 | iOS / Apple TV / Roku / web-only client | ? | ? | P [browser /watch] | iOS: ? | **P/V** any desktop browser; phone-width guide fits [A26]; TV mode for a big screen with a remote (`test/ui` remote 10-foot). Other devices can't reach it: the server binds 127.0.0.1 and LAN access is the `sharing` gate. |
| N-35 | Join programs in progress | D [N01 marketing claim] -> P | P | ? | ? | **V** tuning lands at station time, 0.1-0.15 s drift [A20]; pause 5 s then resume returns to live [A21]; C2/C3 tests. |
| N-36 | Weather EAS alert crawls | D [N10 v0.9.12] | D | ? | ? | — not started. |
| N-37 | Stream/delivery status badges, HDR/audio badges | D [N10; N01] | D | ? | ? | **V** banner badges for live, break, watched, refused, route, provider, rating [A04, A24], plus resolution, HDR and sound chips (`test/ui` format chips N-37, `probe.test` N-37). |
| N-38 | Pro entitlement gating (profiles, themes, commercials, cloud sync, 70+ channels, On Demand layout) | D [N11] | D [N11] | ? entitlement for Docker not stated | ? | **N/A** personal app with no paid tier. |

Reading notes: a cell like "D x / P y" means sources disagree on that surface; see Discrepancies. N-32 and N-35 are advertising claims without GitBook mechanics, so downgraded to P. "?" in the Docker column often just means the README is silent; the server may share the feature.

## Scoreboard (2026-10-11, round 3: release `97666b5`)

61 rows. **V 28 · P/V 11 · P 1 · G 1 · not started 18 · N/A 2.**

39 rows now have tested behaviour in the app (round 2: 32, round 1: 22), 28 of them fully. The round-2 gaps all landed with tests: auto sign-off, audio/subtitle choice in compatibility mode, PIN-locked channels, weights/premieres/marathons/balance/reshuffle, theme editor, TV set bezel, rating card, format chips, daily backups and channels-only export. The playback checks A20/A21/A25 now also run in `npm test` (`test/ui/player.test.ts`).

What's left is mostly whole product areas rather than missing switches: content groups, On Demand and Continue Watching, profiles, seasonal lineups, and the non-library channel types (music, trailers, weather, live/M3U), several of which depend on Zachary's decisions about outside traffic and LAN access.

## App audit

`docs/parity/audit/app-audit.mjs` starts the real app in a throwaway data folder, generates local test media with ffmpeg (no provider traffic, safe in the cloud), and drives it in Chromium. Results and screenshots land in [`evidence/`](evidence/). Re-run after any merge:

```sh
NO_PROXY=127.0.0.1 node docs/parity/audit/app-audit.mjs
```

| Run (2026-10-11) | Tree | Result |
|---|---|---|
| Round 1 | shared `d68292c` | 26/27 (A17 failed) |
| Round 1 | trial merge with C `y7lgyq` + B `uy3380` | 25/27, then 26/27 once C added the Library tab (A27) |
| Round 2 | trial merge with C `446sg8` `6ed75dd` + B `uy3380` `f5aca03` | 27/27 audit, but `npm test` 165/166: the channel editor crashed on `logo: null` (reported; fixed by B's `2b17a5c`) |
| Round 2 | shared `cffbc0d` + C `446sg8` `4a73787` (local merge `68985ad`) | 28/28 ([app-audit-merged.json](evidence/app-audit-merged.json)); `npm test` 169/169 |
| **Round 3** | **shared release `97666b5`** | **28/28** ([app-audit.json](evidence/app-audit.json)); `npm test` **214/214** |

| Check | What it proves | Rows | Latest |
|---|---|---|---|
| A01 | demo lineup on air with no source | N-02a | ✅ |
| A02 | number keys tune; bug shows number + name | N-13, N-03 | ✅ |
| A03 | channel up, then L returns to the previous channel | N-13 | ✅ |
| A04 | info banner: title, times, what's next, badges | N-15, N-37 | ✅ |
| A05 | browsing the guide 12 h ahead across all rows makes 0 media or link requests | N-15, N-27b | ✅ |
| A06 | a guide row per channel, plus a now line | N-15 | ✅ |
| A07 | three themes apply | N-11a | ✅ |
| A08 | CRT, static, tuner sounds, 24-hour clock are settings | N-12, N-15 | ✅ |
| A09 | builder offers all 8 orderings | N-08, N-02b | ✅ |
| A10 | reload starts on the last channel | N-14 | ✅ |
| A11 | channel numbers survive a restart | N-03 | ✅ |
| A12 | the airing 3 h ahead is identical across a restart | N-27b, N-35 | ✅ |
| A13 | local folders become channels after a header scan | N-01b | ✅ |
| A14 | show channel at #10+, Quarter Hour at #6 | N-03 | ✅ |
| A15 | the same episode in two folders airs once | N-01d, N-05 | ✅ |
| A16 | slot padding: programs start on the quarter hour, the rest is a break | N-22a | ✅ |
| A17 | a file with a chapter at 4:00 gets a mid-program break | N-22b | ✅ |
| A18 | custom channels go on air at #50+ | N-02b, N-03 | ✅ |
| A19 | hiding a channel keeps every other number | N-03 | ✅ |
| A20 | tuning in lands at station time (direct play; drift ~0.1 s) | N-35 | ✅ |
| A21 | pause 5 s inside a program, resume is back at live | N-35 | ✅ |
| A22 | real playback is reported as seen time | N-20 | ✅ |
| A23 | watched flips between 85% and 92% seen, and shows in the guide | N-20 | ✅ |
| A24 | an AC-3 file plays through compatibility mode, labelled in the banner | N-19, N-37 | ✅ |
| A25 | six fast presses request media only for the landing channel | N-13 | ✅ |
| A26 | phone-width guide has no horizontal overflow | N-34 | ✅ |
| A27 | every settings tab renders | — | ✅ |
| A28 | Z cycles the picture shape, including 4:3 | N-17a | ✅ |

Limits: local files only (C's `createApp` tests in `test/server.test.ts` cover the provider paths against the mock providers), Chromium without H.264, and A25 may land on a channel in a break, so it shows no stray streams rather than the cost of the final tune (EXP-002/006 measure that). Rows also cite unit and browser tests by name (`test/ui/guide.test.ts`, `test/dayparts.test.ts`, `test/metadata.test.ts`, `test/server.test.ts`, `test/library.test.ts`).

## Gaps, ranked (2026-10-11, round 3)

Owner = workstream from `docs/HANDOFF.md` §7. Items that need Zachary are listed separately.

| # | Gap | Rows | Owner | Why it matters |
|---|---|---|---|---|
| 1 | Content groups: named sets of shows/films with their own order and guide description, usable to build channels | N-07 | C (+ B UI) | NTV's main way to organise big libraries; today only channel-by-channel picks. |
| 2 | Seasonal lineups: channels or slots active only between dates (October horror, December holidays) | N-32 | C (dayparts by date) + B | Small extension of the existing slot/window clock; very on-theme. |
| 3 | Trailers channel from local `-trailer` files (Kodi naming) | N-23c | C | Free with local files; no outside traffic. |
| 4 | Continue Watching / On Demand browse and search | N-30 | B + C | History and resume data exist; nothing lets you pick a program outside the live lineup. Costs media only when picked. |
| 5 | Unit test for watched rules (unwatched only, resume) | N-05 | C | Rule ships and is in the UI but has no direct test. |
| 6 | Browser test for audio/caption choice | N-18a | A | Server side is tested; the A/C keys aren't driven in a browser test. |
| 7 | Music channel from local audio files, with a visualiser | N-23a | C + A | Library-first fit; bytes only while listening. |
| 8 | Silence-detected breaks for local files only | N-22c | C | Free for local files (no provider bytes); never for debrid files, which would mean reading unwatched media. |
| 9 | Hover-tune in the guide: decide and record | N-14 | B | Real hover-tune opens media while browsing and breaks the zero-cost guide (A05). Recommend: decline, or preview from the clock only. |
| 10 | Transcode cap / audio passthrough | N-19 | A | Low: compatibility mode already covers what the browser can't play. |

Needs Zachary: profiles with separate history (N-29, low effort but a product choice), LAN/phone/Chromecast/Fire TV access (`sharing` gate: N-34, N-26b/c, N-31, N-33), Plex/Jellyfin/Emby sources (N-01a, N-24a), live streams and M3U/XMLTV (N-24b/c), weather and EAS (N-23b, N-36), cloud sync (N-25), tuner export (N-28).

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
