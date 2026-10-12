// DebridTV.exe starts here (see scripts/build-exe.mjs). It unpacks the page files
// that are packed inside the exe, starts the same server `npm start` runs, and
// opens the guide in DebridTV's own window (see nativeWindow), or the default browser. The first time, it also fetches ffmpeg
// for compatibility mode (ffmpeg-fetch.ts). Settings, keys and the library stay in
// the usual data folder (%APPDATA%\DebridTV), never next to the exe, so moving
// from a git checkout to the exe, or between versions, keeps everything.
//
//   DebridTV.exe               start and open the DebridTV window
//   DebridTV.exe --browser     open the default browser instead of the window
//   DebridTV.exe --edge        use an Edge app window instead of DebridTV's own
//   DebridTV.exe --no-browser  start without opening anything
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import sea from "node:sea";
import { fetchFfmpeg } from "./ffmpeg-fetch.ts";
import { downloadedMpv, fetchMpv } from "./mpv-fetch.ts";

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

/** The DebridTV answering on this port, if any: its version and build ("" for copies run from source). */
function running(): Promise<{ version: string; build: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(`${URL}api/bootstrap`, { timeout: 1500 }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        try {
          const b = JSON.parse(s) as { channels?: unknown; version?: string; build?: string | null };
          resolve(res.statusCode === 200 && Array.isArray(b.channels) ? { version: b.version ?? "older", build: b.build ?? "" } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => (req.destroy(), resolve(null)));
  });
}

/**
 * A different DebridTV already holds the port: most often an older copy, such as
 * `npm start` from a git checkout. Close it so this one can start; both use the
 * same data folder, so nothing is lost. Windows only; elsewhere, say what to do.
 */
async function replaceOther(other: { version: string }): Promise<void> {
  const hint = `another DebridTV (version ${other.version}) is running on port ${PORT}. Close its window, then start DebridTV again.`;
  if (process.platform !== "win32") throw new Error(hint);
  console.log(`  Another DebridTV (version ${other.version}) is running on port ${PORT}, probably an older copy. Closing it so this one can start.`);
  const pids = new Set<string>();
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && /^LISTENING$/i.test(cols[3]) && cols[1].endsWith(`:${PORT}`) && /^\d+$/.test(cols[4]) && cols[4] !== "0") pids.add(cols[4]);
    }
  } catch {}
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
  }
  for (let i = 0; i < 40; i++) {
    if (!(await running())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(hint);
}

/**
 * Windows: Edge, which every Windows 10/11 PC has, as an app window of its own (no
 * address bar or tabs, its own taskbar entry and a separate profile). Edge decodes
 * Dolby Digital (AC-3/E-AC-3) through Windows' own decoders where Firefox and Chrome
 * can't, so those files play directly with sound whatever the viewer's usual browser
 * is. The player still checks canPlayType, so a PC without the Dolby decoder falls
 * back to compatibility mode as before. Returns false when Edge isn't found.
 */
function appWindow(url: string): boolean {
  if (process.platform !== "win32" || process.argv.includes("--browser")) return false;
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const edge = roots.map((r) => join(r, "Microsoft", "Edge", "Application", "msedge.exe")).find((p) => existsSync(p));
  if (!edge) return false;
  const profile = join(process.env.LOCALAPPDATA ?? homedir(), "DebridTV", "window");
  try {
    spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--window-size=1280,760"],
      { stdio: "ignore", detached: true, windowsHide: false }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

/** debridtv-window.exe, unpacked with the page files when this exe carries it. */
let windowExe: string | null = null;

/**
 * Windows: DebridTV's own window (desktop/). The page runs in WebView2 and video
 * plays in mpv underneath it, so every format plays with sound, no conversion.
 * mpv is fetched the first time (mpv-fetch.ts); until it's here, or if it can't
 * be fetched, the window plays video the way Edge does. If the window can't open
 * at all (no WebView2), the Edge app window or the browser takes over.
 */
async function nativeWindow(url: string): Promise<boolean> {
  if (process.platform !== "win32" || !windowExe || process.argv.includes("--browser") || process.argv.includes("--edge")) return false;
  let mpv = downloadedMpv();
  if (!mpv && process.env.DEBRIDTV_NO_MPV_DOWNLOAD !== "1") {
    console.log("  Setting up the video player. This happens once.");
    const fetching = fetchMpv((line) => console.log(line));
    // Don't keep the viewer waiting forever: open without it, and it's ready next time.
    mpv = await Promise.race([fetching, new Promise<null>((r) => setTimeout(() => r(null), 90_000))]).catch((e) => {
      console.log(`  Couldn't get the video player (${(e as Error).message}). Video plays the way Edge plays it; DebridTV tries again next start.`);
      return null;
    });
  }
  const local = process.env.LOCALAPPDATA ?? homedir();
  const args = ["--url", url, "--data", join(local, "DebridTV", "webview"), "--no-dialog"];
  if (mpv) args.push("--mpv", mpv);
  return new Promise((resolve) => {
    try {
      const child = spawn(windowExe!, args, { stdio: "ignore", detached: true, windowsHide: false });
      // A window that can't open quits at once; give it a moment before trusting it.
      const t = setTimeout(() => (child.unref(), resolve(true)), 4000);
      child.on("error", () => (clearTimeout(t), resolve(false)));
      child.on("exit", (code) => {
        clearTimeout(t);
        if (code) console.log(`  DebridTV's window couldn't open (code ${code}). Opening it another way.`);
        resolve(!code);
      });
    } catch {
      resolve(false);
    }
  });
}

async function openBrowser(url: string): Promise<void> {
  if (process.argv.includes("--no-browser")) return;
  if (await nativeWindow(url)) return;
  if (appWindow(url)) return;
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
    // Which build this is, so a second start can tell this copy from an older one.
    process.env.DEBRIDTV_BUILD = dir.split(/[\\/]/).pop();
    process.env.DEBRIDTV_PUBLIC = join(dir, "public");
    process.env.DEBRIDTV_LAN_PAGES = join(dir, "lan");
    const w = join(dir, "window", "debridtv-window.exe");
    if (existsSync(w)) windowExe = w;
  }
  const other = await running();
  if (other && other.build === process.env.DEBRIDTV_BUILD) {
    console.log(`  DebridTV is already running at ${URL}. Opening it.`);
    await openBrowser(URL);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  if (other) await replaceOther(other);
  const { main } = await import("./server.ts");
  try {
    const { app, port } = await main();
    console.log("  Keep this window open while you watch. Closing it turns DebridTV off.\n");
    openBrowser(`http://127.0.0.1:${port}/`).catch(() => {});
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
