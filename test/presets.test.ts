// Seasonal presets (N-02a): offered from the library's own genres, added as a
// content group with its own channel that airs only between its dates (N-32).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-presets-"));
process.env.DEBRIDTV_HOME = home;

const { createApp } = await import("../app/server.ts");
const { presetMatches, SEASONAL_PRESETS } = await import("../app/lineup.ts");
const { parseName } = await import("../src/library/parse.ts");
type LibItem = import("../app/library.ts").LibItem;

const MIN = 60_000;
const app = createApp({ port: 0, ffmpeg: false, timers: false });
let base = "";
before(async () => {
  base = `http://127.0.0.1:${await app.listen()}`;
});
after(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

let n = 0;
const item = (name: string, meta: Partial<LibItem["meta"] & object> = {}, minutes = 90): LibItem => ({
  id: `p${++n}`, provider: "local", ref: name, name, bytes: 1, providerState: "on disk", ready: true, parsed: parseName(name),
  durationMs: minutes * MIN, availability: "playable", present: true, meta: { kind: "movie", ...meta } as LibItem["meta"],
});

test("N-02a: a preset matches by genre, tag or a holiday word in the name, films in release order", () => {
  const holidays = SEASONAL_PRESETS.find((p) => p.id === "s-holidays")!;
  const lib = [
    item("Snow.Day.Christmas.1999.mkv"),
    item("Quiet.Film.1980.mkv", { tags: ["Christmas"] }),
    item("Other.Film.1990.mkv", { genres: ["Holiday"] }),
    item("Not.This.One.1991.mkv", { genres: ["Drama"] }),
    item("Santa.Show.S01E01.mkv", { kind: "episode" } as never, 22),
    item("Santa.Show.S01E02.mkv", { kind: "episode" } as never, 22),
  ];
  const m = presetMatches(holidays, lib);
  assert.deepEqual([m.shows, m.films], [1, 3]);
  assert.deepEqual(m.entries.slice(1).map((e) => (e.kind === "movie" ? e.id : "")), [lib[1]!.id, lib[2]!.id, lib[0]!.id], "by year");
  assert.equal(presetMatches(SEASONAL_PRESETS.find((p) => p.id === "s-summer")!, lib).entries.length, 0);
});

test("N-02a: only presets the library has enough for are offered; adding one makes a seasonal channel", async () => {
  const { presets } = await get("/api/presets");
  const ids = presets.map((p: any) => p.id).sort();
  assert.deepEqual(ids, ["s-holidays", "s-october-horror"], "the demo has horror and holiday films, no adventure");
  const horror = presets.find((p: any) => p.id === "s-october-horror");
  assert.deepEqual([horror.films, horror.added, horror.season.from, horror.season.to], [3, false, "10-01", "10-31"]);

  assert.equal((await post("/api/presets", { id: "nope" })).status, 404);
  const r = await post("/api/presets", { id: "s-october-horror" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.preset.added, true);
  assert.ok(r.body.preset.channel.number >= 60, "group channels take numbers from 60");
  const settings = await get(`/api/channels/${r.body.preset.channel.id}/settings`);
  assert.deepEqual([settings.season.from, settings.season.to], ["10-01", "10-31"]);
  const groups = (await get("/api/groups")).groups;
  assert.equal(groups.find((g: any) => g.id === "s-october-horror").programs, 3);

  // Adding again refreshes it in place: one group, one channel.
  const again = await post("/api/presets", { id: "s-october-horror" });
  assert.equal(again.body.preset.channel.id, r.body.preset.channel.id);
  assert.equal((await get("/api/groups")).groups.filter((g: any) => g.id === "s-october-horror").length, 1);
});
