// Local, per-user persistence. Everything lives in one folder on the viewer's own
// machine (never the repo): %APPDATA%\DebridTV on Windows, ~/.debridtv elsewhere,
// or $DEBRIDTV_HOME. Keys are stored only in config.json there and are never sent
// to the browser.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  if (process.env.DEBRIDTV_HOME) return process.env.DEBRIDTV_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "DebridTV");
  return join(homedir(), ".debridtv");
}

export class JsonFile<T> {
  readonly path: string;
  private readonly fallback: () => T;
  private cached: T | undefined;

  constructor(name: string, fallback: () => T) {
    mkdirSync(dataDir(), { recursive: true });
    this.path = join(dataDir(), name);
    this.fallback = fallback;
  }

  get(): T {
    if (this.cached !== undefined) return this.cached;
    try {
      this.cached = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as T) : this.fallback();
    } catch {
      // A corrupt file must not brick the TV; keep a copy and start fresh.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {}
      this.cached = this.fallback();
    }
    return this.cached;
  }

  set(value: T, opts: { secret?: boolean } = {}): void {
    this.cached = value;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 1));
    renameSync(tmp, this.path);
    if (opts.secret && process.platform !== "win32") {
      try {
        chmodSync(this.path, 0o600);
      } catch {}
    }
  }

  update(fn: (v: T) => T | void, opts?: { secret?: boolean }): T {
    const cur = this.get();
    const next = (fn(cur) ?? cur) as T;
    this.set(next, opts);
    return next;
  }
}
