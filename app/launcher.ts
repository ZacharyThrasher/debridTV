// DebridTV.exe starts here (see scripts/build-exe.mjs). It unpacks the page files
// that are packed inside the exe, starts the same server `npm start` runs, and
// opens the guide in the default browser. The first time, it also fetches ffmpeg
// for compatibility mode (ffmpeg-fetch.ts). Settings, keys and the library stay in
// the usual data folder (%APPDATA%\DebridTV), never next to the exe, so moving
// from a git checkout to the exe, or between versions, keeps everything.
//
//   DebridTV.exe               start and open the browser
//   DebridTV.exe --no-browser  start without opening a browser
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import sea from "node:sea";
import { fetchFfmpeg } from "./ffmpeg-fetch.ts";

const PORT = Number(process.env.PORT ?? 7337);
const URL = `http://127.0.0.1:${PORT}/`;

/** Unpack the page files once per version into a per-user folder; returns that folder. */
function unpack(): string {
  const manifest = JSON.parse(sea.getAsset("manifest.json", "utf8")) as { version: string; files: string[] };
  const id = createHash("sha256").update(sea.getAsset("manifest.json", "utf8")).digest("hex").slice(0, 10);
  const base = process.platform === "win32" && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "DebridTV", "app")
    : join(homedir(), ".debridtv", "app");
  const dir = join(base, `${manifest.version}-${id}`);
  if (!existsSync(join(dir, ".complete"))) {
    for (const f of manifest.files) {
      const out = join(dir, ...f.split("/"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, new Uint8Array(sea.getAsset(f)));
    }
    writeFileSync(join(dir, ".complete"), new Date().toISOString());
  }
  return dir;
}

/** True when a DebridTV is already answering on this port. */
function alreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${URL}api/bootstrap`, { timeout: 1500 }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(res.statusCode === 200 && s.includes('"channels"')));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => (req.destroy(), resolve(false)));
  });
}

function openBrowser(url: string): void {
  if (process.argv.includes("--no-browser")) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {}
}

/** Keep the window open long enough to read an error. */
function fail(message: string): void {
  console.error(`\n  DebridTV couldn't start: ${message}\n`);
  if (process.stdin.isTTY) {
    console.error("  Press Enter to close this window.");
    process.stdin.once("data", () => process.exit(1));
  } else process.exit(1);
}

async function start(): Promise<void> {
  process.env.DEBRIDTV_EXE_DIR = dirname(process.execPath);
  if (sea.isSea()) {
    const dir = unpack();
    process.env.DEBRIDTV_PUBLIC = join(dir, "public");
    process.env.DEBRIDTV_LAN_PAGES = join(dir, "lan");
  }
  if (await alreadyRunning()) {
    console.log(`  DebridTV is already running at ${URL}. Opening it.`);
    openBrowser(URL);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  const { main } = await import("./server.ts");
  try {
    const { app, port } = await main();
    console.log("  Keep this window open while you watch. Closing it turns DebridTV off.\n");
    openBrowser(`http://127.0.0.1:${port}/`);
    // One click: fetch ffmpeg in the background the first time, so compatibility mode just works.
    if (process.platform === "win32" && !app.ffmpeg && process.env.DEBRIDTV_NO_FFMPEG_DOWNLOAD !== "1") {
      fetchFfmpeg((line) => console.log(line)).then(
        (exe) => (app.useFfmpeg(exe), console.log("  Compatibility mode is on. Reload the page to use it.\n")),
        (e) => console.log(`  Couldn't get ffmpeg (${(e as Error).message}). DebridTV still works; it tries again next start.\n`));
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    fail(err.code === "EADDRINUSE" ? `another program is using port ${PORT}. Close it, or start DebridTV with a different PORT.` : err.message);
  }
}

start().catch((e) => fail((e as Error).message));
