// Edge cache (ADR-0003): a read starting inside a cached head is answered at once,
// and the host is asked only for what follows. Own app and mock so file counts
// elsewhere don't change.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-edge-"));
process.env.DEBRIDTV_HOME = home;
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");
const { EdgeCache, HEAD_BYTES } = await import("../app/edgecache.ts");

// 1.5 MB of patterned bytes: bigger than the 1 MiB head.
const big = Uint8Array.from({ length: 1_500_000 }, (_, i) => (i * 31 + (i >> 8)) & 255);
const KEY = "tb-edge-key-0123456789abcdef";
const mock = await startMockProviders({
  files: [{ ref: "tb:1:1", name: "Big.Blob.S01E01.mkv", bytes: big.byteLength, content: big }],
  account: { token: KEY, premiumUntilMs: Date.now() + 864e5 * 30, plan: "2" },
});
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` }, ffmpeg: false, timers: false });
let base = "";
before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
  await fetch(`${base}/api/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "torbox", key: KEY }) });
});
after(async () => {
  await app.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 50));
};

test("a read inside the cached head starts here; only bytes past it come from the host", async () => {
  const id = (await (await fetch(`${base}/api/library/files`)).json()).files[0].id;
  const first = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=0-1199999" } })).arrayBuffer());
  assert.deepEqual(first, big.subarray(0, 1_200_000));
  await until(async () => (await (await fetch(`${base}/api/meters`)).json()).cache.files >= 1);
  const before = mock.counters.mediaBytes;
  const res = await fetch(`${base}/media/${id}`, { headers: { range: "bytes=500000-" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 500000-1499999/1500000");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), big.subarray(500_000));
  await until(async () => mock.counters.mediaBytes - before >= big.byteLength - HEAD_BYTES);
  assert.equal(mock.counters.mediaBytes - before, big.byteLength - HEAD_BYTES);
  // That read ran to the end of the file, so the tail is cached too.
  const before2 = mock.counters.mediaRequests;
  const tail = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=1400000-" } })).arrayBuffer());
  assert.deepEqual(tail, big.subarray(1_400_000));
  assert.equal(mock.counters.mediaRequests, before2);
  // Forget everything clears it.
  await fetch(`${base}/api/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "forget everything" }) });
  assert.equal((await (await fetch(`${base}/api/meters`)).json()).cache.files, 0);
});

test("the cache stays within its limit, least recently used first, and drops a file whose size changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "debridtv-edge-unit-"));
  try {
    const c = new EdgeCache(dir, 2.5 * 1024 * 1024);
    const fill = (id: string, size: number) => {
      const w = c.observe(id, size, 0);
      w.chunk(new Uint8Array(Math.min(size, HEAD_BYTES + 10)));
      w.done(false);
    };
    fill("a", 5e6);
    fill("b", 5e6);
    fill("c", 5e6);
    assert.equal(c.entries(), 2);
    assert.equal(c.get("a"), null, "oldest went");
    assert.ok(c.bytes() <= 2.5 * 1024 * 1024);
    assert.equal(c.get("b", 6e6), null, "size changed: dropped");
    assert.ok(c.read("c", 0, 99)?.length === 100);
    assert.equal(c.read("c", HEAD_BYTES - 10, HEAD_BYTES + 10), null, "past the head isn't cached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
