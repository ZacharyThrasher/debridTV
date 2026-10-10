// EXP-001 — Can a full guide be built and browsed with zero provider traffic?
// Hypothesis: a pure station clock renders a 100-channel × 30-day guide over a
// 5,000-item library with 0 API calls and 0 media bytes, fast enough to run on a TV
// box (target: whole guide < 2 s, one tune() < 1 ms on this container).

import { writeFileSync, mkdirSync } from "node:fs";
import { StationClock } from "../src/clock/schedule.ts";
import type { Channel, MediaItem } from "../src/clock/types.ts";
import { ORDERINGS } from "../src/clock/ordering.ts";
import { startMockProviders } from "../src/providers/mock-server.ts";
import { mulberry32 } from "../src/clock/rng.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 10);

const rand = mulberry32(1);
const library: MediaItem[] = Array.from({ length: 5000 }, (_, i) => ({
  id: `m${i}`,
  title: `Item ${i}`,
  showId: `show${i % 250}`,
  episode: Math.floor(i / 250) + 1,
  durationMs: Math.round((18 + rand() * 100) * MIN),
  breakpointsMs: rand() < 0.3 ? [Math.round(8 * MIN)] : undefined,
  source: { provider: i % 2 ? "realdebrid" : "torbox", ref: `ref${i}` },
}));

const channels: Channel[] = Array.from({ length: 100 }, (_, c) => ({
  id: `ch${c}`,
  number: c + 2,
  name: `Channel ${c + 2}`,
  revisions: [{
    effectiveFromMs: T0 - 90 * DAY,
    seed: `ch${c}`,
    ordering: ORDERINGS[c % ORDERINGS.length]!,
    itemIds: library.filter((_, i) => i % 100 === c || (i * 7 + c) % 37 === 0).map((m) => m.id),
    slotMs: c % 2 ? 30 * MIN : undefined,
    midBreakMs: 3 * MIN,
  }],
}));

const mock = await startMockProviders({ files: [] });
const clock = new StationClock(library);

let t = performance.now();
let airings = 0;
for (const ch of channels) airings += clock.airingsBetween(ch, T0, T0 + 30 * DAY).length;
const guideMs = performance.now() - t;

const fresh = new StationClock(library);
t = performance.now();
const tunes = 20_000;
for (let i = 0; i < tunes; i++) fresh.tune(channels[i % 100]!, T0 + Math.floor(rand() * 30 * DAY));
const tuneUs = ((performance.now() - t) / tunes) * 1000;

// Same answers after a "restart" (a new clock instance) — spot check.
let mismatches = 0;
for (let i = 0; i < 2000; i++) {
  const ch = channels[i % 100]!;
  const at = T0 + Math.floor(rand() * 30 * DAY);
  if (JSON.stringify(clock.airingAt(ch, at)) !== JSON.stringify(fresh.airingAt(ch, at))) mismatches++;
}

const result = {
  experiment: "EXP-001",
  ranAt: new Date().toISOString(),
  node: process.version,
  channels: channels.length,
  libraryItems: library.length,
  horizonDays: 30,
  airingsRendered: airings,
  guideBuildMs: Math.round(guideMs),
  meanTuneMicros: Number(tuneUs.toFixed(1)),
  restartMismatches: mismatches,
  providerApiCalls: Object.values(mock.counters.api).reduce((a, b) => a + b, 0),
  mediaBytes: mock.counters.mediaBytes,
};
await mock.close();
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync("docs/experiments/results/exp001.json", JSON.stringify(result, null, 2) + "\n");
console.log(result);
