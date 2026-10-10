import { test } from "node:test";
import assert from "node:assert/strict";
import { startMockProviders } from "../src/providers/mock-server.ts";
import { TorBoxClient } from "../src/providers/clients.ts";
import { GrantCache } from "../src/tuner/grants.ts";
import { Tuner } from "../src/tuner/tuner.ts";

const MB = 1_000_000;
const files = Array.from({ length: 4 }, (_, i) => ({ ref: `tb:${i}:0`, name: `f${i}`, bytes: 50 * MB }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("B3/E4: surfing with cancel + dwell sends one resolve and one stream", async () => {
  const mock = await startMockProviders({ files, apiLatencyMs: 20, linkBytesPerSec: 20 * MB });
  const tb = new TorBoxClient(`${mock.baseUrl}/tb`, "fixture");
  const tuner = new Tuner({ strategy: "dwell", dwellMs: 150, bufferTargetBytes: 2 * MB, grants: new GrantCache() });
  let last;
  for (const f of [...files, ...files]) {
    last = tuner.tune({ channelId: f.ref, client: tb, ref: f.ref, byteOffset: 0 });
    await sleep(40);
  }
  assert.equal((await last!).status, "playing");
  assert.equal(mock.counters.api["tb.requestdl"], 1);
  assert.equal(mock.counters.mediaRequests, 1);
  tuner.stopAll();
  await sleep(100);
  assert.equal(mock.counters.activeMedia, 0, "B4: stop releases every stream");
  await mock.close();
});

test("E4: grant cache dedupes concurrent resolves for the same file", async () => {
  const mock = await startMockProviders({ files, apiLatencyMs: 30 });
  const tb = new TorBoxClient(`${mock.baseUrl}/tb`, "fixture");
  const cache = new GrantCache();
  const grants = await Promise.all([1, 2, 3].map(() => cache.get(tb, "tb:0:0")));
  assert.equal(new Set(grants.map((g) => g.url)).size, 1);
  assert.equal(mock.counters.api["tb.requestdl"], 1);
  await mock.close();
});
