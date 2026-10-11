# Experiment log

Each entry: hypothesis → bounded experiment → result → revised hypothesis.
Raw numbers live in `results/`. All runs so far use the **in-process mock
providers** (`src/providers/mock-server.ts`), never a real Real-Debrid or TorBox
account. Mock numbers measure *our* client behaviour; they say nothing yet about
provider latency, link lifetimes or policy.

Environment for the 2026-10-10 runs: cloud Linux container, Node 22.22, localhost
HTTP. Gate ids (B1, C3, E4…) refer to handoff §9.

---

## EXP-001 — Guide and tuning with zero provider traffic (2026-10-10)

**Hypothesis.** A pure station clock (config + exact durations + time → airing)
can render a 100-channel × 30-day guide over 5,000 items with 0 API calls and 0
media bytes, in < 2 s, with tune lookup < 1 ms. (Gates B1, C1, C6.)

**Method.** `npm run exp:001`. Synthetic library, 3 ordering modes, slot padding
on half the channels, mid-program breaks on 30% of items. Mock server running
with counters; a second clock instance stands in for "after restart".

**Result** (`results/exp001.json`): 57,801 airings rendered in **265 ms**; mean
`tune()` **9.7 µs**; **0** restart mismatches in 2,000 spot checks; **0** API
calls; **0** media bytes.

**Verdict.** Confirmed on this hardware. Not yet measured on a TV-class CPU.

**Revised hypothesis / next.** The clock is cheap enough to compute on-device;
no materialised schedule log is needed for correctness. Open: DST-local slot
grids (slots are UTC-anchored today, so a local "top of the hour" grid shifts by
an hour across DST — gate C5 needs a decision), and the 5 missing ordering modes.

---

## EXP-003 — Request amplification from redirecting URLs (2026-10-10)

**Hypothesis.** Handing a player TorBox's redirecting `requestdl` URL makes every
range read call the API (handoff §5.5 / A03) and hits the 300/min/endpoint limit
during normal playback; reusing one resolved grant costs one call; on expiry,
invalidate + re-resolve once recovers without a retry storm. (Gates E3, E4.)

**Method.** `npm run exp:003`. 400 sequential 1 MiB range reads.

| Variant | API calls | 429s | Failed chunks | Re-resolves |
|---|---|---|---|---|
| A — redirect URL per chunk | 400 | 100 | 100 | 0 |
| B — cached grant | **1** | 0 | 0 | 0 |
| C — cached grant, 1.5 s expiry, pauses | 11 | 0 | 0 | 10 (one per expiry) |

**Verdict.** Confirmed against the mock. A reproduces the failure mode exactly as
reported: playback breaks once the per-minute window fills.

**Decision.** Players are only ever handed resolved grant URLs; the redirect form
is never given to a player ([ADR-0002](../decisions/0002-grant-reuse.md)).

**Open.** Real link lifetimes and range behaviour are unknown (SDK text conflicts
1 h vs 3 h). Needs an authorized live test.

---

## EXP-002 — What channel surfing costs (2026-10-10)

**Hypothesis.** Aborting superseded tunes caps concurrent streams at 1, and a
short dwell (no provider contact until the viewer rests) cuts API calls and wasted
bytes > 90% vs a naive player, for a modest latency cost.

**Method.** `npm run exp:002`. 31 presses (15 up, 15 down = revisits), 300 ms
apart; 150 ms API latency; 100 Mb/s link; player buffers 112 MB (~30 s at 30 Mb/s)
then holds the connection. Measured server-side.

| Variant | API calls | Media requests | Media MB | Peak streams | Final first byte |
|---|---|---|---|---|---|
| naive (no cancel) | 31 | 31 | **3,615** | **31** | 158 ms |
| cancel | 31 | 31 | 173 | 1 | 153 ms |
| cancel + grant cache | 16 | 31 | 198 | 2* | 2 ms |
| dwell 500 ms + cache | **1** | **1** | **117** | 1 | 659 ms |
| dwell 250 ms + cache | 31 | 1 | 117 | 1 | 405 ms |

\* Client-side the old stream is released before the new one opens; the server
still sees a brief overlap because it learns of the close a moment later.

**Verdict.** Confirmed with a twist.
- A naive player turns 9 seconds of surfing into **3.6 GB and 31 open streams**.
  This is the single largest cost risk found so far (gate B3).
- Cancel alone fixes concurrency and bytes but still spends one API call per press.
- Dwell must be **longer than the viewer's press interval**. At 250 ms (< 300 ms
  presses) media is saved but every press still sends an API request, because the
  resolve has already left by the time the next press arrives — and a sent request
  is paid for even if abandoned.
- The 117 MB in the dwell rows is the final channel's own buffer. A 30 s buffer
  goal is itself a cost decision.

**Revised hypothesis → EXP-004.** A fixed dwell is a latency/API-call trade-off
that depends on press speed. Sweep press interval × dwell to find the frontier;
then test an adaptive rule (dwell = f(recent press interval)).

---

## EXP-004 — Press interval × fixed dwell sweep (2026-10-10)

**Method.** EXP-002 script, presses every 150/300/600/1000 ms × dwell 0/250/500/800/1200 ms
(run by a Sonnet worker). Full table: [`results/exp004-summary.md`](results/exp004-summary.md).

**Result.** API calls drop to 1 only once dwell > press interval. A dwell at or
just under the interval was *worse* than none (31 calls vs 16). Latency ≈ dwell + 155 ms.
Re-run variance: identical API counts, ±15 ms latency.

**Bug found.** The 31-vs-16 anomaly came from `GrantCache`: a resolve whose caller
had been superseded completed but was never stored, so the revisit paid again.
Fixed: the grant is cached when the request completes, regardless of who is still
waiting (and an unawaited failure no longer risks an unhandled rejection).

**Revised hypothesis → EXP-005.** No fixed dwell fits every viewer. A dwell that
follows the viewer's own rhythm (1.3 × last gap, clamped 150–1200 ms; a pause > 2.4 s
counts as a deliberate pick) should give ~1 API call at every press speed.

---

## EXP-005 — Adaptive dwell (2026-10-10)

**Method.** `PRESS_MS=<p> DWELLS=0,-1 npm run exp:002`, after the cache fix.
Results: `results/exp005-press*.json`.

| Press interval | cancel + cache (calls / MB / final ms) | adaptive + cache (calls / MB / final ms) |
|---|---|---|
| 150 ms | 16 / 143 / 3 | **1 / 117 / 199** |
| 300 ms | 16 / 197 / 2 | **1 / 117 / 394** |
| 600 ms | 16 / 310 / 1 | **1 / 120 / 782** |
| 1000 ms | 16 / 458 / 2 | **1 / 125 / 1,204** |

**Verdict.** Confirmed: adaptive dwell gives 1 API call and ≈ only the final
channel's buffer at every press speed. The cache fix brought cancel + cache down to
16 calls (one per distinct channel) at all speeds.

**What it costs.** Slow surfers wait longest (≈1.2 s at 1-second presses), because
the tuner can't tell "still surfing" from "settled" until the gap has passed.
Cancel + cache is near-instant on revisits but wastes 25–340 MB of media and up to one
API call per distinct channel.

**Open product choice.** Snappy vs frugal tuning — put to Zachary. Ideas to shrink
the gap: resolve the grant immediately but delay only the media fetch (API calls =
distinct channels, media = 1 stream); show the channel's guide card/slate during the wait;
smaller initial buffer goal.

---

## EXP-006 — Resolve early, delay only the video (2026-10-10)

**Hypothesis.** Resolving the grant immediately (cached) and applying the adaptive
wait only before the media fetch removes the API round-trip from tune latency,
while media stays at one buffer. API calls rise to one per distinct channel.

**Method correction first.** EXP-002..005 ended on channel 0, a *revisit*. When
its grant had been cached on the way up, final latency excluded the API call, so
those final-latency numbers are optimistic. `FINAL=fresh` now ends on a
never-visited channel. Results: `results/exp002-press*-fresh-dwells0_-1_-2.json`.

| Press interval | cancel + cache | adaptive + cache | adaptive-prefetch + cache |
|---|---|---|---|
| 150 ms | 17 / 143 MB / 155 ms | 2 / 117 / 350 | 17 / 117 / **198** |
| 300 ms | 17 / 199 / 154 | 2 / 117 / 546 | 17 / 118 / **393** |
| 600 ms | 17 / 309 / 155 | 2 / 120 / 938 | 17 / 122 / **784** |
| 1000 ms | 17 / 460 / 155 | 2 / 125 / 1,355 | 17 / 127 / **1,205** |

(cells: API calls / media MB / final first byte)

**Verdict.** Confirmed. Prefetch saves exactly the API latency (150 ms here; real
latency unknown) and keeps media at ~1 buffer, for ≤ 1 API call per distinct
channel visited — 17 calls for 31 presses, far inside RD's 250/min and TorBox's
300/min/endpoint, though those budgets are shared with the user's other apps (B7).

**Current default:** `adaptive-prefetch` + grant cache. Media bytes are the
expensive resource (TorBox's abuse accounting counts bytes, handoff §4.4); API calls
are cheap but bounded.

**Remaining latency is the wait itself** (1.3 × the viewer's press gap). Next ideas
to test: show the guide card / station slate instantly during the wait (perceived
latency), and a number-key path (typing "4","2") that should skip the wait once
the number is complete.

---

## LIVE-001 — Read-only probe of the account holder's own account (pending)

Approved by Zachary on 2026-10-10 ("Yes, read-only"). `experiments/live-probe.ts`,
run by Zachary on his own device with his own key in an env var. Reads account
plan facts and one library page, resolves one link for one existing file, reads
4 × 256 KiB ranges (start / middle / middle again / end), opens and cancels one
stream, and optionally re-checks the link with 1-byte reads every 15 min
(`WATCH_MIN`). Media capped at 16 MB. Report has no keys, links or file names.

Dry run against the mock: 3 API calls and ~1.1 MB per provider, report scanned clean
for secrets and names. **Caveat seen in the dry run:** the client counted 1.1 MB
but the server sent 2.2 MB, because a cancelled stream keeps flowing until the
connection closes. Provider-side byte counts can exceed what the player saw; byte
meters must count from the provider's side of the socket where possible.

Questions it answers: real API latency, link host, stated vs actual link lifetime,
range/seek support and timing, first-chunk time after a cancel.

### LIVE-001 run 1 — 2026-10-11 03:22 UTC (Windows, Node 24.11, Zachary's PC)

**Real-Debrid**
- Account read OK: premium, expires 2027-02-17. Latency 509 ms.
- Library page: 100 entries (one page), 99 `downloaded`, 1 `error`. Latency 292 ms.
- The auto-picked file (mkv, 0.70 GB, listed `downloaded`) was **refused at link time:
  `infringing_file` (RD error_code 35)**. No media was read.
- So far that's 3 API calls and 0 media bytes.

**TorBox:** `AUTH_ERROR` on both calls. The key was not accepted, most likely
because it had just been reset. No further calls.

**What this shows**
1. **"downloaded" in the library ≠ playable.** A file can be listed as ready and still
   be refused when you ask for a link. This is the first real-world evidence for the
   handoff's warning (§5.4) that listed / cached / playable / scheduled are different
   facts. The scheduler is already built for it: the slot stays, and the guide shows
   an honest "unavailable".
2. **Policy refusals need their own error class.** `classify()` now reads provider
   error codes (RD 35 → `policy`, TorBox `AUTH_ERROR` → `auth`), so a policy block is
   never retried and never "fixed" by trying another provider (gate E6). The probe
   now records the error kind and HTTP status.
3. **Not tested yet:** link lifetime, seek, and cancel. These need a file that is not
   policy-blocked, chosen by Zachary (`PICK=n`). The probe deliberately does not
   hunt through the library for one.

### LIVE-001 run 2 — 2026-10-11 03:26 UTC

**Real-Debrid:** same auto-pick, same `infringing_file` refusal (no `PICK` set). One more refused call, no media.

**TorBox ✅** (plan type 1, expires 2027-08-29)

| Step | Result |
|---|---|
| Account | 514 ms |
| Library (`mylist`, one call) | **938 files, 2,836 ms**, all `download_finished` |
| Link request (`requestdl`, JSON form) | **369 ms**; no stated expiry; host `tb-cdn.io`; no redirect |
| Range, start (cold) | 206, TTFB **251 ms**, 465 ms for 256 KiB |
| Range, middle (cold seek) | 206, TTFB 183 ms |
| Range, middle again (warm) | 206, TTFB 131 ms, 155 ms total |
| Range, end | 206, TTFB 129 ms |
| Open + cancel | first chunk 30 ms |
| Totals | 3 API calls, 1.05 MB media |

**Findings**
1. **Seeking works everywhere in the file** (206 with correct `content-range`), so tuning into the middle of a program is a plain range read.
2. **Realistic cold tune ≈ 0.37 s link + 0.25 s first byte ≈ 0.6 s**; with a cached link ≈ 0.13–0.25 s.
3. **The library call is slow and large** (2.8 s for 938 files). The guide must never wait on it; refresh it in the background, rarely, and cache it (also gate B7: shared rate budget).
4. **The CDN sends a stable `ETag`** per file. It is a candidate for file/edition identity (gate D4) and stale-link detection. Not yet verified stable across links or days.
5. Link lifetime is still unknown (needs `WATCH_MIN`).

### EXP-007 — Surfing re-run with live-calibrated latency (2026-10-11)

Mock set to LIVE-001's TorBox numbers: API 370 ms, media TTFB 200 ms; fresh final channel.
Results: `results/exp002-press*-live370_200-fresh-dwells0_-1_-2.json`.

| Press interval | cancel + cache | adaptive + cache | adaptive-prefetch + cache |
|---|---|---|---|
| 300 ms | 17 / 134 MB / 574 ms | 2 / 117 / 967 | 17 / 117 / **594** |
| 1000 ms | 17 / 344 / 575 | 2 / 120 / 1,777 | 17 / 122 / **1,404** |

**Verdict.** With real latencies, prefetch hides the link request inside the wait.
For normal-speed surfing (300 ms), adaptive-prefetch is **as fast as the snappy
option (594 vs 574 ms) with the least media**. Slow surfers (1 s presses) still wait
~0.8 s longer than with cancel-only, which itself costs ~2.8× the media. Keep
adaptive-prefetch as the default; the slow-surfer case is the remaining gap.

### LIVE-001 run 3 — TorBox link lifetime (2026-10-11, reported by Zachary)

1-byte reads on the same link every 15 min: **206 at every check from 15 to 120 min**
(TTFB 86–406 ms, no trend). The link was still valid at 2 h, which contradicts the
SDK's "1 hour" wording; the 3 h claim is still unconfirmed past 120 min.

**Change:** the `GrantCache` fallback TTL went from 10 → 60 min (2× margin under what
was observed). Expiry is still handled by invalidate-and-re-resolve-once, so a wrong
guess costs one API call, not a failure. For a 1-hour program that's 1 link request
instead of 6.

### EXP-008 — The slow-surfer gap, measured in a real browser (2026-10-11)

**Question.** EXP-007 left slow surfers (≈1 press/s) waiting ~0.8 s longer than
cancel-only tuning. Where does a tune's time actually go in a browser, and can a
"peek" (open paused, show the live frame, start motion after the dwell) close it?

**Setup.** `experiments/exp008-browser-peek.ts`: Chromium (Playwright) plays VP9/Opus
WebM (8 Mb/s, 2 s GOP) from a local server shaped like LIVE-001's TorBox: link
request 370 ms (once per file), media TTFB 200 ms on every range request, 100 Mb/s
shared link, every byte counted. 6 bursts of 6 presses, ±25 % press jitter
(seeded), each burst ends on a never-visited channel (cold link). Median / p90 time
to a picture of the live point on the final channel. Single runs; ±150 ms noise.
Results: `results/exp008-press*-jitter25*.json`.

**Finding 1 — three round trips per tune.** Chrome opens a Matroska file mid-program
with three *sequential* range requests: the head (reads 0.7–1.2 MB before hanging
up), the Cues at the end, then the seek point. Each pays the provider's TTFB, so
~450 ms of every tune is round trips, whatever the tuning strategy.

**Finding 2 — a head+tail cache removes two of them.** Serving the first 1 MB and
last 256 KB of each file from memory (`INDEX_CACHE=1`) starts the seek request
~40 ms after the first instead of ~460 ms:

| Press interval | strategy | MB per surfed press | picture median / p90 (no cache) | with head+tail cache |
|---|---|---|---|---|
| 300 ms | adaptive (current) | 0 | 1,463 / 1,527 | **995** / 1,305 |
| 300 ms | open at once | 0 | 1,333 / 1,680 | 947 / 1,234 |
| 1000 ms | adaptive (current) | 0.27 (0.74 cached) | 2,058 / 2,261 | 1,571 / 1,795 |
| 1000 ms | adaptive ×1.0 | 0.42 (1.11) | 1,872 / 2,372 | 1,445 / 1,916 |
| 1000 ms | **peek at 400 ms** | 1.18 (3.52) | **1,472** / 1,940 | **1,028** / 1,519 |
| 1000 ms | open at once | 2.26 (4.34) | 1,603 / 1,772 | 1,205 / 1,223 |

(At 300 ms nobody stops long enough to open anything, so every strategy costs ~0 MB
while surfing. "Open at once" motion timing was unreliable in this harness, so the
table uses time to picture for all rows.)

**Verdict.** The slow-surfer wait is structural: an adaptive dwell can't know the
viewer stopped until a press interval has passed. Peeking hides it: at 1 press/s
the picture arrives **~0.55–0.6 s sooner**, at about the speed of opening at once,
for ~1 MB per surfed channel (≈1 s of video), half of what opening at once costs.
Fast surfers are unaffected (their wait is under 700 ms, so no peek happens). The
head+tail cache is a ~0.45 s win on **every** tune, and saves the repeated head
reads on revisits.

**Changes.** Player: peek 400 ms after a press when the adaptive wait is ≥ 700 ms
(`PEEK_AT`, `PEEK_MIN_WAIT` in `player.js`); compat mode still waits the full dwell
(it starts ffmpeg). Head+tail cache handed to workstream C as a proposal (server).
ADR-0003 records the decision.

### EXP-009 — The edge cache in the real app (2026-10-11)

**Question.** Does workstream C's head+tail edge cache (ADR-0003, `app/edgecache.ts`)
give the ~0.45 s per tune that EXP-008 predicted, in the real app rather than a bench?

**Setup.** `experiments/exp009-app-surf.ts` runs the app server (C's branch merged with
the player) against the mock TorBox shaped like LIVE-001 (link 370 ms, media TTFB
200 ms, 100 Mb/s) serving real 8 Mb/s VP9/Opus WebM. Eight one-movie channels. Links
are fetched first, so every tune pays the same for the link. Chromium tunes to each
channel by number, rests 3.5 s, and does three passes: pass 1 meets a cold cache,
passes 2–3 a warm one. Time = key press to a decoded frame of the live point.
Result: `results/exp009.json`.

| | median | range |
|---|---|---|
| Cold cache (first visit to a file) | **1,069 ms** | 951–1,142 |
| Warm cache (revisit) | **556 ms** | 474–917 |

**Verdict.** The cache cuts a revisit's tune time by **~0.5 s (−48 %)**, slightly more
than EXP-008's estimate. 15 MB of the run came from the cache instead of the provider;
no extra API calls. First visits still pay three round trips; filling the head at
library-probe time would extend the win to them (the probe already reads the head).

### PARITY-001 — App audit against the NostalgiaTV register (2026-10-11)

**Question.** Which NostalgiaTV parity rows does the app actually do, as opposed to
having code or a guide for them?

**Method.** New `docs/parity/audit/app-audit.mjs`: real app in a throwaway data dir,
generated local media (VP9/Opus WebM episodes, one AC-3 MKV, one duplicate copy), Chromium
via Playwright, 27 checks. No provider traffic. Run on the shared branch (`d68292c`) and on a
local trial merge with the C (`project-thread-y7lgyq`) and B (`project-thread-uy3380`) branches.

**Result.** Shared branch 26/27, trial merge 25/27 (merge clean, `npm test` 130/130).
- Tuning in lands within **0.1-0.15 s** of station time (direct play); pausing 5 s inside a
  program and resuming comes back at live, same program, 0.09 s off.
- Guide browsing 12 h ahead across every row: **0** media and **0** link requests.
- Watched flips between 85% and 92% seen file time, and the guide shows it.
- An AC-3 file plays through compatibility mode with the banner saying so.
- **Fails:** no channel ever has a mid-program break (A17: the clock supports them but no
  rule turns them on and the probe reads no chapters); after the merge, the new Library
  settings tab has no renderer (A27).

**Register.** `docs/parity/nostalgiatv.md` v0.2: of 61 rows, 9 verified, 13 partly verified,
8 partial (unit-tested core or branch only), 1 core-only, 1 gate, 27 not started, 2 N/A.
Ranked gaps are in the register; top three are the broken Library tab after merge, auto
sign-off (a sleeping viewer streams all night), and mid-program breaks.

**Next.** Re-run the audit after each merge; add checks as B and C ship (Prevue breaks,
exclusions, export). Fold the playback checks (A20/A21/A25) into `npm test`.

### PARITY-002 — Audit round 2 (2026-10-11)

**Change to the audit.** Episode 8 of the test show now runs 8 min with a chapter at 4:00.
The first try put chapters into 90 s files, and A17 still failed. The cause was the
audit, not the app: breaks are never placed in a program's first or last 3 min
(`breakpoints()`), so a 90 s file can't hold one. Added A28 (Z cycles picture shape).

**Result.** Shared `cffbc0d` + C `446sg8` `4a73787`: **28/28**, `npm test` 169/169. An earlier
trial merge (C `6ed75dd` + B `f5aca03`) caught an integration crash: C's settings API
returns `logo: null`, B's editor read `null.kind`, so the channel editor would not open
for any channel without a logo. Reported, and B fixed it in `2b17a5c`.

**Register v0.3.** 61 rows: V 14, P/V 18, P 2, C 1, G 1, not started 23, N/A 2 (round 1:
V 9, P/V 13). Top remaining gaps: auto sign-off, audio/subtitle track choice, and playback
checks in `npm test` (A); weights/premieres, random marathons, watched-only (C).

### PARITY-003 — Audit round 3 on the release (2026-10-11)

Shared release `97666b5`: audit **28/28**, `npm test` **214/214**. A20/A21/A25 now also live in
`test/ui/player.test.ts`, so the playback parity checks run on every `npm test`. Register v0.4:
V 28, P/V 11, P 1, G 1, not started 18, N/A 2 (round 2: V 14, P/V 18). Every round-2 gap
shipped with tests. Remaining gaps are product areas (content groups, seasonal lineups,
trailers, On Demand) and items that need Zachary (LAN access, outside sources, profiles).

### EXP-010 — What silence-detected breaks cost, local files only (2026-10-11, C4)

**Question.** N-22c finds break points by decoding a file's whole soundtrack. What does that
cost on this PC, and does it find a planted silence?

**Method.** ffmpeg `silencedetect=noise=-45dB:duration=0.5`, audio only (`-vn -sn -dn`), on
(a) the test's 8-minute file with a 2 s gap at 4:00 (16 kb/s mono AAC) and (b) a 44-minute
720p episode stand-in, stereo AAC 160 kb/s, with 1.5 s and 2 s gaps at 10:00 and 25:00. Cloud
container CPU, not Zachary's PC.

**Result.** (a) about 0.34 s per file, break at 4:00.5 as planted (`test/silence.test.ts`).
(b) 10.7 s wall (6.3 s user) for the 44-minute file; both gaps found (600.0–601.5 s and
1500.0–1502.0 s), so break points at 10:00.8 and 25:01. Provider calls 0, provider bytes 0.

**Decision.** Ship it as a viewer-started job over local episodes without chapters, one file
at a time, stoppable. Never for Real-Debrid or TorBox files: the same check would download
every episode in full (about 1 GB per hour of HD) for media nobody is watching.
`breakpoints()` ignores silence data on anything that isn't local, so a stray value can't
place a break in a debrid file either.
