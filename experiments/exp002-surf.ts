// EXP-002 — What does channel surfing cost, and which tuner strategy bounds it?
// Hypothesis: aborting superseded tunes caps concurrent streams at 1, and adding a
// short dwell (no provider contact until the viewer rests on a channel) cuts API
// calls and wasted media bytes by >90% versus a naive player, for a modest
// tune-latency cost on the final channel.
//
// Script: viewer presses channel-up 15 times, then channel-down 15 times (so half
// the visits are revisits), one press every PRESS_MS, then rests on the last channel.

import { writeFileSync, mkdirSync } from "node:fs";
import { startMockProviders, type MockFile } from "../src/providers/mock-server.ts";
import { RealDebridClient, TorBoxClient } from "../src/providers/clients.ts";
import { Tuner, type Strategy } from "../src/tuner/tuner.ts";
import { GrantCache } from "../src/tuner/grants.ts";

const PRESS_MS = Number(process.env.PRESS_MS ?? 300);
const MB = 1_000_000;
const FILE_BYTES = 2_000 * MB; // ~ 9 min at 30 Mb/s; size only matters for offsets
const BUFFER_TARGET = 112 * MB; // ~30 s of 30 Mb/s video, a typical player buffer goal
const LINK_BYTES_PER_SEC = 12.5 * MB; // 100 Mb/s home link
const API_LATENCY_MS = 150;

const files: MockFile[] = Array.from({ length: 17 }, (_, i) =>
  i % 2 ? { ref: `rd:${i}`, name: `f${i}.mkv`, bytes: FILE_BYTES } : { ref: `tb:${i}:0`, name: `f${i}.mkv`, bytes: FILE_BYTES },
);
// FINAL=fresh ends on a never-visited channel (cold grant), so final latency includes
// a real resolve. The default ends on channel 0, a revisit, which flattered
// latency in EXP-002..005 whenever its grant had been cached on the way up.
const presses = process.env.FINAL === "fresh"
  ? [...Array.from({ length: 16 }, (_, i) => i), ...Array.from({ length: 14 }, (_, i) => 14 - i), 16]
  : [...Array.from({ length: 16 }, (_, i) => i), ...Array.from({ length: 15 }, (_, i) => 14 - i)];

interface Variant { name: string; strategy: Strategy; dwellMs?: number; cache: boolean }
const defaultVariants: Variant[] = [
  { name: "naive", strategy: "naive", cache: false },
  { name: "cancel", strategy: "cancel", cache: false },
  { name: "cancel+cache", strategy: "cancel", cache: true },
  { name: "dwell500+cache", strategy: "dwell", dwellMs: 500, cache: true },
  { name: "dwell250+cache", strategy: "dwell", dwellMs: 250, cache: true },
];
// DWELLS="0,250,-1" runs cancel+cache (0), dwell+cache (N) and adaptive+cache (-1) and adaptive-prefetch+cache (-2) variants instead.
const variants: Variant[] = process.env.DWELLS
  ? process.env.DWELLS.split(",").map(Number).map((d) =>
      d === 0 ? { name: "cancel+cache", strategy: "cancel" as const, cache: true }
        : d === -1 ? { name: "adaptive+cache", strategy: "adaptive" as const, cache: true }
        : d === -2 ? { name: "adaptive-prefetch+cache", strategy: "adaptive-prefetch" as const, cache: true }
        : { name: `dwell${d}+cache`, strategy: "dwell" as const, dwellMs: d, cache: true })
  : defaultVariants;
const tag = (process.env.FINAL === "fresh" ? "-fresh" : "") + (process.env.DWELLS ? `-dwells${process.env.DWELLS.replaceAll(",", "_")}` : "");

const rows = [];
for (const v of variants) {
  const mock = await startMockProviders({ files, apiLatencyMs: API_LATENCY_MS, linkBytesPerSec: LINK_BYTES_PER_SEC });
  const rd = new RealDebridClient(`${mock.baseUrl}/rd`, "fixture-token");
  const tb = new TorBoxClient(`${mock.baseUrl}/tb`, "fixture-token");
  const tuner = new Tuner({ strategy: v.strategy, dwellMs: v.dwellMs, bufferTargetBytes: BUFFER_TARGET,
    grants: v.cache ? new GrantCache() : null });

  let last: Promise<{ firstByteMs?: number; status: string }> = Promise.resolve({ status: "none" });
  for (const ch of presses) {
    const f = files[ch]!;
    const client = f.ref.startsWith("rd:") ? rd : tb;
    const ref = f.ref.startsWith("rd:") ? `https://real-debrid.example/d/${f.ref.slice(3)}` : f.ref;
    // Each channel is mid-program: seek a third of the way in.
    last = tuner.tune({ channelId: `ch${ch}`, client, ref, byteOffset: Math.floor(FILE_BYTES / 3) });
    await sleep(PRESS_MS);
  }
  const final = await last;
  await sleep(2000); // rest on the final channel; let anything leaked keep running
  const peak = mock.counters.peakActiveMedia;
  const activeAtRest = mock.counters.activeMedia;
  tuner.stopAll();
  await sleep(300);
  rows.push({
    variant: v.name,
    presses: presses.length,
    apiCalls: Object.values(mock.counters.api).reduce((a, b) => a + b, 0),
    mediaRequests: mock.counters.mediaRequests,
    mediaMB: Math.round(mock.counters.mediaBytes / MB),
    peakConcurrentStreams: peak,
    streamsOpenWhileResting: activeAtRest,
    streamsOpenAfterStop: mock.counters.activeMedia,
    finalStatus: final.status,
    finalFirstByteMs: final.firstByteMs ? Math.round(final.firstByteMs) : null,
  });
  await mock.close();
}

const result = { experiment: "EXP-002", ranAt: new Date().toISOString(), pressMs: PRESS_MS, apiLatencyMs: API_LATENCY_MS,
  linkMbps: (LINK_BYTES_PER_SEC * 8) / MB, bufferTargetMB: BUFFER_TARGET / MB, rows };
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync(`docs/experiments/results/exp002-press${PRESS_MS}${tag}.json`, JSON.stringify(result, null, 2) + "\n");
console.table(rows);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
