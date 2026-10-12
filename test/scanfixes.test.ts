// Scan fixes from the Debrid Media Manager deep dive: pack pace, Real-Debrid
// name refusals, pack pairing and account errors. Against the mock providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-scanfix-"));
process.env.DEBRIDTV_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const { Library, fileStatus } = await import("../app/library.ts");
const { dedupe } = await import("../app/lineup.ts");
const { Meters } = await import("../app/meters.ts");
const { classify, rdRefusedTag } = await import("../src/providers/types.ts");
const { startMockProviders } = await import("../src/providers/mock-server.ts");

const fx = new Uint8Array(readFileSync(new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url)));
const rdLib = (base: string, meters = new Meters(), over: Record<string, unknown> = {}, onChange = () => {}) =>
  new Library(() => ({ rdToken: "r".repeat(20), scanPerMinute: 120, ...over }), meters, onChange, { realdebrid: `${base}/rd` });

test("Real-Debrid's refused release tags are read from the file's own name", () => {
  assert.equal(rdRefusedTag("Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP.mkv"), "WEB-DL");
  assert.equal(rdRefusedTag("show.s01e01.1080p.web-dl.x265.mkv"), "web-dl");
  assert.equal(rdRefusedTag("Film.2020.1080p.WEBRip.x264.mkv"), "WEBRip");
  assert.equal(rdRefusedTag("Film.2020.1080p.BluRay.x264-GRP.mkv"), "BluRay.x264");
  assert.equal(rdRefusedTag("Film.2020.1080p.BluRay.DTS.x264.mkv"), "BluRay.DTS");
  assert.equal(rdRefusedTag("Show.S01E02.720p.HDTV.x264-GRP.mkv"), "HDTV.x264");
  assert.equal(rdRefusedTag("Show.S01E02.1080p.WEB.h264-GRP.mkv"), "WEB.h264");
  // Only the exact dot or hyphen counts.
  for (const ok of ["Show.S01E01.1080p.WEB.DL.x265.mkv", "Show.S01E01.WEBDL.mkv", "Film.2020.1080p.BluRay-x264.mkv", "Film.2006.BluRay.DTS-HD.MA.5.1.REMUX.mkv", "Show.S01E01.1080p.WEB-x264.mkv", "Show.S01E01.1080p.x265.mkv"])
    assert.equal(rdRefusedTag(ok), null, ok);
  // A pack folder's name doesn't decide whether a file inside it streams.
  assert.equal(rdRefusedTag("Show.S01.1080p.WEB-DL/Show.S01E01.1080p.x265.mkv"), null);
});

test("Real-Debrid account refusals and missing files get their own error kinds", () => {
  assert.equal(classify(401, '{"error":"bad_token","error_code":8}').kind, "auth");
  assert.equal(classify(403, '{"error":"permission_denied","error_code":9}').kind, "account");
  assert.equal(classify(403, '{"error":"account_locked","error_code":14}').kind, "account");
  assert.equal(classify(503, '{"error":"unavailable_file","error_code":24}').kind, "gone");
  assert.equal(classify(403, '{"success":false,"error":"PLAN_RESTRICTED_FEATURE"}').kind, "account");
  assert.equal(classify(403, '{"success":false,"error":"AUTH_ERROR"}').kind, "auth");
});

test("a Real-Debrid file with a refused tag is kept off the air without a request; another copy airs", async () => {
  const mock = await startMockProviders({
    files: [
      { ref: "rd:b1", name: "Tagged.Show.S01E01.1080p.WEB-DL.x265.mkv", bytes: fx.byteLength, content: fx },
      { ref: "rd:b2", name: "Tagged.Show.S01E02.1080p.WEB.DL.x265.mkv", bytes: fx.byteLength, content: fx },
    ],
  });
  try {
    const meters = new Meters();
    const lib = rdLib(mock.baseUrl, meters);
    await lib.refresh("realdebrid");
    const byName = (s: string) => lib.items().find((i) => i.name.includes(s))!;
    const blocked = byName("E01");
    assert.equal(blocked.availability, "policy-blocked");
    assert.equal(blocked.nameBlocked, "WEB-DL");
    assert.match(fileStatus(blocked).message, /won't stream files with "WEB-DL"/);
    assert.equal(byName("E02").nameBlocked, undefined);
    await lib.runScan();
    assert.equal(meters.api.calls["rd.unrestrict"], 1, "only the file with a clean name asked for a link");
    assert.equal(byName("E01").durationMs, null);
    assert.ok(byName("E02").durationMs);
    // The same episode from TorBox is the copy that airs.
    const tbCopy = { ...byName("E01"), id: "tbcopy", provider: "torbox" as const, ref: "tb:1:1", nameBlocked: undefined, availability: "listed" as const, durationMs: 1000 };
    const kept = dedupe([{ ...byName("E01"), durationMs: 1000 }, tbCopy]);
    assert.deepEqual(kept.map((i) => i.id), ["tbcopy"]);
    // "Check now" got a link: the name no longer holds it back, even after a refresh.
    lib.clearNameBlock(blocked.id);
    lib.markAvailability(blocked.id, "playable");
    await lib.refresh("realdebrid");
    assert.equal(byName("E01").availability, "playable");
    assert.equal(byName("E01").nameBlocked, undefined);
  } finally {
    await mock.close();
  }
});

test("a pack whose files and links don't pair stays unopened; the scan carries on", async () => {
  const mock = await startMockProviders({
    files: [
      { ref: "rd:m1", name: "Odd.Show.S01E01.mkv", bytes: fx.byteLength, content: fx, pack: "Odd.Show.S01" },
      { ref: "rd:m2", name: "Odd.Show.S01E02.mkv", bytes: fx.byteLength, content: fx, pack: "Odd.Show.S01", noLink: true },
      { ref: "rd:m3", name: "Odd.Show.S01E03.mkv", bytes: fx.byteLength, content: fx, pack: "Odd.Show.S01" },
      { ref: "rd:g1", name: "Good.Show.S01E01.mkv", bytes: fx.byteLength, content: fx, pack: "Good.Show.S01" },
      { ref: "rd:g2", name: "Good.Show.S01E02.mkv", bytes: fx.byteLength, content: fx, pack: "Good.Show.S01" },
    ],
  });
  try {
    const meters = new Meters();
    const lib = rdLib(mock.baseUrl, meters);
    await lib.refresh("realdebrid");
    assert.equal(lib.pendingPacks(), 2);
    await lib.runScan();
    assert.equal(lib.scan.stoppedReason, undefined);
    assert.equal(lib.pendingPacks(), 0, "the odd pack no longer counts as waiting");
    assert.equal(lib.items().filter((i) => i.name.startsWith("Odd")).length, 0, "no file of the odd pack was guessed at");
    assert.equal(lib.items().filter((i) => i.name.startsWith("Good") && i.durationMs).length, 2);
    // A second scan doesn't ask about the odd pack again.
    const before = meters.api.calls["rd.torrents.info"];
    await lib.runScan();
    assert.equal(meters.api.calls["rd.torrents.info"], before);
  } finally {
    await mock.close();
  }
});

test("packs open at their own pace, not the slower file-timing pace", async () => {
  const files = [1, 2, 3, 4].flatMap((p) => [1, 2].map((e) => ({ ref: `rd:p${p}e${e}`, name: `Pace${p}.Show.S01E0${e}.mkv`, bytes: fx.byteLength, content: fx, pack: `Pace${p}.Show.S01` })));
  const mock = await startMockProviders({ files });
  try {
    const meters = new Meters();
    const opened: number[] = [];
    const lib: InstanceType<typeof Library> = rdLib(mock.baseUrl, meters, { scanPerMinute: 10 }, () => {
      const n = meters.api.calls["rd.torrents.info"] ?? 0;
      if (n > opened.length) opened.push(Date.now());
      if (n === 4 && lib.pendingPacks() === 0) lib.stopScan();
    });
    await lib.refresh("realdebrid");
    // No listed single files, so no head start: the scan opens the packs first.
    await lib.runScan();
    assert.equal(opened.length, 4);
    const span = opened[3]! - opened[0]!;
    // 10 files a minute would be 6 s between packs; 120 packs a minute is 0.5 s.
    assert.ok(span < 2500, `three gaps took ${span} ms`);
  } finally {
    await mock.close();
  }
});
