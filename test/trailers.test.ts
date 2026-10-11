// Coming Attractions (N-23c): local trailer files, found by Kodi's naming, timed
// like any local file and aired back to back on their own channel. Local only:
// no provider is asked and no provider bytes are read.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-trailers-home-"));
process.env.DEBRIDTV_HOME = home;
const { localTrailer, displayTitle } = await import("../app/library.ts");
const { parseName } = await import("../src/library/parse.ts");
const { createApp } = await import("../app/server.ts");

const root = mkdtempSync(join(tmpdir(), "debridtv-trailers-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const fixture = new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url);
const put = (...p: string[]) => {
  mkdirSync(join(root, ...p.slice(0, -1)), { recursive: true });
  copyFileSync(fixture, join(root, ...p));
};

test("N-23c: trailers are found by name beside the film or in its Trailers folder; films and episodes are not trailers", () => {
  const r = "/lib";
  assert.deepEqual(localTrailer("/lib/Heat (1995)/Heat (1995)-trailer.mkv", r), { title: "Heat", titleKey: "heat", year: 1995 });
  assert.deepEqual(localTrailer("/lib/Alien.1979-trailer.mp4", r), { title: "Alien", titleKey: "alien", year: 1979 });
  assert.deepEqual(localTrailer("/lib/Ronin (1998)/Trailers/Teaser 2.mkv", r), { title: "Ronin", titleKey: "ronin", year: 1998 });
  assert.deepEqual(localTrailer("/lib/Ronin (1998)/trailer.mkv", r), { title: "Ronin", titleKey: "ronin", year: 1998 });
  assert.equal(localTrailer("/lib/Heat (1995)/Heat (1995).mkv", r), null, "the film itself");
  assert.equal(localTrailer("/lib/Trailer.Park.S01E01.mkv", r), null, "an episode with trailer in its name");
  assert.equal(localTrailer("/lib/trailer.mkv", r), null, "nothing names the film");
  assert.equal(localTrailer("/lib/Heat (1995)/Featurettes/Making of.mkv", r), null, "other extras aren't trailers");
  assert.equal(displayTitle({ parsed: parseName("x-trailer.mkv"), name: "x-trailer.mkv", trailer: { title: "Heat", titleKey: "heat", year: 1995 } } as never), "Heat (1995) · trailer");
});

test("N-23c: Coming Attractions airs local trailers back to back and points at the film when it's here", async () => {
  put("Films", "Heat (1995)", "Heat (1995).mkv");
  put("Films", "Heat (1995)", "Heat (1995)-trailer.mkv");
  put("Films", "Ronin (1998)", "Trailers", "Teaser.mkv");
  put("Films", "Alien.1979-trailer.mkv");
  put("Films", "Making Of", "Featurettes", "Heat.featurette.mkv");
  const app = createApp({ port: 0, ffmpeg: false, timers: false });
  const base = `http://127.0.0.1:${await app.listen()}`;
  try {
    const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post("/api/sources", { provider: "local", dirs: [join(root, "Films")] })).status, 200);
    await post("/api/scan/start", { perMinute: 600 });
    let ch: any;
    for (let t = 0; t < 100 && !ch; t++) {
      await new Promise((r) => setTimeout(r, 100));
      ch = ((await (await fetch(`${base}/api/bootstrap`)).json()) as any).channels.find((c: any) => c.kind === "trailers");
    }
    assert.ok(ch, "Coming Attractions on the air");
    assert.equal(ch.name, "Coming Attractions");
    const from = Date.now();
    const g = (await (await fetch(`${base}/api/guide?from=${from}&to=${from + 60_000}`)).json()) as any;
    const airings = g.rows.find((r: any) => r.channel.id === ch.id).airings;
    assert.ok(airings.length >= 3);
    for (let i = 1; i < airings.length; i++) assert.equal(airings[i].start, airings[i - 1].end, "back to back");
    assert.ok(airings.every((a: any) => a.kind === "trailer" && a.end - a.start < 10_000), "no padding to a slot");
    const heat = airings.find((a: any) => a.title === "Heat");
    assert.equal(heat.year, 1995);
    assert.ok(heat.trailerFor.itemId, "the film is in the library");
    const alien = airings.find((a: any) => a.title === "Alien");
    assert.deepEqual(alien.trailerFor, { title: "Alien", year: 1979, itemId: null });
    const files = (await (await fetch(`${base}/api/library/files?q=featurette`)).json()) as any;
    assert.equal(files.files[0].status, "other", "featurettes stay unscheduled");
    const meters = (await (await fetch(`${base}/api/meters`)).json()) as any;
    assert.equal(meters.apiTotal, 0);
  } finally {
    await app.close();
  }
});
