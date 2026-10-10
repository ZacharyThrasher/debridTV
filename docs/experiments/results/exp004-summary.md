# EXP-004 — Press-interval x dwell sweep (from exp002-surf.ts)

31 presses (15 up, 15 down plus first), mock providers, 150 ms API latency, 100 Mb/s link. Cells: `apiCalls / mediaMB / finalFirstByteMs`. Dwell 0 = cancel+cache (no dwell). Every run ended with 1 peak concurrent stream and 0 streams open after stop.

| Press interval | dwell 0 | dwell 250 | dwell 500 | dwell 800 | dwell 1200 |
|---|---|---|---|---|---|
| 150 ms  | 31 / 117 / 158 | 1 / 117 / 409 | 1 / 117 / 659 | 1 / 117 / 956 | 1 / 117 / 1359 |
| 300 ms  | 16 / 198 / 2   | 31 / 117 / 422 | 1 / 117 / 657 | 1 / 117 / 958 | 1 / 117 / 1359 |
| 600 ms  | 16 / 309 / 3   | 16 / 218 / 252 | 31 / 117 / 656 | 1 / 117 / 959 | 1 / 117 / 1360 |
| 1000 ms | 16 / 458 / 2   | 16 / 366 / 252 | 16 / 273 / 501 | 16 / 161 / 803 | 1 / 117 / 1359 |

(300 ms row is run 1. Raw per-press JSONs were later overwritten by the EXP-005 runs; only `exp002-press300-sweep-run1.json` survives. Numbers above are as recorded at the time. These runs predate the grant-cache fix noted in LOG.md.)

## Run-to-run variance (PRESS_MS=300, run 1 vs run 2)

| Dwell | Run 1 | Run 2 |
|---|---|---|
| 0 | 16 / 198 / 2 | 16 / 197 / 2 |
| 250 | 31 / 117 / 422 | 31 / 117 / 407 |
| 500 | 1 / 117 / 657 | 1 / 117 / 656 |
| 800 | 1 / 117 / 958 | 1 / 117 / 958 |
| 1200 | 1 / 117 / 1359 | 1 / 117 / 1359 |

apiCalls identical in all variants; mediaMB differed by 1 MB (dwell 0 only); finalFirstByteMs differed by 0-15 ms (largest at dwell 250).

## Observations

1. API calls fall to 1 once dwell exceeds the press interval: dwell >= 250 at 150 ms, >= 500 at 300 ms, >= 800 at 600 ms, 1200 at 1000 ms (dwell 800 still gave 16 calls at 1000 ms).
2. Dwell values at or just below the press interval were worse than no dwell on API calls: 250 at 300 ms and 500 at 600 ms gave 31 calls versus 16 for dwell 0 (media was 117 MB, though).
3. When dwell is shorter than the press interval, media bytes grow with the interval (dwell 0: 198 / 309 / 458 MB at 300 / 600 / 1000 ms); once API calls hit 1, media is 117 MB in every case.
4. Latency cost: final first-byte time is roughly dwell + ~155-160 ms (409 / 659 / 956 / 1359 ms for dwell 250 / 500 / 800 / 1200) versus 2-3 ms for dwell 0 where the grant cache is warm (158 ms at 150 ms presses, where the cache was cold).
5. Dwell 0 made 31 API calls at 150 ms presses but 16 at 300, 600 and 1000 ms (the 16 equals the number of distinct channels).
