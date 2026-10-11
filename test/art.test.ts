// Local artwork (N-01c): Kodi-named pictures beside the viewer's own files, found
// during the folder walk, served by id, never read above the chosen folder and
// never fetched from the internet.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-art-home-"));
process.env.DEBRIDTV_HOME = home;
const { localArt } = await import("../app/library.ts");
const { createApp } = await import("../app/server.ts");

const root = mkdtempSync(join(tmpdir(), "debridtv-art-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const put = (...p: string[]) => {
  mkdirSync(join(root, ...p.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...p), png);
};

test("N-01c: movie art beside the file, and folder art only when the film has the folder to itself", () => {
  put("Films", "Heat (1995)", "Heat.1995.mkv");
  put("Films", "Heat (1995)", "poster.jpg");
  put("Films", "Heat (1995)", "fanart.png");
  put("Films", "Other.2001.mkv");
  put("Films", "Other.2001-poster.jpg");
  put("Films", "Third.2003.mkv");
  put("Films", "poster.jpg"); // belongs to no single film
  const films = join(root, "Films");
  const heat = localArt(join(films, "Heat (1995)", "Heat.1995.mkv"), films, "movie")!;
  assert.match(heat.poster!, /Heat \(1995\)[/\\]poster\.jpg$/);
  assert.match(heat.fanart!, /fanart\.png$/);
  assert.match(localArt(join(films, "Other.2001.mkv"), films, "movie")!.poster!, /Other\.2001-poster\.jpg$/);
  assert.equal(localArt(join(films, "Third.2003.mkv"), films, "movie"), null);
  assert.equal(localArt(join(films, "x.mkv"), films, "other"), null);
});

test("N-01c: episodes get their thumb, the season poster before the show's, and the show's logo; never the chosen folder's", () => {
  put("TV", "Cartoon Hour", "Season 1", "Cartoon.Hour.S01E01.mkv");
  put("TV", "Cartoon Hour", "Season 1", "Cartoon.Hour.S01E01-thumb.jpg");
  put("TV", "Cartoon Hour", "season01-poster.jpg");
  put("TV", "Cartoon Hour", "poster.jpg");
  put("TV", "Cartoon Hour", "fanart.jpg");
  put("TV", "Cartoon Hour", "clearlogo.png");
  put("TV", "poster.jpg");
  put("TV", "Loose.Show.S01E01.mkv");
  const tv = join(root, "TV");
  const a = localArt(join(tv, "Cartoon Hour", "Season 1", "Cartoon.Hour.S01E01.mkv"), tv, "episode")!;
  assert.match(a.thumb!, /S01E01-thumb\.jpg$/);
  assert.match(a.poster!, /season01-poster\.jpg$/);
  assert.match(a.fanart!, /Cartoon Hour[/\\]fanart\.jpg$/);
  assert.match(a.logo!, /clearlogo\.png$/);
  assert.equal(localArt(join(tv, "Loose.Show.S01E01.mkv"), tv, "episode"), null, "the library root's poster is nobody's");
  // Never above the chosen folder.
  const season = join(tv, "Cartoon Hour", "Season 1");
  assert.deepEqual(Object.keys(localArt(join(season, "Cartoon.Hour.S01E01.mkv"), season, "episode") ?? {}), ["thumb"]);
});

test("N-01c: airings carry /api/art URLs, the server sends the picture, and paths never reach the browser", async () => {
  const show = join(root, "Lib", "Night Owls");
  mkdirSync(show, { recursive: true });
  const fixture = new URL("./fixtures/fixture-h264-aac.mkv", import.meta.url);
  for (let i = 1; i <= 8; i++) copyFileSync(fixture, join(show, `Night.Owls.S01E0${i}.mkv`));
  writeFileSync(join(show, "poster.jpg"), png);
  writeFileSync(join(show, "clearlogo.png"), png);
  const app = createApp({ port: 0, ffmpeg: false, timers: false });
  const base = `http://127.0.0.1:${await app.listen()}`;
  try {
    const post = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post("/api/sources", { provider: "local", dirs: [join(root, "Lib")] })).status, 200);
    await post("/api/scan/start", { perMinute: 600 });
    let ch: any;
    for (let t = 0; t < 100 && !ch; t++) {
      await new Promise((r) => setTimeout(r, 100));
      ch = ((await (await fetch(`${base}/api/bootstrap`)).json()) as any).channels.find((c: any) => c.name === "Night Owls");
    }
    assert.ok(ch, "show channel on the air");
    assert.match(ch.art.logo, /^\/api\/art\/[\w-]+\/logo$/);
    const now = (await (await fetch(`${base}/api/now?channel=${ch.id}`)).json()) as any;
    assert.match(now.airing.art.poster, /^\/api\/art\/[\w-]+\/poster$/);
    assert.doesNotMatch(JSON.stringify(now), /poster\.jpg|Night Owls[/\\]/);
    const pic = await fetch(base + now.airing.art.poster);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await pic.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/api/art/${now.airing.itemId}/fanart`)).status, 404);
    assert.equal((await fetch(`${base}/api/art/nope/poster`)).status, 404);
  } finally {
    await app.close();
  }
});
