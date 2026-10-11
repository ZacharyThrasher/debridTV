# NostalgiaTV parity register (versioned, per surface)

Register version: 0.2 | NostalgiaTV sources retrieved: 2026-10-10 | DebridTV column audited: 2026-10-11 against shared branch `d68292c` and a trial merge with branches `project-thread-y7lgyq` and `project-thread-uy3380` | Handoff basis: DEBRIDTV_RESEARCH_HANDOFF_2026-10-10.md sections 2.1, 3, 12.

NostalgiaTV's Play listing, GitBook user guide and Docker companion README describe different capability sets and different versions. This register is NOT one universal spec. Each cell is evidence about one surface at one version/date. No cell was verified by running the product.

## Labels

- **D** = documented present (source id in brackets). **P** = partial, ambiguous, or only implied by wording. **X** = documented absent or explicitly server-only/client-only elsewhere. **?** = no evidence found.
- Evidence version/date follows the source id, e.g. `D [N01, Play 2026-09-30]`. `Pro` = documented as paid-tier (Go Pro page, N11); `Pro?` = paid status implied only by changelog wording.
- No feature is inferred from screenshots or marketing adjectives; those are P. Short quotes only.
- Columns: **TV** = Android TV app; **Mobile** = Android phone/tablet app; **Docker** = `purestream711/nostalgiatv-server` web/companion; **Other** = Fire TV/Chromecast/iOS etc., only if documented.
- **DebridTV status** is scored only from behaviour that a test or the app audit exercised, never from code or a guide existing:
  - **V** verified: an audit check (`[A01]`…, see [App audit](#app-audit-2026-10-11)) or a named test passes.
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
| N-01c | Local folder metadata (Kodi nfo, OMDb, artwork) | D [N10 v0.9.12 OMDb; N01 what's-new Kodi nfo] | D [same] | ? | ? | **P** filename parsing only (`test/parse.test.ts`); no nfo, OMDb or artwork. |
| N-01d | Cross-server dedup (TMDB/IMDb/TVDB, preference rank) | ? | ? | D [N02, N14; 0.10.22] | ? | **P/V** same file in two places airs once [A15]; keyed on parsed name + runtime, not TMDB/IMDb ids; rank local > playable > TorBox > RD (`app/lineup.ts` dedupe). |
| N-02a | Pre-built presets | D [N01: "85+" ; N11: "70+ Standard Channels", Pro] | D [same] | ? | ? | **P/V** 7 automatic channel rules (Half Hour, Prime Hour, Marathon, Feature, Quarter Hour, decade cinema, one per show) [A01 demo, A14 local]; NTV claims 70-85+ presets. |
| N-02b | Custom channels | D [N04; N01] | D [N04 steps use mobile app] | D [N02 Channels tab] | ? | **V** builder with show/movie picks, 8 orderings, slot choice; goes on air at #50+ [A09, A18]. |
| N-03 | Channel number, name, logo | D [N04; N01 renumber/hide/favorite] | D [N04] | P [N02 lists Channels tab, no detail] | ? | **P/V** number + name on bug and OSD [A02]; numbers stable across restart [A11] and hiding [A19]. No logos, renumbering or favorites. |
| N-04 | Selection by collection/playlist/genre/decade/title | D [N04: Collection, Genre, Decade, Plex Playlist, search] | D [N04] | D [N02: also studios, labels, hand-picked] | ? | **P/V** pick by title [A18]; automatic decade channels [A01]. No genre, collection or playlist (no metadata source). |
| N-05 | Specials, watched-only, duplicate controls | D [N04; watched-only worded as Plex watched] | D [N04] | ? | ? | **P** duplicates removed automatically [A15]; no specials or watched-only switches. |
| N-06a | Kid channel flag; R-rated after-hours restriction | D [N04] | D [N04] | D [N02 mature/kid filtering] | ? | — not started. |
| N-06b | PIN-locked restricted channels with scrambling visuals | D [N10 v0.9.12; Pro? ] | D [same] | D [N10 "Docker/web support"] | ? | — not started. |
| N-07 | Content groups, order/shuffle, EPG description | D [N06; web remote on desktop browser] | P [N06 silent on mobile/TV creation] | D [N02 Groups tab; N10 Groups browse] | ? | — not started. |
| N-08 | Ordering modes | D 8 modes [N03] | D 8 modes [N03] | D 4 modes only [N02] | ? | **V** all 8 modes unit-tested (F2 in `test/clock.test.ts`) and offered in the builder [A09]. Same intent as NTV, not verified identical. |
| N-09a | Weights (0-100 sliders), time slots w/ weekday recurrence, restricted hours | D [N13, web UI advanced tab] | P [N13 is web UI] | D [N02 weights, time slots, restricted hours] | ? | — not started (programs align to 15/30/60-min slots, but no weekday time slots, weights or restricted hours). |
| N-09b | Exclusions | P [N02 lists exclusions for Docker] | ? | D [N02] | ? | **P (branch)** per-file exclude, reversible: `test/server.test.ts` "excluding a file…" on `project-thread-y7lgyq`, not yet on the shared branch. No show/genre exclusions. |
| N-09c | Premieres (recent additions pinned) | D [N13 premiere config] | P | D [N02] | ? | — not started. |
| N-09d | Recently-scheduled tracking / balance by episode count or duration | D [N13 balance; N02 recent tracking] | P | D [N02] | ? | **P** round-robin gives every show a turn before any repeats (F2 test); no recently-aired tracking. |
| N-09e | Marathons | D [N04: 3% per check, 4 hours; N13: toggle raises probability] (conflicting wording) | D | D [N02 marathon insertion] | ? | **P/V** a Marathon channel (#4) with tested run lengths (F2) [A01]; no random marathons inside other channels. |
| N-10 | Per-channel schedule regeneration | D [N10 v0.9.12; N04 Refresh Schedule] | D [same] | D [N02] | ? | **P** core `revise()` keeps the current airing (test C7); the app re-syncs channels when the library changes (`Lineup.sync`, untested in app). No per-channel "refresh schedule" action. |
| N-11a | Built-in themes | D 9 [N01] / 5 [N09] / Modern=Pro [N10] | D [same] | D 8 [N02] | ? | **V** 3 built-ins: Midnight, Cable '92, Daylight [A07]. |
| N-11b | Custom colors/fonts, theme import/export | D [N09 clone, edit, import/export] | D [N09] | D [N02 browser-editable] | ? | — not started. |
| N-12 | CRT effects, bezels, tuning sounds/screens | D [N01; N05 Classic CRT bezel option] | D [N10 v0.9.12 CRT/4:3 on mobile] | D CRT/bezel [N02]; tuning sounds ? | ? | **P/V** CRT scanlines, static between channels and tuner sounds are settings [A08]; no bezel. Visual effect checked by screenshot only. |
| N-13 | Number-key tuning, guide navigation | D [N01 "type the channel number"] | P [no number-key claim; N10 D-pad/controller] | ? (web /watch) | ? | **V** number entry [A02], up/down, last channel [A03], guide arrows [A05, A06]; fast surfing requests media only where it lands [A25] (cost measured in EXP-002/006). |
| N-14 | Hover tuning, startup choices, D-pad mapping | D [N05: auto-change channel, start on On Demand, swap D-pad] | D [N05; N10 mobile D-pad] | ? | ? | **P/V** starts on the last channel [A10]. No hover-tune, startup choice or D-pad remap. |
| N-15 | Guide display options (scroll, time indicator, dim ended, 24h clock, idle action) | D [N05] | D [N05] | ? | ? | **P/V** 12 h grid, now line, 24-hour clock option [A05, A06, A08]; past cells dimmed (`guide.js`). Branch `uy3380` adds aired-part shading, picture-in-guide, padding tails (screenshots in project files; not merged). No idle action. |
| N-16 | Logo overlay mode/position/opacity, rating at start | D [N05] | D [N05] | ? | ? | **P/V** channel bug (number + name) [A02]; no logo, position/opacity or rating card. |
| N-17a | Force 4:3 / widescreen zoom | D [N05; N01 what's-new 16:9/4:3] | D [N10 mobile 4:3] | ? | ? | — not started. |
| N-17b | Auto sign-off (up to 8 h), guide idle | D [N05] | D [N05] | ? | ? | — not started. |
| N-18a | Subtitle and audio-track / language options | D [N05] | D [N05] | D [N02 watch UI track selection] | ? | — not started (compat mode takes the first audio track; no subtitles). |
| N-18b | ExoPlayer vs libmpv, live switch | D [N05; N10 v0.9.12 live switching] | D [same] | X [engine is client-side; ? not stated] | ? | **P (different design)** browser player with one direct → compatibility fallback, never a loop [A20, A24]; no engine choice. |
| N-19 | Direct play / transcode cap, DTS transcode, passthrough, delivery badges | D [N05; N10 v0.9.12; N01 4K/HDR/DV] | D [same] | ? | ? | **P/V** direct play [A20]; ffmpeg compatibility mode for undecodable audio [A24], labelled in the banner. No transcode cap or passthrough. |
| N-20 | Playback reporting; 90% watched threshold | D [N05] | D [N05] | ? | ? | **V** seen file time is reported [A22]; watched flips between 85% and 92% seen and shows in the guide [A23]; D8 unit test. Branch `y7lgyq` adds mark/forget/export (tested, not merged). |
| N-21 | Commercials between/inside programs, bumpers, idents | D [N01; Pro per N11] | D [same] | D [N02, N14] | ? | **P (by design)** no commercials or bumpers: they would fetch media nobody asked for. Break cards are drawn locally (`cards.js`); branch `uy3380` adds Prevue-style rotating breaks, 0 provider calls (not merged). |
| N-22a | Break groups/sequences, padding, per-channel pools | D [N01; N02] | D [N01] | D [N02] | ? | **P/V** slot padding becomes a station break [A16]; no break groups or per-channel pools. |
| N-22b | Mid-break: halfway / chapters | D [N01 "chapter"; N10] | D [same] | D [N02 HALFWAY, CHAPTERS] | ? | **C, app FAIL** clock supports mid-breaks at given points (test C3), but no app channel turns them on and the probe reads no chapters [A17 fails]. |
| N-22c | Mid-break: silence detection | X [N14: server-side only] | X [same] | D [N02 ffmpeg, Docker only] | ? | — not started. |
| N-23a | Music/radio ("Tune Choice") | D [N01; N10 new stations] | D [same] | D [N02 + visualizer] | ? | — not started. |
| N-23b | Weather channels (WeatherStar 4000, Storm) | D [N01 Storm; N10 EAS crawls] | D [same] | D [N02; Storm falls back to offline simulation] | ? | — not started. |
| N-23c | Trailers channel ("What's On") | D [N01; N10] | D | D [N02] | ? | — not started. |
| N-24a | Plex / Jellyfin / Emby Live TV imports | D [N01; N02] | D [N01] | D [N02 EPG] | ? | — not started. |
| N-24b | M3U / XMLTV / HDHomeRun imports | D [N01; N10 editable sources] | D [same] | D [N02 External Sources, browser refresh] | ? | — not started. |
| N-24c | Live stream channels from URL (.m3u8) | D [N04] | D [N04] | D [N02] | ? | — not started. |
| N-25 | Cloud schedule/config sync via user-owned Firebase | D schedule only [N08]; config sync Pro [N10 v0.5.x, N11] | D [same] | ? | ? | — not started. Any cloud path sits behind the closed `cloud-relay` gate. |
| N-26a | Full-snapshot vs lineup-only config export/import | D [N07] | D [N07] | D [N02 per-profile or whole server; tokens excluded] | ? | **P (branch)** settings export carries choices, never keys (F4 in `test/server.test.ts`, `y7lgyq`, not merged). Lineup-only vs full not distinguished yet. |
| N-26b | Local pairing by 4-digit PIN (same Wi-Fi) | D [N07] | D [N07] | ? | ? | — not started (needs the `sharing` gate). |
| N-26c | Primary/follower (cloud sync) | D [N07] | D [N07] | ? | ? | — not started. |
| N-26d | Docker pairing code onboarding | D [N10 v0.9.12] | D [same] | D [same] | ? | — not applicable yet (no companion server). |
| N-27a | Browser UI (watch + configure) | X (TV app itself) / D web remote [N06, N07] | D [N01 web interface] | D [N02 ports 19850 /watch /configure] | ? | **V** watch and configure in one browser page on 127.0.0.1 [A01-A27]. |
| N-27b | Long-horizon schedule | P 8h default, up to ~1 week "Extended" [N12]; Play says nothing | P [same] | D 30 d default, 24-2160 h [N02] | ? | **V** schedule is computed, so any horizon is free: 12 h guide costs 0 calls [A05], the airing 3 h ahead is identical across restarts [A12], 100 ch × 30 d = 0 calls (EXP-001). |
| N-27c | Scheduled automatic backups | ? | ? | D [N02 weekly, one-click restore] | ? | — not started (export exists on branch `y7lgyq`; no schedule). |
| N-28 | HDHomeRun/IPTV tuner export | P [N01 "Acts as a tuner" via companion] | P | D [N02; unauthenticated by default, disable with HDHR_ENABLED=false] | ? | **G** `tuner-export` gate exists, closed by default (test "gates default closed"); nothing built behind it. |
| N-29 | Multi-profile (up to 6, kid/adult, PIN, Plex Home link) | D Pro [N11, N01] | D Pro [same] | D [N02] | ? | — not started. |
| N-30 | On Demand browse, search, voice search, Continue Watching, rent-mode channels | D [N10 v0.9.12; N01] | D [same] | D [N02 On Demand, Continue Watching; rent/voice ?] | ? | — not started. |
| N-31 | Chromecast | ? | D [N01; N10 v0.5.16] | ? | Chromecast: D [N01 "from compatible mobile devices"] | — not started. |
| N-32 | Seasonal lineups (Oct-Dec holiday) | D [N01 marketing claim] -> mark P | P | ? | ? | — not started. |
| N-33 | Fire TV support | ? | ? | ? | Fire TV: P [N10 mentions Fire TV stability fixes only; no listing] | — not started. |
| N-34 | iOS / Apple TV / Roku / web-only client | ? | ? | P [browser /watch] | iOS: ? | **P/V** any desktop browser; phone-width guide fits [A26]. A phone can't reach it: the server binds 127.0.0.1 and LAN access needs the `sharing` gate. |
| N-35 | Join programs in progress | D [N01 marketing claim] -> P | P | ? | ? | **V** tuning lands at station time, 0.1-0.15 s drift [A20]; pause 5 s then resume returns to live [A21]; C2/C3 tests. |
| N-36 | Weather EAS alert crawls | D [N10 v0.9.12] | D | ? | ? | — not started. |
| N-37 | Stream/delivery status badges, HDR/audio badges | D [N10; N01] | D | ? | ? | **P/V** banner badges: LIVE, station break, watched, refused, direct/compat, provider [A04, A24]. No HDR or audio-format badges. |
| N-38 | Pro entitlement gating (profiles, themes, commercials, cloud sync, 70+ channels, On Demand layout) | D [N11] | D [N11] | ? entitlement for Docker not stated | ? | **N/A** personal app with no paid tier. |

Reading notes: a cell like "D x / P y" means sources disagree on that surface; see Discrepancies. N-32 and N-35 are advertising claims without GitBook mechanics, so downgraded to P. "?" in the Docker column often just means the README is silent; the server may share the feature.

## Scoreboard (2026-10-11)

61 rows. **V 9 · P/V 13 · P 8 · C 1 · G 1 · not started 27 · N/A 2.**

That is: 22 rows have tested behaviour in the app (fully or in part), 8 more exist only as unit-tested core or unmerged branch work, and 27 are not started. The verified core is the "it feels like live TV" loop: joining in progress at station time, pause returns to live, number/last-channel tuning, a free guide of any length, stable numbers, slot breaks, the 90% watched rule, and direct vs compatibility playback. The biggest absent areas are scheduling controls (time slots, weights, restricted hours, kid/PIN), metadata (genres, logos, artwork), subtitles and audio tracks, and every non-library channel type (music, weather, live/M3U).

## App audit (2026-10-11)

`docs/parity/audit/app-audit.mjs` starts the real app in a throwaway data folder, generates local test media with ffmpeg (no provider traffic, safe in the cloud), and drives it in Chromium. Results and screenshots land in [`evidence/`](evidence/). Re-run after any merge:

```sh
NO_PROXY=127.0.0.1 node docs/parity/audit/app-audit.mjs
```

| Run | Commit | Result |
|---|---|---|
| Shared branch | `d68292c` | **26/27** ([app-audit.json](evidence/app-audit.json)) |
| Trial merge of shared + `y7lgyq` (C) + `uy3380` (B) | `aa685f5` (local only) | **25/27** ([app-audit-merged.json](evidence/app-audit-merged.json)); merges clean, `npm test` 130/130 |

| Check | What it proves | Rows | Shared | Merge |
|---|---|---|---|---|
| A01 | demo lineup on air with no source | N-02a | ✅ | ✅ |
| A02 | number keys tune; bug shows number + name | N-13, N-03 | ✅ | ✅ |
| A03 | channel up, then L returns to the previous channel | N-13 | ✅ | ✅ |
| A04 | info banner: title, times, what's next, badges | N-15, N-37 | ✅ | ✅ |
| A05 | browsing the guide 12 h ahead across all rows makes 0 media or link requests | N-15, N-27b | ✅ | ✅ |
| A06 | a guide row per channel, plus a now line | N-15 | ✅ | ✅ |
| A07 | three themes apply | N-11a | ✅ | ✅ |
| A08 | CRT, static, tuner sounds, 24-hour clock are settings | N-12, N-15 | ✅ | ✅ |
| A09 | builder offers all 8 orderings | N-08, N-02b | ✅ | ✅ |
| A10 | reload starts on the last channel | N-14 | ✅ | ✅ |
| A11 | channel numbers survive a restart | N-03 | ✅ | ✅ |
| A12 | the airing 3 h ahead is identical across a restart | N-27b, N-35 | ✅ | ✅ |
| A13 | local folders become channels after a header scan | N-01b | ✅ | ✅ |
| A14 | show channel at #10+, Quarter Hour at #6 | N-03 | ✅ | ✅ |
| A15 | the same episode in two folders airs once | N-01d, N-05 | ✅ | ✅ |
| A16 | slot padding: programs start on the quarter hour, the rest is a break | N-22a | ✅ | ✅ |
| A17 | mid-program breaks appear on some channel | N-22b | ❌ | ❌ |
| A18 | custom channels go on air at #50+ | N-02b, N-03 | ✅ | ✅ |
| A19 | hiding a channel keeps every other number | N-03 | ✅ | ✅ |
| A20 | tuning in lands at station time (direct play; drift ~0.1 s) | N-35 | ✅ | ✅ |
| A21 | pause 5 s inside a program, resume is back at live | N-35 | ✅ | ✅ |
| A22 | real playback is reported as seen time | N-20 | ✅ | ✅ |
| A23 | watched flips between 85% and 92% seen, and shows in the guide | N-20 | ✅ | ✅ |
| A24 | an AC-3 file plays through compatibility mode, labelled in the banner | N-19, N-37 | ✅ | ✅ |
| A25 | six fast presses request media only for the landing channel | N-13 | ✅ | ✅ |
| A26 | phone-width guide has no horizontal overflow | N-34 | ✅ | ✅ |
| A27 | every settings tab renders | — | ✅ | ❌ `library` tab has a button (B) but no renderer in `panel.js` (C) |

Limits of this audit: local files only (the app can't yet be pointed at the mock providers from the audit; C's `createApp` tests cover provider paths), Chromium without H.264, and A25 landed on a channel in a break, so it shows no stray streams rather than the cost of the final tune (EXP-002/006 measure that). Visual quality is judged from screenshots, not asserted.

## Gaps, ranked (2026-10-11)

Ranked by what a viewer would notice first, then by cost/safety. Owner = workstream from `docs/HANDOFF.md` §7.

| # | Gap | Rows | Owner | Why it matters |
|---|---|---|---|---|
| 1 | Library tab button with no renderer after merging B + C | — | C (B coordinate) | Visible broken tab once both branches land (A27). |
| 2 | Auto sign-off / "are you still watching" | N-17b | A | A viewer who falls asleep streams all night from RD/TorBox: real bytes and Remote Traffic risk. Zero-cost to build. |
| 3 | Mid-program breaks never happen in the app | N-22b | C (rules, chapter read in probe) + B (card) | Clock already supports them (C3); NTV's signature feel; costs 0 media. |
| 4 | Subtitles and audio-track choice | N-18a | A (+ C for track list from probe) | Foreign/anime libraries unwatchable without them; compat mode always takes track 1. |
| 5 | No browser tests in `npm test` | — | A/B | The audit script is the only end-to-end evidence for the player and guide; regressions won't show in CI. Fold A20/A21/A25 into tests. |
| 6 | Scheduling controls: weekday time slots, restricted hours, kid flag | N-09a, N-06a | C (lineup/clock) + B (UI) | Most-used NTV customisation after custom channels. |
| 7 | Channel logos, renumbering, favorites | N-03, N-16 | C (lineup) + B (UI) | Every channel looks alike; numbers can't be moved. |
| 8 | Genre/collection channels need metadata | N-04, N-01c | C | Local `.nfo` reading is free; online lookups (TMDB/OMDb) would be new outbound traffic and need a decision. |
| 9 | 4:3 / zoom display modes | N-17a | A/B | Cheap and very on-theme for old shows. |
| 10 | Startup choice and idle guide action | N-14, N-15 | B | Polish. |
| 11 | Phones/TVs can't reach the app | N-34, N-26b | needs Zachary | Server is 127.0.0.1-only; LAN access is the `sharing` gate. |
| 12 | Live/M3U, music, weather, trailers channels | N-23*, N-24* | later | Out of the library-first scope for now. |

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
