// The player for DebridTV's app window on Windows: mpv, from the mpv project's own
// release on GitHub. DebridTV.exe downloads it the first time, checks it against
// the SHA-256 pinned below, and keeps it in %LOCALAPPDATA%\DebridTV\mpv. DebridTV
// never ships mpv itself; it runs the official build as a separate program.
// Turn the download off with DEBRIDTV_NO_MPV_DOWNLOAD=1 (the window then plays
// video the way Edge does).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MPV_VERSION = "0.41.0";
const ZIP_URL = process.env.DEBRIDTV_MPV_URL ?? `https://github.com/mpv-player/mpv/releases/download/v${MPV_VERSION}/mpv-v${MPV_VERSION}-x86_64-pc-windows-msvc.zip`;
// GitHub's digest for that file. A different URL needs its own sum (DEBRIDTV_MPV_SHA256).
const ZIP_SHA256 = process.env.DEBRIDTV_MPV_SHA256 ?? "4e197f729f5071c6772f35fffd96e0f36e3e8a044bd9479b136bb09b7c6a80ff";

/** Where the downloaded copy lives. */
export function mpvHome(): string {
  const base = process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "DebridTV") : join(homedir(), ".debridtv");
  return join(base, "mpv");
}

/** The downloaded mpv.exe, when a complete copy of this version is here. */
export function downloadedMpv(): string | null {
  const exe = join(mpvHome(), MPV_VERSION, "mpv.exe");
  return existsSync(exe) ? exe : null;
}

let inFlight: Promise<string> | null = null;

/** Download, verify and unpack mpv once. Resolves to mpv.exe's path. Windows only. */
export function fetchMpv(log: (line: string) => void = () => {}): Promise<string> {
  const have = downloadedMpv();
  if (have) return Promise.resolve(have);
  inFlight ??= download(log).finally(() => (inFlight = null));
  return inFlight;
}

async function download(log: (line: string) => void): Promise<string> {
  const home = mpvHome();
  const tmp = join(home, "download");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const res = await fetch(ZIP_URL);
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    const zip = join(tmp, "mpv.zip");
    const out = createWriteStream(zip);
    const hash = createHash("sha256");
    let got = 0;
    let lastPct = -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      const pct = total ? Math.floor((got / total) * 100) : null;
      if (pct != null && pct >= lastPct + 20) {
        lastPct = pct - (pct % 20);
        log(`  Getting the video player (mpv ${MPV_VERSION}): ${lastPct}%`);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    const sum = hash.digest("hex");
    if (sum !== ZIP_SHA256.toLowerCase()) throw new Error(`the download didn't match its pinned checksum (got ${sum})`);
    // Windows 10 and 11 ship bsdtar, which reads zip files.
    const unpacked = join(tmp, "x");
    mkdirSync(unpacked);
    await new Promise<void>((resolve, reject) =>
      execFile("tar", ["-xf", zip, "-C", unpacked], { windowsHide: true }, (e) => (e ? reject(new Error(`unpacking failed: ${e.message}`)) : resolve())));
    const found = findExe(unpacked);
    if (!found) throw new Error("mpv.exe wasn't in the download");
    const dest = join(home, MPV_VERSION);
    rmSync(dest, { recursive: true, force: true });
    renameSync(found, dest);
    rmSync(tmp, { recursive: true, force: true });
    // Older versions this replaced.
    for (const name of readdirSync(home)) if (name !== MPV_VERSION) rmSync(join(home, name), { recursive: true, force: true });
    const exe = downloadedMpv();
    if (!exe) throw new Error("mpv.exe is missing after unpacking");
    return exe;
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** The folder holding mpv.exe inside the unpacked download. */
function findExe(dir: string, depth = 0): string | null {
  if (existsSync(join(dir, "mpv.exe"))) return dir;
  if (depth > 3) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const hit = findExe(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
