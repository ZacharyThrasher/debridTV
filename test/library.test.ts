// Library facts, file states and channel rules: unit level, against the mock providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-lib-"));
process.env.DEBRIDTV_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { Library, fileStatus } = await import("../app/library.ts");
const { Lineup, autoRules } = await import("../app/lineup.ts");
const { Meters } = await import("../app/meters.ts");
const { StationClock } = await import("../src/clock/schedule.ts");
const { parseName } = await import("../src/library/parse.ts");
const { startMockProviders } = await import("../src/providers/mock-server.ts");
type LibItem = import("../app/library.ts").LibItem;

const MIN = 60_000;
let n = 0;
function item(name: string, over: Partial<LibItem> = {}): LibItem {
  n++;
  return { id: `x${n}`, provider: "torbox", ref: `tb:${n}:1`, name, bytes: 1e9, providerState: "download_finished", ready: true,
    parsed: parseName(name), durationMs: 22 * MIN, availability: "listed", present: true, ...over };
}
const show = (name: string, count: number, over: Partial<LibItem> = {}) =>
  Array.from({ length: count }, (_, i) => item(`${name}.S01E${String(i + 1).padStart(2, "0")}.mkv`, over));

test("D5: every failure state has its own message", () => {
  const msgs = new Set<string>();
  const states: Array<[Partial<LibItem>, string, unknown?]> = [
    [{ present: false }, "gone"],
    [{ availability: "policy-blocked" }, "refused"],
    [{ ready: false, providerState: "not_finished" }, "not-ready"],
    [{ ready: false, provider: "realdebrid", providerState: "magnet_error" }, "not-ready"],
    [{}, "account", { premium: false, premiumUntilMs: Date.now() - MIN, checkedAtMs: Date.now() }],
    [{}, "account", { errorKind: "auth", checkedAtMs: Date.now() }],
    [{ availability: "unavailable", availabilityReason: "The media host said 503" }, "problem"],
    [{ durationMs: null }, "needs-scan"],
    [{ excluded: true }, "excluded"],
    [{}, "ready"],
  ];
  for (const [over, want, account] of states) {
    const st = fileStatus(item("Show.S01E01.mkv", over), account as never);
    assert.equal(st.status, want, JSON.stringify(over));
    assert.ok(!msgs.has(st.message), `message reused: ${st.message}`);
    msgs.add(st.message);
  }
  assert.match(fileStatus(item("A.S01E01.mkv", { ready: false, provider: "realdebrid", providerState: "magnet_error" })).message, /failed/);
});

test("D3: the same episode on two providers airs once; editions with other runtimes stay apart (D4)", () => {
  const tb = show("Dup Show", 6);
  const rd = show("Dup Show", 6, { provider: "realdebrid" });
  const longCut = item("Dup.Show.S01E01.Extended.mkv", { durationMs: 41 * MIN });
  const rules = autoRules([...tb, ...rd, longCut], []);
  const ch = rules.find((r) => r.key === "show:dup show")!;
  assert.equal(ch.itemIds.length, 7, "six episodes once each, plus the different cut");
  assert.ok(ch.itemIds.every((id) => !rd.some((r) => r.id === id)), "TorBox copies preferred");
});

test("B5/E6: not-ready, refused, excluded and removed files never reach a channel", () => {
  const good = show("Good Show", 6);
  const bad = [
    ...show("Good Show", 1, { ready: false }).map((i) => ({ ...i, parsed: parseName("Good.Show.S02E01.mkv") })),
    item("Good.Show.S02E02.mkv", { availability: "policy-blocked" }),
    item("Good.Show.S02E03.mkv", { excluded: true }),
    item("Good.Show.S02E04.mkv", { present: false }),
    item("Good.Show.S02E05.mkv", { durationMs: null }),
  ];
  const rules = autoRules([...good, ...bad], []);
  const ids = new Set(rules.flatMap((r) => r.itemIds));
  for (const b of bad) assert.ok(!ids.has(b.id), b.name);
  assert.equal(rules.find((r) => r.key === "show:good show")!.itemIds.length, 6);
});

test("N-03: channel numbers survive a channel disappearing and coming back", () => {
  const lu = new Lineup("lineup-test-numbers.json");
  const a = show("Alpha", 6);
  const b = show("Bravo", 7);
  const clock = new StationClock([]);
  const now = Date.now();
  lu.sync(clock, autoRules([...a, ...b], []), now);
  const before = Object.fromEntries(lu.channels().map((c) => [c.name, c.number]));
  lu.sync(clock, autoRules(b, []), now + MIN);
  assert.equal(lu.channels().some((c) => c.name === "Alpha"), false);
  lu.sync(clock, autoRules([...a, ...b], []), now + 2 * MIN);
  const after = Object.fromEntries(lu.channels().map((c) => [c.name, c.number]));
  assert.deepEqual(after, before);
});

test("F4: lineup choices round-trip through an export, without overriding numbers in use", () => {
  const src = new Lineup("lineup-test-src.json");
  src.saveCustom({ id: "sat", name: "Saturday", showKeys: ["alpha"], movieIds: [], ordering: "cyclic", slotMinutes: 30 });
  src.setHidden("mix:marathon", true);
  src.sync(new StationClock([]), autoRules(show("Alpha", 6), src.custom()), Date.now());
  const exported = JSON.parse(JSON.stringify(src.exportSettings()));
  assert.ok(!JSON.stringify(exported).match(/torboxKey|rdToken/));

  const dst = new Lineup("lineup-test-dst.json");
  const r = dst.importSettings({ ...exported, custom: [...exported.custom, { id: "bad", name: 3 }] });
  assert.deepEqual(r, { custom: 1, hidden: 1, groups: 0 });
  assert.equal(dst.custom()[0]!.name, "Saturday");
  assert.deepEqual(dst.hidden(), ["mix:marathon"]);
  assert.equal(dst.importSettings({ custom: [{ id: "o", name: "Odd", showKeys: [], movieIds: [], ordering: "nonsense" }] }).custom, 1);
  assert.equal(dst.custom().find((c) => c.id === "o")!.ordering, "block-shuffle");
});

test("ETag changes are counted, not acted on; a size change forces the running time to be re-read", () => {
  const lib = new Library(() => ({}), new Meters(), () => {});
  const it = item("Etag.Show.S01E01.mkv", { etag: '"aaa"', bytes: 1000 });
  lib.noteHost(it, new Headers({ etag: '"aaa"', "content-range": "bytes 0-0/1000" }));
  assert.equal(it.etagChanges, undefined);
  lib.noteHost(it, new Headers({ etag: '"bbb"', "content-range": "bytes 0-0/1000" }));
  assert.equal(it.etagChanges, 1);
  assert.equal(it.durationMs, 22 * MIN, "ETag alone does not drop the running time");
  lib.noteHost(it, new Headers({ etag: '"bbb"', "content-range": "bytes 0-0/2000" }));
  assert.equal(it.bytes, 2000);
  assert.equal(it.durationMs, null);
});

test("unfinished torrents are listed, then quietly replaced when they finish", async () => {
  const mock = await startMockProviders({ files: [{ ref: "rd:p1", name: "Pending.Movie.2001.mkv", bytes: 5e8, state: "downloading" }] });
  try {
    const meters = new Meters();
    const lib = new Library(() => ({ rdToken: "x".repeat(20) }), meters, () => {}, { realdebrid: `${mock.baseUrl}/rd` });
    const r1 = await lib.refresh("realdebrid");
    assert.equal(r1.notReady, 1);
    const pending = lib.items().find((i) => i.name.startsWith("Pending"))!;
    assert.equal(pending.ready, false);
    assert.equal(fileStatus(pending).status, "not-ready");
    assert.equal(lib.needsScan(), 0, "nothing to scan: never ask for a link to an unfinished file");

    mock.setFiles([{ ref: "rd:p1", name: "Pending.Movie.2001.mkv", bytes: 5e8 }]);
    const r2 = await lib.refresh("realdebrid");
    assert.equal(r2.removed, 0, "finishing is not removal");
    const now = lib.items().filter((i) => i.name.startsWith("Pending"));
    assert.equal(now.length, 1);
    assert.equal(now[0]!.ready, true);
    assert.equal(meters.api.calls["rd.unrestrict"] ?? 0, 0);
  } finally {
    await mock.close();
  }
});

test("B7: the scan pauses once when told to slow down, and stops on the second time", async () => {
  // Five files, but the mock allows only two link requests a minute.
  const fx = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
  const files = Array.from({ length: 5 }, (_, i) => ({ ref: `tb:${300 + i}:1`, name: `Slow.Show.S01E0${i + 1}.mkv`, bytes: fx.byteLength, content: fx }));
  const mock = await startMockProviders({ files, tbPerMinutePerEndpoint: 2 });
  try {
    const meters = new Meters();
    const lib = new Library(() => ({ torboxKey: "k".repeat(20), scanPerMinute: 120 }), meters, () => {}, { torbox: `${mock.baseUrl}/tb` });
    lib.rateLimitPauseMs = 50;
    await lib.refresh("torbox");
    let paused = false;
    const run = lib.runScan();
    const watch = setInterval(() => (paused ||= !!lib.scan.pausedUntil), 5);
    await run;
    clearInterval(watch);
    assert.ok(paused, "paused after the first 429");
    assert.match(lib.scan.stoppedReason ?? "", /slow down twice/);
    // Rate limits are about the account, not the file: nothing was marked against it.
    assert.ok(lib.items().every((i) => !i.probe?.error), JSON.stringify(lib.items().map((i) => i.probe)));
    assert.equal(lib.items().filter((i) => i.durationMs).length, 2, "the two allowed requests did their job");
  } finally {
    await mock.close();
  }
});

test("Stop ends a scan promptly, even mid-pause", async () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ ref: `tb:${400 + i}:1`, name: `Stop.Show.S01E0${i + 1}.mkv`, bytes: 1000 }));
  const mock = await startMockProviders({ files });
  try {
    const lib = new Library(() => ({ torboxKey: "k".repeat(20), scanPerMinute: 1 }), new Meters(), () => {}, { torbox: `${mock.baseUrl}/tb` });
    await lib.refresh("torbox");
    const t = Date.now();
    const run = lib.runScan();
    setTimeout(() => lib.stopScan("Stopped by test"), 100);
    await run;
    assert.ok(Date.now() - t < 5000, "did not wait out the 60 s pace gap");
    assert.equal(lib.scan.running, false);
  } finally {
    await mock.close();
  }
});

test("D1: a Real-Debrid pack opens up into its files during the scan; samples stay off the air", async () => {
  const fx = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
  const ep = (i: number) => ({ ref: `rd:e${i}`, name: `Pack.Show.S01E0${i}.mkv`, bytes: fx.byteLength, content: fx, pack: "Pack.Show.S01.1080p" });
  const mock = await startMockProviders({ files: [...[1, 2, 3, 4, 5, 6].map(ep), { ref: "rd:smp", name: "Sample/pack.show.sample.mkv", bytes: 500, pack: "Pack.Show.S01.1080p" }] });
  try {
    const meters = new Meters();
    const lib = new Library(() => ({ rdToken: "r".repeat(20), scanPerMinute: 120 }), meters, () => {}, { realdebrid: `${mock.baseUrl}/rd` });
    await lib.refresh("realdebrid");
    assert.equal(lib.pendingPacks(), 1);
    const mine = () => lib.items().filter((i) => i.packId || /pack/i.test(i.name));
    assert.equal(mine().length, 0, "nothing per-file until the pack is opened");
    await lib.runScan();
    assert.equal(meters.api.calls["rd.torrents.info"], 1, "one request to open the pack");
    assert.equal(lib.pendingPacks(), 0);
    assert.equal(mine().length, 7);
    const rules = autoRules(mine(), []);
    const show = rules.find((r) => r.key === "show:pack show")!;
    assert.equal(show.itemIds.length, 6);
    assert.ok(mine().some((i) => i.parsed.kind === "other" && !show.itemIds.includes(i.id)), "the sample is listed but not aired");
    // A refresh keeps the opened files present while the pack is still listed.
    await lib.refresh("realdebrid");
    assert.ok(mine().every((i) => i.present));
  } finally {
    await mock.close();
  }
});

test("N-22b: chapters become mid-program breaks only where they fit the slot", async () => {
  const { midBreakFor } = await import("../app/lineup.ts");
  const { breakpoints } = await import("../app/library.ts");
  assert.deepEqual(breakpoints({ durationMs: 22 * MIN, chaptersMs: [0, 1 * MIN, 7 * MIN, 9 * MIN, 14 * MIN, 21 * MIN] }), [7 * MIN, 14 * MIN]);
  const eps = show("Chap Show", 6, { chaptersMs: [0, 7 * MIN, 14 * MIN] });
  assert.equal(midBreakFor(eps, 30 * MIN), 120_000, "22 min + 2 breaks of 2 min fits a half hour");
  const tight = show("Tight Show", 6, { durationMs: 28 * MIN, chaptersMs: [0, 9 * MIN, 18 * MIN] });
  assert.equal(midBreakFor(tight, 30 * MIN), 60_000, "28 min leaves room for two 1-minute breaks only");
  assert.equal(midBreakFor(show("Plain Show", 6), 30 * MIN), undefined, "no chapters, no invented breaks");
  const rule = autoRules(eps, []).find((r) => r.key === "show:chap show")!;
  assert.equal(rule.midBreakMs, 120_000);
});
