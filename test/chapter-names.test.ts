// Skip intro / Skip credits read chapter titles. A file scanned before titles were kept
// gets them from bytes already on this PC: the edge cache's copy of its two ends once
// someone has watched it. Asking for the item never reads from the provider.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-chapnames-"));
process.env.DEBRIDTV_HOME = home;
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("../app/server.ts");

const file = new Uint8Array(readFileSync(new URL("./fixtures/fixture-tracks-chapters.mkv", import.meta.url)));
const KEY = "tb-chapnames-key-0123456789abcdef";
const mock = await startMockProviders({
  files: [{ ref: "tb:1:1", name: "Chapter.Show.S01E01.mkv", bytes: file.byteLength, content: file }],
  account: { token: KEY, premiumUntilMs: Date.now() + 864e5 * 30, plan: "2" },
});
const bases = { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` };
let app = createApp({ port: 0, bases, ffmpeg: false, timers: false });
let base = `http://127.0.0.1:${await app.listen()}`;
after(async () => {
  await app.close();
  await mock.close();
  rmSync(home, { recursive: true, force: true });
});
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 50));
};
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const item = async (id: string) => (await fetch(`${base}/api/item?id=${encodeURIComponent(id)}`)).json();

test("Lean-back: chapter titles come from the scan, and for an older scan from the edge cache once watched, never from the provider", async () => {
  await post("/api/sources", { provider: "torbox", key: KEY });
  await post("/api/scan/start", { perMinute: 600 });
  let id = "";
  await until(async () => {
    id = (await (await fetch(`${base}/api/library/files`)).json()).files[0]?.id ?? "";
    return !!id && (await item(id)).chaptersMs?.length > 0;
  });
  assert.deepEqual((await item(id)).chapterNames, ["Cold open", "Act 1", "Act 2"]);

  // The same file as an earlier version kept it: chapter times, no titles.
  await app.close();
  const lib = JSON.parse(readFileSync(join(home, "library.json"), "utf8"));
  delete lib.items[id].chapterNames;
  writeFileSync(join(home, "library.json"), JSON.stringify(lib));
  app = createApp({ port: 0, bases, ffmpeg: false, timers: false });
  base = `http://127.0.0.1:${await app.listen()}`;

  const before = { calls: JSON.stringify(mock.counters.api), bytes: mock.counters.mediaBytes, reqs: mock.counters.mediaRequests };
  const unwatched = await item(id);
  assert.deepEqual(unwatched.chaptersMs, [0, 2000, 5000]);
  assert.deepEqual(unwatched.chapterNames, [], "not watched yet: nothing on this PC to read them from");
  assert.deepEqual({ calls: JSON.stringify(mock.counters.api), bytes: mock.counters.mediaBytes, reqs: mock.counters.mediaRequests }, before, "asking costs nothing");

  // Watching it (the browser reads the file) fills the edge cache; the titles come from there.
  await (await fetch(`${base}/media/${id}`, { headers: { range: "bytes=0-" } })).arrayBuffer();
  await until(async () => (await (await fetch(`${base}/api/meters`)).json()).cache.files >= 1);
  const watched = { calls: JSON.stringify(mock.counters.api), bytes: mock.counters.mediaBytes, reqs: mock.counters.mediaRequests };
  assert.deepEqual((await item(id)).chapterNames, ["Cold open", "Act 1", "Act 2"]);
  assert.deepEqual({ calls: JSON.stringify(mock.counters.api), bytes: mock.counters.mediaBytes, reqs: mock.counters.mediaRequests }, watched, "read from the cache, not the provider");
});
