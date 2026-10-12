// Next-show pre-load (ADR-0006): the two ends of the next file, fetched ahead for
// the channel being watched, cancellable, never for a refused copy, and counted.
// Own app and mock so file counts elsewhere don't change.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-preload-"));
process.env.DEBRIDTV_HOME = home;
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");
const { HEAD_BYTES, TAIL_BYTES } = await import("../app/edgecache.ts");
const { PreloadLedger } = await import("../app/preload.ts");

const blob = (n: number, k: number) => Uint8Array.from({ length: n }, (_, i) => (i * k + (i >> 9)) & 255);
const a = blob(3_000_000, 31);
const b = blob(3_000_000, 17);
const KEY = "tb-preload-key-0123456789abcdef";
const mock = await startMockProviders({
  files: [
    { ref: "tb:1:1", name: "Next.Show.S01E01.mkv", bytes: a.byteLength, content: a },
    { ref: "tb:2:1", name: "Next.Show.S01E02.mkv", bytes: b.byteLength, content: b },
    { ref: "rd:R3", name: "Next.Show.S01E03.mkv", bytes: 2_000_000, policy: true },
  ],
  mediaTtfbMs: 50,
  linkBytesPerSec: 2_000_000,
  account: { token: KEY, premiumUntilMs: Date.now() + 864e5 * 30, plan: "2" },
});
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` }, ffmpeg: false, timers: false });
let base = "";
let ids: Record<string, string> = {};
const post = (p: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
const meters = async () => (await fetch(`${base}/api/meters`)).json();
before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
  await post("/api/sources", { provider: "torbox", key: KEY });
  await post("/api/sources", { provider: "realdebrid", key: KEY });
  const files = (await (await fetch(`${base}/api/library/files`)).json()).files;
  for (const f of files) ids[f.name.match(/E0\d/)[0]] = f.id;
});
after(async () => {
  await app.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

test("a pre-load fetches only the file's two cached ends; the tune is then answered from this PC", async () => {
  const id = ids.E01!;
  const bytes0 = mock.counters.mediaBytes;
  const r = await (await post("/api/preload", { itemId: id })).json();
  assert.equal(r.ok, true);
  assert.equal(r.bytes, HEAD_BYTES + TAIL_BYTES);
  assert.equal(mock.counters.mediaBytes - bytes0, HEAD_BYTES + TAIL_BYTES, "nothing past the head and tail");
  let m = await meters();
  assert.equal(m.bytes.preload, HEAD_BYTES + TAIL_BYTES);
  assert.equal(m.bytes.playback, 0, "pre-load bytes are counted apart from watched bytes");
  assert.equal(m.preload.apiCalls, 1, "one link, reused by the tune");
  assert.equal(m.preload.pendingBytes, HEAD_BYTES + TAIL_BYTES);

  // The player opening the file: header and index come from the cache, no host request.
  const reqs = mock.counters.mediaRequests;
  const head = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=0-65535" } })).arrayBuffer());
  const tail = new Uint8Array(await (await fetch(`${base}/media/${id}`, { headers: { range: `bytes=${a.byteLength - 4096}-` } })).arrayBuffer());
  assert.deepEqual(head, a.subarray(0, 65536));
  assert.deepEqual(tail, a.subarray(a.byteLength - 4096));
  assert.equal(mock.counters.mediaRequests, reqs);
  m = await meters();
  assert.equal(m.preload.used, 1);
  assert.equal(m.preload.usedBytes, HEAD_BYTES + TAIL_BYTES);

  // Asking again costs nothing: both ends are already here.
  const again = await (await post("/api/preload", { itemId: id })).json();
  assert.equal(again.cached, true);
  assert.equal(mock.counters.mediaBytes - bytes0, HEAD_BYTES + TAIL_BYTES);
});

test("dropping the request stops the host fetch at once (the viewer changed channel)", async () => {
  const id = ids.E02!;
  const bytes0 = mock.counters.mediaBytes;
  const ac = new AbortController();
  const p = post("/api/preload", { itemId: id }, ac.signal).catch(() => null);
  // 2 MB/s from the mock: about 0.2 MB has arrived after 150 ms.
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  await p;
  let m = await meters();
  for (let i = 0; i < 40 && m.preload.cancelled < 1; i++) {
    await new Promise((r) => setTimeout(r, 25));
    m = await meters();
  }
  assert.equal(m.preload.cancelled, 1);
  await new Promise((r) => setTimeout(r, 300));
  const pulled = mock.counters.mediaBytes - bytes0;
  assert.ok(pulled < HEAD_BYTES / 2, `stopped early (${pulled} bytes)`);
});

test("never for a refused copy, a demo item, or something unknown; a refusal is recorded, not retried", async () => {
  assert.equal((await post("/api/preload", { itemId: "nope" })).status, 404);
  const calls = () => Object.entries(mock.counters.api).filter(([k]) => k.startsWith("rd.unrestrict")).reduce((n, [, v]) => n + v, 0);
  const calls0 = calls();
  const r = await (await post("/api/preload", { itemId: ids.E03 })).json();
  assert.equal(r.policy, true);
  const item = await (await fetch(`${base}/api/item?id=${ids.E03}`)).json();
  assert.equal(item.availability, "policy-blocked");
  const r2 = await (await post("/api/preload", { itemId: ids.E03 })).json();
  assert.equal(r2.skipped, "policy-blocked");
  assert.equal(calls() - calls0, 1, "asked the provider once");
});

test("a pre-load nobody plays is written off as wasted", () => {
  let t = 0;
  const l = new PreloadLedger({ now: () => t, wasteAfterMs: 1000 });
  l.begin("x");
  l.bytes("x", 500);
  l.end("x", "cancelled");
  l.begin("y");
  l.bytes("y", 300);
  l.end("y", "done");
  l.played("y");
  assert.equal(l.snapshot().pendingBytes, 500);
  t = 2000;
  const s = l.snapshot();
  assert.deepEqual({ used: s.used, wasted: s.wasted, wastedBytes: s.wastedBytes, usedBytes: s.usedBytes, cancelled: s.cancelled, pendingBytes: s.pendingBytes },
    { used: 1, wasted: 1, wastedBytes: 500, usedBytes: 300, cancelled: 1, pendingBytes: 0 });
});
