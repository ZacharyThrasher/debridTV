# ADR-0003 — Slow surfers get a paused peek; every tune should cost one round trip

**Status:** accepted for the player (2026-10-11); server half proposed · **Evidence:** EXP-007, EXP-008 · **Amended by** ADR-0006 (the next show on the channel being watched may be fetched ahead)

## Context
With adaptive-prefetch (ADR-0002, EXP-006) a viewer pressing about once a second waits
for the full adaptive dwell (up to 1.2 s) before media opens, ~0.8 s more than a player
that opens at once. EXP-008 showed the rest of a tune is three sequential range
requests (head, Cues, seek point), each paying the provider's ~200 ms TTFB.

## Decision
- When the adaptive wait is ≥ 700 ms, the player opens the direct-play stream paused
  (`preload=metadata`) 400 ms after the press, seeks to where the program will be when
  the wait ends, shows that frame silently, and starts motion and sound when the wait
  ends. A press in between cancels it like any other tune.
- Shorter waits (normal surfing) and compatibility mode keep the plain dwell.
- Proposed for the server (workstream C): keep each file's first 1 MB and last 256 KB
  after the first read (or from the library probe) and answer those ranges locally;
  a head read gets the cached bytes at once and the rest from the provider. That turns
  three provider round trips per tune into one.

## Consequences
- At 1 press/s the picture arrives ~0.55–0.6 s sooner; surfing past a channel costs
  ~1 MB (≈1 s of video) instead of ~0.3 MB. API calls are unchanged (one link per file).
- The head+tail cache would cut ~0.45 s from every tune and needs ~1.3 MB per cached
  file (memory LRU or the data dir).
- Not yet measured on a real provider or with H.264/HEVC MKVs from Chrome on Windows.
