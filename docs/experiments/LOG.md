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
