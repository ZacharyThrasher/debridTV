// EXP-003 — Reproduce the request-amplification failure from handoff §5.5 (A03)
// against the mock, and check that grant reuse plus a single re-resolve on expiry
// avoids it (gates E3, E4).
//
// A: player is handed TorBox's redirecting API URL; every range chunk hits the API.
// B: player is handed one resolved CDN URL from the grant cache.
// C: like B, but grants expire every 1.5 s while playback pauses between chunks;
//    on a 403 the player invalidates and re-resolves once, never in a loop.

import { writeFileSync, mkdirSync } from "node:fs";
import { startMockProviders } from "../src/providers/mock-server.ts";
import { TorBoxClient } from "../src/providers/clients.ts";
import { GrantCache } from "../src/tuner/grants.ts";

const MiB = 1024 * 1024;
const CHUNKS = Number(process.env.CHUNKS ?? 400);
const REF = "tb:7:0";

async function readChunk(url: string, i: number): Promise<number> {
  const res = await fetch(url, { headers: { range: `bytes=${i * MiB}-${(i + 1) * MiB - 1}` } });
  await res.arrayBuffer();
  return res.status;
}

async function run(name: string, grantTtlMs: number, pauseEveryMs: number, mode: "redirect" | "cached") {
  const mock = await startMockProviders({
    files: [{ ref: REF, name: "f.mkv", bytes: (CHUNKS + 1) * MiB }],
    linkBytesPerSec: 2_000 * MiB,
    grantTtlMs,
  });
  const tb = new TorBoxClient(`${mock.baseUrl}/tb`, "fixture-token");
  const grants = new GrantCache({ fallbackTtlMs: 60 * 60_000 });
  let failedChunks = 0;
  let reResolves = 0;
  const t0 = performance.now();
  for (let i = 0; i < CHUNKS; i++) {
    if (pauseEveryMs && i % 20 === 19) await new Promise((r) => setTimeout(r, pauseEveryMs));
    if (mode === "redirect") {
      if ((await readChunk(tb.requestUrl(REF, true), i)) >= 400) failedChunks++;
      continue;
    }
    let status = await readChunk((await grants.get(tb, REF)).url, i);
    if (status === 403) {
      grants.invalidate(tb, REF);
      reResolves++;
      status = await readChunk((await grants.get(tb, REF)).url, i);
    }
    if (status >= 400) failedChunks++;
  }
  const row = {
    variant: name,
    chunks: CHUNKS,
    chunkMiB: 1,
    seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    apiCalls: mock.counters.api["tb.requestdl"] ?? 0,
    rateLimited: mock.counters.rateLimited,
    failedChunks,
    expiredGrantHits: mock.counters.expiredGrantHits,
    reResolves,
  };
  await mock.close();
  return row;
}

const rows = [
  await run("A redirect-url-per-chunk", 60 * 60_000, 0, "redirect"),
  await run("B cached-grant", 60 * 60_000, 0, "cached"),
  await run("C cached-grant, 1.5s expiry, pauses", 1_500, 400, "cached"),
];
const result = { experiment: "EXP-003", ranAt: new Date().toISOString(), tbLimitPerMinPerEndpoint: 300, rows };
mkdirSync("docs/experiments/results", { recursive: true });
writeFileSync("docs/experiments/results/exp003.json", JSON.stringify(result, null, 2) + "\n");
console.table(rows);
