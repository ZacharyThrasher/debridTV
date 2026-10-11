// Parental PIN for locked channels (N-06b). One PIN for the whole TV, kept only as
// a salted scrypt hash in its own file in the data folder (never in settings
// exports or backups). Entering it unlocks every locked channel for four hours or
// until the server restarts, whichever comes first. Wrong guesses are slowed down
// and the slowdown survives a restart, so restarting doesn't buy more guesses.

import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { JsonFile } from "./store.ts";

export const UNLOCK_MS = 4 * 60 * 60_000;
/** Wrong guesses allowed before waits start. */
export const FREE_TRIES = 3;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;
const PIN_RE = /^\d{4,8}$/;
// N = 2^14, r = 8: about 16 MiB and tens of milliseconds per check.
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

interface LockState {
  hash?: { salt: string; key: string; N: number; r: number; p: number };
  failures?: number;
  /** No guess is checked before this time (ms). */
  waitUntil?: number;
}

export type PinResult =
  | { ok: true; untilMs?: number }
  | { ok: false; status: 400 | 403 | 409 | 429; error: string; retryAfterMs?: number };

function derive(pin: string, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(pin, salt, KEYLEN, { N: p.N, r: p.r, p: p.p, maxmem: PARAMS.maxmem }, (e, k) => (e ? rej(e) : res(k))));
}

export class PinLock {
  private readonly file = new JsonFile<LockState>("lock.json", () => ({}));
  /** In memory only: a restart locks everything again. */
  private unlockedUntil = 0;
  /** One check at a time, so parallel guesses can't race the counter. */
  private queue: Promise<unknown> = Promise.resolve();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  pinSet(): boolean {
    return !!this.file.get().hash;
  }

  isUnlocked(): boolean {
    return this.pinSet() && this.now() < this.unlockedUntil;
  }

  status() {
    const s = this.file.get();
    const now = this.now();
    const wait = Math.max(0, (s.waitUntil ?? 0) - now);
    return {
      pinSet: !!s.hash,
      unlocked: this.isUnlocked(),
      untilMs: this.isUnlocked() ? this.unlockedUntil : null,
      ...(wait ? { retryAfterMs: wait } : {}),
    };
  }

  /** Set, change (`old` required once a PIN exists) or remove (`pin: null`) the PIN. */
  setPin(old: unknown, pin: unknown): Promise<PinResult> {
    return this.serial(async () => {
      if (pin !== null && (typeof pin !== "string" || !PIN_RE.test(pin)))
        return { ok: false, status: 400, error: "A PIN is 4 to 8 digits." };
      if (this.pinSet()) {
        const check = await this.check(old);
        if (!check.ok) return check;
      } else if (pin === null) return { ok: true };
      if (pin === null) {
        this.file.set({});
        this.unlockedUntil = 0;
        return { ok: true };
      }
      const salt = randomBytes(16);
      const key = await derive(pin, salt, PARAMS);
      this.file.set({ hash: { salt: salt.toString("base64"), key: key.toString("base64"), N: PARAMS.N, r: PARAMS.r, p: PARAMS.p } }, { secret: true });
      // Whoever just set the PIN knows it: no need to type it again straight away.
      this.unlockedUntil = this.now() + UNLOCK_MS;
      return { ok: true, untilMs: this.unlockedUntil };
    });
  }

  unlock(pin: unknown): Promise<PinResult> {
    return this.serial(async () => {
      if (!this.pinSet()) return { ok: false, status: 409, error: "No PIN is set." };
      const check = await this.check(pin);
      if (!check.ok) return check;
      this.unlockedUntil = this.now() + UNLOCK_MS;
      return { ok: true, untilMs: this.unlockedUntil };
    });
  }

  /** Lock again now ("Lock" button, or the viewer leaving the room). */
  lock(): void {
    this.unlockedUntil = 0;
  }

  /** "Forget everything": the hash and the guess counter go too. */
  clear(): void {
    this.unlockedUntil = 0;
    this.file.set({});
    try {
      rmSync(this.file.path, { force: true });
    } catch {}
  }

  private async check(pin: unknown): Promise<PinResult> {
    const s = this.file.get();
    const now = this.now();
    if ((s.waitUntil ?? 0) > now)
      return { ok: false, status: 429, error: "Too many wrong PINs. Try again in a moment.", retryAfterMs: s.waitUntil! - now };
    const h = s.hash!;
    const want = Buffer.from(h.key, "base64");
    const got = typeof pin === "string" && PIN_RE.test(pin) ? await derive(pin, Buffer.from(h.salt, "base64"), h) : null;
    if (got && got.length === want.length && timingSafeEqual(got, want)) {
      if (s.failures || s.waitUntil) this.file.set({ hash: h }, { secret: true });
      return { ok: true };
    }
    const failures = (s.failures ?? 0) + 1;
    const wait = failures <= FREE_TRIES ? 0 : Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - FREE_TRIES - 1));
    this.file.set({ hash: h, failures, ...(wait ? { waitUntil: this.now() + wait } : {}) }, { secret: true });
    return { ok: false, status: 403, error: "That PIN isn't right.", ...(wait ? { retryAfterMs: wait } : {}) };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
}
