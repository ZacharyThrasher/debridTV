// One-click setup for compatibility mode on Windows: when ffmpeg isn't on this PC,
// DebridTV.exe downloads the Windows "release essentials" build from gyan.dev (the
// build ffmpeg.org links to for Windows), checks it against the SHA-256 published
// next to it, and keeps ffmpeg.exe and ffprobe.exe in %LOCALAPPDATA%\DebridTV\ffmpeg.
// Nothing else on the PC changes (no PATH edits, no installer). Turn it off with
// DEBRIDTV_NO_FFMPEG_DOWNLOAD=1.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZIP_URL = process.env.DEBRIDTV_FFMPEG_URL ?? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

export type FetchState =
  | { state: "idle" }
  | { state: "downloading"; pct: number | null; mb: number }
  | { state: "unpacking" }
  | { state: "ready"; path: string }
  | { state: "failed"; error: string };

export const ffmpegFetch: { status: FetchState } = { status: { state: "idle" } };

/** Where the downloaded copy lives. */
export function ffmpegHome(): string {
  const base = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "DebridTV") : join(homedir(), ".debridtv");
  return join(base, "ffmpeg");
}

/** The downloaded ffmpeg.exe, when a complete copy is already here. */
export function downloadedFfmpeg(): string | null {
  const bin = join(ffmpegHome(), "bin");
  const exe = join(bin, "ffmpeg.exe");
  return existsSync(exe) && existsSync(join(bin, "ffprobe.exe")) ? exe : null;
}

/** Download, verify and unpack ffmpeg once. Resolves to ffmpeg.exe's path. Windows only. */
export async function fetchFfmpeg(log: (line: string) => void = () => {}): Promise<string> {
  const have = downloadedFfmpeg();
  if (have) return have;
  const home = ffmpegHome();
  const tmp = join(home, "download");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    ffmpegFetch.status = { state: "downloading", pct: 0, mb: 0 };
    const sumRes = await fetch(`${ZIP_URL}.sha256`);
    if (!sumRes.ok) throw new Error(`checksum download failed (${sumRes.status})`);
    const want = (await sumRes.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) throw new Error("the published checksum looks wrong");

    const res = await fetch(ZIP_URL);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    const zip = join(tmp, "ffmpeg.zip");
    const out = createWriteStream(zip);
    const hash = createHash("sha256");
    let got = 0;
    let lastPct = -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      const pct = total ? Math.floor((got / total) * 100) : null;
      ffmpegFetch.status = { state: "downloading", pct, mb: Math.round(got / 1048576) };
      if (pct != null && pct >= lastPct + 10) {
        lastPct = pct - (pct % 10);
        log(`  Getting ffmpeg for compatibility mode: ${lastPct}%`);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    if (hash.digest("hex") !== want) throw new Error("the download didn't match its published checksum");

    ffmpegFetch.status = { state: "unpacking" };
    // Windows 10 and 11 ship bsdtar, which reads zip files.
    await new Promise<void>((resolve, reject) =>
      execFile("tar", ["-xf", zip, "-C", tmp], { windowsHide: true }, (e) => (e ? reject(new Error(`unpacking failed: ${e.message}`)) : resolve())));
    const found = findBin(tmp);
    if (!found) throw new Error("ffmpeg.exe wasn't in the download");
    const bin = join(home, "bin");
    rmSync(bin, { recursive: true, force: true });
    renameSync(found, bin);
    rmSync(join(bin, "ffplay.exe"), { force: true }); // a player DebridTV never uses
    rmSync(tmp, { recursive: true, force: true });
    const exe = downloadedFfmpeg();
    if (!exe) throw new Error("ffmpeg.exe or ffprobe.exe is missing after unpacking");
    ffmpegFetch.status = { state: "ready", path: exe };
    return exe;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    ffmpegFetch.status = { state: "failed", error: (e as Error).message };
    throw e;
  }
}

/** The folder holding ffmpeg.exe inside the unpacked download (…/ffmpeg-7.x-essentials_build/bin). */
function findBin(dir: string, depth = 0): string | null {
  if (existsSync(join(dir, "ffmpeg.exe")) && existsSync(join(dir, "ffprobe.exe"))) return dir;
  if (depth > 3) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const hit = findBin(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
