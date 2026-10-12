// The Windows app's ffmpeg download refuses anything that doesn't match the published checksum.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

test("a download that doesn't match its checksum is refused and cleaned up", async () => {
  const home = mkdtempSync(join(tmpdir(), "debridtv-ff-"));
  process.env.HOME = home;
  process.env.LOCALAPPDATA = home;
  const body = Buffer.from("not really a zip");
  const wrong = createHash("sha256").update("something else").digest("hex");
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith(".sha256")) return res.end(`${wrong} *ffmpeg.zip\n`);
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.DEBRIDTV_FFMPEG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ffmpeg.zip`;
  try {
    const { fetchFfmpeg, ffmpegFetch, ffmpegHome, downloadedFfmpeg } = await import("../app/ffmpeg-fetch.ts");
    await assert.rejects(fetchFfmpeg(), /checksum/);
    assert.equal(ffmpegFetch.status.state, "failed");
    assert.equal(downloadedFfmpeg(), null);
    assert.ok(!existsSync(join(ffmpegHome(), "download")), "the partial download is removed");
    assert.deepEqual(readdirSync(ffmpegHome()), []);
  } finally {
    server.close();
  }
});
