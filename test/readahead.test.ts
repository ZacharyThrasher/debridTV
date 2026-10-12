// Read-ahead on the stream being watched (EXP-012): the server keeps pulling from the
// host past what the player has taken, so a host that goes quiet drains the reserve
// first; a player that leaves has the reserve counted as wasted. Own app and mock.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "debridtv-readahead-"));
process.env.DEBRIDTV_HOME = home;
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");
const { readAheadBytes, READ_AHEAD_MIN, READ_AHEAD_MAX } = await import("../app/readahead.ts");

const SIZE = 12_000_000;
const blob = Uint8Array.from({ length: SIZE }, (_, i) => (i * 13 + (i >> 10)) & 255);
const KEY = "tb-readahead-key-0123456789abcdef";
const mock = await startMockProviders({
  files: [
    { ref: "tb:1:1", name: "Reserve.Show.S01E01.mkv", bytes: SIZE, content: blob },
    { ref: "tb:2:1", name: "Reserve.Show.S01E02.mkv", bytes: SIZE, content: blob },
    { ref: "tb:3:1", name: "Reserve.Show.S01E03.mkv", bytes: 60_000_000 },
  ],
  account: { token: KEY, premiumUntilMs: Date.now() + 864e5 * 30, plan: "2" },
});
const app = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb` }, ffmpeg: false, timers: false, readAheadAfterMs: 300 });
let base = "";
const ids: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
  await fetch(`${base}/api/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "torbox", key: KEY }) });
  for (const f of (await (await fetch(`${base}/api/library/files`)).json()).files) ids[f.name.match(/E0\d/)[0]] = f.id;
});
after(async () => {
  await app.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});

test("about a minute of the file, within bounds", () => {
  // 6 Mb/s for 45 min: 45 MB a minute.
  assert.equal(readAheadBytes(2_025_000_000, 45 * 60_000), 45_000_000);
  assert.equal(readAheadBytes(100_000_000, 45 * 60_000), READ_AHEAD_MIN, "a tiny bitrate still holds a little");
  assert.equal(readAheadBytes(60_000_000_000, 120 * 60_000), READ_AHEAD_MAX, "a 4K remux is capped");
});

test("a stream that was just opened (surfing) reads no further than the player takes", async () => {
  const slow = createApp({ port: 0, bases: { torbox: `${mock.baseUrl}/tb` }, ffmpeg: false, timers: false });
  const b = `http://127.0.0.1:${await slow.listen()}`;
  try {
    await fetch(`${b}/api/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "torbox", key: KEY }) });
    const id = (await (await fetch(`${b}/api/library/files`)).json()).files.find((f: any) => f.name.includes("E03")).id;
    const bytes0 = mock.counters.mediaBytes;
    // A player that takes nothing more after the first bytes (a raw request, paused).
    const req = http.get(`${b}/media/${id}`, { headers: { range: "bytes=0-" } }, (r) => r.once("data", () => r.pause()));
    await sleep(1500);
    const pulled = mock.counters.mediaBytes - bytes0;
    await sleep(1500);
    const later = mock.counters.mediaBytes - bytes0;
    req.destroy();
    // The connection's own buffers fill (several MB on loopback), then nothing more is read.
    assert.ok(later - pulled < 1_000_000, `stopped once the player stopped (${pulled} → ${later} bytes)`);
    assert.ok(later < 20_000_000, `nowhere near a minute's reserve (${later} bytes)`);
  } finally {
    await slow.close();
  }
});

test("the server keeps reading ahead of a slow player, and a host stall drains that first", async () => {
  const bytes0 = mock.counters.mediaBytes;
  const res = await fetch(`${base}/media/${ids.E01}`, { headers: { range: "bytes=0-" } });
  const reader = res.body!.getReader();
  // The player takes nothing for a while: the server still pulls from the host.
  await sleep(1500);
  assert.equal(mock.counters.mediaBytes - bytes0, SIZE, "the whole (small) file is held ahead");
  mock.stallMedia(4000);
  const t0 = Date.now();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
  }
  assert.equal(got, SIZE);
  assert.ok(Date.now() - t0 < 3000, `played on through the stall (${Date.now() - t0} ms)`);
  await sleep(4000 - (Date.now() - t0));
});

test("the reserve fills well past what the connection itself buffers", async () => {
  const id = (await (await fetch(`${base}/api/library/files`)).json()).files.find((f: any) => f.name.includes("E03")).id;
  const bytes0 = mock.counters.mediaBytes;
  const req = http.get(`${base}/media/${id}`, { headers: { range: "bytes=0-" } }, (r) => r.once("data", () => r.pause()));
  await sleep(4000);
  const pulled = mock.counters.mediaBytes - bytes0;
  req.destroy();
  // No running time known here, so the reserve is 32 MiB, on top of the socket's few MB.
  assert.ok(pulled > 32 * 1024 * 1024, `held a reserve (${pulled} bytes)`);
  assert.ok(pulled < 50_000_000, `and stopped at its cap (${pulled} bytes)`);
  const held = (await (await fetch(`${base}/api/meters`)).json()).readAhead.peakBytes;
  assert.ok(held > 30 * 1024 * 1024, `Meters shows the reserve while it is held (${held})`);
});

test("a player that leaves has its unplayed reserve counted as wasted", async () => {
  const before = (await (await fetch(`${base}/api/meters`)).json()).readAhead.wastedBytes;
  const ac = new AbortController();
  const res = await fetch(`${base}/media/${ids.E02}`, { headers: { range: "bytes=0-" }, signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read();
  await sleep(1500);
  ac.abort();
  let wasted = 0;
  for (let i = 0; i < 40 && !wasted; i++) {
    await sleep(50);
    wasted = (await (await fetch(`${base}/api/meters`)).json()).readAhead.wastedBytes - before;
  }
  assert.ok(wasted > SIZE / 2, `most of the file was never played (${wasted} bytes)`);
});
