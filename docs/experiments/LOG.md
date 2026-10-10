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
