// Home network access (the "sharing" gate). Off by default. When the PC's owner
// turns it on from the PC itself, the app also listens on the PC's private home
// network addresses so a TV or phone on the same Wi-Fi can open it. Nothing here
// makes the app reachable from the internet: no port forwarding, no UPnP, and any
// request from an address outside the private ranges is refused.
//
// A new device pairs once with a six-digit code shown on the PC, and gets a device
// token in an HttpOnly cookie (so <video> requests carry it too). The PC lists and
// revokes devices; revoking also cuts that device's open connections. Every other
// guard in the server (PIN locks, final 409/451/403, no fetching of unwatched
// media) applies unchanged, because remote requests run through the same handler.
// Media is still proxied through the PC and provider keys never leave it; setup
// routes that take keys or change who can watch stay PC-only.

import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonFile } from "../store.ts";
import type { Gates } from "../../src/gates.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAIR_CODE_MS = 5 * 60_000;
/** Wrong codes allowed before the code is thrown away and the PC must show a new one. */
export const PAIR_TRIES = 5;
export const MAX_DEVICES = 24;
export const COOKIE = "dtv_device";
const COOKIE_MAX_AGE_S = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days
const SEEN_WRITE_MS = 60_000;

// ---------------------------------------------------------------- addresses

/** Strips an IPv6 zone id and the IPv4-mapped prefix, and lowercases. */
export function normalizeIp(addr: string | undefined | null): string {
  let a = (addr ?? "").trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? mapped[1]! : a;
}

function v4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** First 16-bit group of an IPv6 address, or null if it isn't one. */
function v6Head(a: string): number | null {
  if (!a.includes(":") || net.isIPv6(a) === false) return null;
  const head = a.startsWith("::") ? "0" : a.split(":")[0]!;
  return parseInt(head || "0", 16);
}

export function isLoopback(addr: string | undefined | null): boolean {
  const a = normalizeIp(addr);
  const o = v4(a);
  if (o) return o[0] === 127;
  return a === "::1";
}

/**
 * True only for addresses that can't come from the internet: loopback, RFC 1918
 * (10/8, 172.16/12, 192.168/16), IPv4 link-local (169.254/16), IPv6 link-local
 * (fe80::/10) and IPv6 unique-local (fc00::/7). Carrier-grade NAT (100.64/10),
 * public, multicast and unspecified addresses are all refused.
 */
export function isPrivateAddress(addr: string | undefined | null): boolean {
  const a = normalizeIp(addr);
  const o = v4(a);
  if (o) {
    const [x, y] = o as [number, number];
    if (x === 127 || x === 10) return true;
    if (x === 172 && y >= 16 && y <= 31) return true;
    if (x === 192 && y === 168) return true;
    if (x === 169 && y === 254) return true;
    return false;
  }
  if (a === "::1") return true;
  const h = v6Head(a);
  if (h === null) return false;
  return (h & 0xffc0) === 0xfe80 || (h & 0xfe00) === 0xfc00;
}

export interface LanAddress {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
}

/**
 * The PC's own home network addresses: private, not loopback, not IPv6
 * link-local (those need a zone id no TV can type). These are the only
 * addresses the app ever binds besides 127.0.0.1.
 */
export function homeAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal) continue;
      const a = normalizeIp(i.address);
      if (!isPrivateAddress(a) || isLoopback(a)) continue;
      const fam = i.family === "IPv6" || (i.family as unknown) === 6 ? "IPv6" : "IPv4";
      if (fam === "IPv6" && ((v6Head(a) ?? 0) & 0xffc0) === 0xfe80) continue;
      out.push({ name, address: a, family: fam });
    }
  }
  // IPv4 first: it's what a person types on a TV.
  return out.sort((p, q) => (p.family === q.family ? 0 : p.family === "IPv4" ? -1 : 1));
}

function hostOf(a: LanAddress | string, port: number): string {
  const addr = typeof a === "string" ? a : a.address;
  return addr.includes(":") ? `[${addr}]:${port}` : `${addr}:${port}`;
}

/** A friendly default name from the browser's user agent. */
export function guessDeviceName(ua: string | undefined): string {
  const u = (ua ?? "").toLowerCase();
  if (/smart-?tv|smarttv|tizen|webos|bravia|aft[a-z]|crkey|android tv|googletv|hbbtv|netcast|roku|xbox|playstation/.test(u)) return "TV";
  if (/ipad|tablet/.test(u)) return "Tablet";
  if (/iphone|android.*mobile|mobile/.test(u)) return "Phone";
  if (/android/.test(u)) return "Tablet";
  return "Computer";
}

export function cleanDeviceName(name: unknown, ua?: string): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40) : "";
  return s || guessDeviceName(ua);
}

// ---------------------------------------------------------------- state

export interface PairedDevice {
  id: string;
  name: string;
  /** sha256 of the token secret; the secret itself is only ever in the device's cookie. */
  hash: string;
  pairedAt: number;
  lastSeenAt: number;
  lastAddress?: string;
}

interface LanState {
  enabled?: boolean;
  enabledAt?: number;
  devices?: PairedDevice[];
}

export type Who =
  | { kind: "pc" }
  | { kind: "device"; device: PairedDevice }
  | { kind: "stranger" };

export interface LanOptions {
  gates?: Gates;
  now?: () => number;
  /** Override the PC's addresses (tests). */
  addresses?: () => LanAddress[];
  /** Override the peer address of a request (tests simulate a TV this way). */
  peer?: (req: http.IncomingMessage) => string | undefined;
  /** Open real listeners on the home network addresses. Tests turn it off. */
  listen?: boolean;
}

/** Routes a paired device may not use: they take provider keys, or change who can watch. */
const PC_ONLY: Array<[string | RegExp, string?]> = [
  ["/api/sources", "POST"],
  ["/api/sources/disconnect"],
  ["/api/sources/account"],
  ["/api/forget"],
  ["/api/import"],
  ["/api/backups", "POST"],
  ["/api/backups/restore"],
  ["/api/lock/pin"],
  [/^\/api\/lan(\/|$)/],
];

/** What an unpaired device on the home network can load: the pairing page and its fonts. */
function strangerMayOpen(p: string, method: string): boolean {
  if (method === "GET" && (p === "/pair" || p === "/icon.svg" || p === "/api/lan/hello" || /^\/fonts\/[\w.-]+$/.test(p))) return true;
  return method === "POST" && p === "/api/lan/pair";
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export class LanAccess {
  private readonly file = new JsonFile<LanState>("lan.json", () => ({}));
  private readonly now: () => number;
  private readonly gates?: Gates;
  private readonly addressesOf: () => LanAddress[];
  private readonly peerOf: (req: http.IncomingMessage) => string | undefined;
  private readonly listen: boolean;
  private pairing: { code: string; expiresAt: number; tries: number } | null = null;
  private listeners: net.Server[] = [];
  private bound: string[] = [];
  private listenErrors: string[] = [];
  private server: http.Server | null = null;
  private port = 0;
  /** Open sockets per paired device, so revoking cuts playback at once. */
  private readonly sockets = new Map<string, Set<net.Socket>>();
  /** Every socket that arrived through a home network listener. */
  private readonly remoteSockets = new Set<net.Socket>();
  private readonly seenWritten = new Map<string, number>();
  private rebindTimer: NodeJS.Timeout | null = null;

  constructor(opts: LanOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.gates = opts.gates;
    if (opts.addresses) this.addressesOf = opts.addresses;
    else {
      // Interface lists are read at most every few seconds; every request asks.
      let at = -Infinity, cached: LanAddress[] = [];
      this.addressesOf = () => {
        if (Date.now() - at > 5000) (cached = homeAddresses()), (at = Date.now());
        return cached;
      };
    }
    this.peerOf = opts.peer ?? ((req) => req.socket.remoteAddress);
    this.listen = opts.listen ?? true;
    if (this.enabled) this.grantGate();
  }

  get enabled(): boolean {
    return !!this.file.get().enabled;
  }

  devices(): PairedDevice[] {
    return this.file.get().devices ?? [];
  }

  private grantGate() {
    this.gates?.grant({
      gate: "sharing",
      grantedAt: new Date(this.file.get().enabledAt ?? this.now()).toISOString(),
      grantedBy: "the PC's owner, from the Home network setting on this PC",
      basis: "Home network only: private addresses, paired devices, media proxied through this PC, keys stay on it (approved by Zachary 2026-10-11)",
    });
  }

  // ------------------------------------------------------------ owner actions (PC only)

  async setEnabled(on: boolean): Promise<void> {
    if (on === this.enabled) return;
    if (on) {
      this.file.update((s) => ({ ...s, enabled: true, enabledAt: this.now() }));
      this.grantGate();
      await this.openListeners();
    } else {
      this.file.update((s) => ({ ...s, enabled: false, enabledAt: undefined }));
      this.pairing = null;
      this.gates?.revoke("sharing");
      await this.closeListeners();
    }
  }

  startPairing(): { code: string; expiresAt: number } {
    if (!this.enabled) throw new Error("Turn on home network access first.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pairing = { code, expiresAt: this.now() + PAIR_CODE_MS, tries: 0 };
    return { code, expiresAt: this.pairing.expiresAt };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  private activePairing() {
    if (this.pairing && this.now() >= this.pairing.expiresAt) this.pairing = null;
    return this.pairing;
  }

  revoke(id: string): boolean {
    const before = this.devices().length;
    this.file.update((s) => ({ ...s, devices: (s.devices ?? []).filter((d) => d.id !== id) }), { secret: true });
    for (const s of this.sockets.get(id) ?? []) s.destroy();
    this.sockets.delete(id);
    return this.devices().length < before;
  }

  rename(id: string, name: unknown): boolean {
    let hit = false;
    this.file.update((s) => ({
      ...s,
      devices: (s.devices ?? []).map((d) => {
        if (d.id !== id) return d;
        hit = true;
        return { ...d, name: typeof name === "string" && name.trim() ? cleanDeviceName(name) : d.name };
      }),
    }), { secret: true });
    return hit;
  }

  status(): object {
    const p = this.activePairing();
    const port = this.port;
    const addrs = this.addressesOf();
    return {
      enabled: this.enabled,
      enabledAt: this.file.get().enabledAt ?? null,
      port,
      addresses: addrs.map((a) => ({ ...a, url: `http://${hostOf(a, port)}` })),
      listening: this.bound,
      errors: this.listenErrors,
      pairing: p ? { code: p.code, expiresAt: p.expiresAt, triesLeft: PAIR_TRIES - p.tries } : null,
      devices: this.devices().map(({ hash: _h, ...d }) => ({ ...d, connected: (this.sockets.get(d.id)?.size ?? 0) > 0 })),
      maxDevices: MAX_DEVICES,
    };
  }

  // ------------------------------------------------------------ device actions

  /** A device on the home network offers the code shown on the PC. */
  pair(code: unknown, name: unknown, address: string | undefined, ua?: string):
    | { ok: true; token: string; device: PairedDevice }
    | { ok: false; status: 400 | 403 | 409 | 429; error: string } {
    if (!this.enabled) return { ok: false, status: 403, error: "Home network access is off on the PC." };
    const p = this.activePairing();
    if (!p) return { ok: false, status: 409, error: "No pairing code is showing. Open Home network on the PC and choose Pair a device." };
    const c = typeof code === "string" ? code.replace(/\D/g, "") : "";
    if (c.length !== 6) return { ok: false, status: 400, error: "The code has six digits." };
    const a = Buffer.from(c), b = Buffer.from(p.code);
    if (!timingSafeEqual(a, b)) {
      p.tries++;
      if (p.tries >= PAIR_TRIES) {
        this.pairing = null;
        return { ok: false, status: 429, error: "Too many wrong codes. Show a new code on the PC." };
      }
      return { ok: false, status: 403, error: `That code doesn't match. ${PAIR_TRIES - p.tries} tries left.` };
    }
    if (this.devices().length >= MAX_DEVICES) return { ok: false, status: 409, error: "Too many paired devices. Remove one on the PC first." };
    this.pairing = null; // one code, one device
    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const now = this.now();
    const device: PairedDevice = { id, name: cleanDeviceName(name, ua), hash: sha(secret), pairedAt: now, lastSeenAt: now, lastAddress: normalizeIp(address) };
    this.file.update((s) => ({ ...s, devices: [...(s.devices ?? []), device] }), { secret: true });
    return { ok: true, token: `${id}.${secret}`, device };
  }

  /** The paired device a token belongs to, or null. */
  verify(token: string | null | undefined): PairedDevice | null {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const id = token.slice(0, dot);
    const d = this.devices().find((x) => x.id === id);
    if (!d) return null;
    const a = Buffer.from(sha(token.slice(dot + 1)), "hex"), b = Buffer.from(d.hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b) ? d : null;
  }

  private touch(d: PairedDevice, address: string) {
    const now = this.now();
    if (now - (this.seenWritten.get(d.id) ?? 0) < SEEN_WRITE_MS) return;
    this.seenWritten.set(d.id, now);
    this.file.update((s) => ({
      ...s,
      devices: (s.devices ?? []).map((x) => (x.id === d.id ? { ...x, lastSeenAt: now, lastAddress: address } : x)),
    }), { secret: true });
  }

  // ------------------------------------------------------------ request screening

  /** Hosts this server answers to. Only literal addresses, so DNS rebinding can't reach it. */
  hostAllowed(host: string, port: number): boolean {
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true;
    if (!this.enabled) return false;
    return this.addressesOf().some((a) => hostOf(a, port) === host.toLowerCase());
  }

  /** Who is asking. Null means the request must be refused outright. */
  classify(req: http.IncomingMessage): Who | null {
    const peer = normalizeIp(this.peerOf(req));
    if (isLoopback(peer)) return { kind: "pc" };
    if (!this.enabled || !isPrivateAddress(peer)) return null;
    // The PC's own browser opening its own home network address is still the PC.
    if (this.addressesOf().some((a) => a.address === peer)) return { kind: "pc" };
    const d = this.verify(cookieValue(req.headers.cookie, COOKIE));
    return d ? { kind: "device", device: d } : { kind: "stranger" };
  }

  /**
   * Runs before every request. Returns true when it has answered (refused,
   * redirected to pairing, or served a home network route); false lets the
   * server handle the request as usual.
   */
  async intercept(req: http.IncomingMessage, res: http.ServerResponse, url: URL, port: number): Promise<boolean> {
    const p = url.pathname;
    const method = req.method ?? "GET";
    // Same-origin only: refuse cross-site requests so a web page can't drive the TV.
    // Host check blocks DNS-rebinding pages from reading this server as if it were theirs.
    const host = req.headers.host ?? "";
    if (!this.hostAllowed(host, port)) return send(res, 403, { error: "unexpected host" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: "cross-origin" });
    const who = this.classify(req);
    if (!who) return send(res, 403, { error: "Only devices on your home network can open DebridTV." });

    if (who.kind === "device") {
      this.track(who.device.id, req.socket);
      this.touch(who.device, normalizeIp(this.peerOf(req)));
      if (PC_ONLY.some(([r, m]) => (typeof r === "string" ? p === r : r.test(p)) && (!m || m === method)) && p !== "/api/lan/hello" && p !== "/api/lan/pair")
        return send(res, 403, { error: "This setting can only be changed on the PC.", pcOnly: true });
    }
    if (who.kind === "stranger" && !strangerMayOpen(p, method)) {
      if (p.startsWith("/api/") || p.startsWith("/media/")) return send(res, 401, { error: "Pair this device first.", pair: "/pair" });
      res.writeHead(302, { location: "/pair", "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (p === "/pair" && method === "GET") return page(res, "pair.html");
    if (p === "/lan" && method === "GET") return who.kind === "pc" ? page(res, "manage.html") : send(res, 403, { error: "Open this on the PC.", pcOnly: true });
    if (p === "/api/lan/hello" && method === "GET") {
      return send(res, 200, {
        where: who.kind,
        enabled: this.enabled,
        ...(who.kind === "device" ? { device: { id: who.device.id, name: who.device.name } } : {}),
        ...(who.kind === "stranger" ? { pairing: !!this.activePairing(), suggestedName: guessDeviceName(req.headers["user-agent"]) } : {}),
      });
    }
    if (p === "/api/lan/pair" && method === "POST") {
      const body = await readJson(req);
      if (who.kind === "pc") return send(res, 400, { error: "This is the PC; it doesn't need pairing." });
      if (who.kind === "device") return send(res, 200, { ok: true, device: { id: who.device.id, name: who.device.name } });
      const r = this.pair(body.code, body.name, this.peerOf(req), req.headers["user-agent"]);
      if (!r.ok) return send(res, r.status, { error: r.error });
      res.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(r.token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict`);
      return send(res, 200, { ok: true, device: { id: r.device.id, name: r.device.name } });
    }
    if (p.startsWith("/api/lan")) {
      // Only the PC reaches here (devices were refused above, strangers redirected).
      const body = method === "POST" ? await readJson(req) : {};
      if (p === "/api/lan" && method === "GET") return send(res, 200, this.status());
      if (p === "/api/lan" && method === "POST") {
        if (typeof body.enabled !== "boolean") return send(res, 400, { error: "enabled must be true or false" });
        await this.setEnabled(body.enabled);
        return send(res, 200, this.status());
      }
      if (p === "/api/lan/pairing" && method === "POST") {
        if (!this.enabled) return send(res, 409, { error: "Turn on home network access first." });
        this.startPairing();
        return send(res, 200, this.status());
      }
      if (p === "/api/lan/pairing/cancel" && method === "POST") {
        this.cancelPairing();
        return send(res, 200, this.status());
      }
      if (p === "/api/lan/revoke" && method === "POST") {
        const ok = this.revoke(String(body.id ?? ""));
        return send(res, ok ? 200 : 404, ok ? this.status() : { error: "No such device." });
      }
      if (p === "/api/lan/rename" && method === "POST") {
        const ok = this.rename(String(body.id ?? ""), body.name);
        return send(res, ok ? 200 : 404, ok ? this.status() : { error: "No such device." });
      }
      return send(res, 404, { error: "no route" });
    }
    return false;
  }

  private track(id: string, s: net.Socket) {
    let set = this.sockets.get(id);
    if (!set) this.sockets.set(id, (set = new Set()));
    if (set.has(s)) return;
    set.add(s);
    s.once("close", () => set!.delete(s));
  }

  // ------------------------------------------------------------ listeners

  /** Called once the main server listens on 127.0.0.1. Opens home listeners if turned on. */
  async start(server: http.Server, port: number): Promise<void> {
    this.server = server;
    this.port = port;
    if (this.enabled) await this.openListeners();
  }

  async stop(): Promise<void> {
    await this.closeListeners();
    this.server = null;
  }

  private async openListeners(): Promise<void> {
    if (!this.server || !this.listen || this.listeners.length) return;
    this.gates?.require("sharing");
    this.listenErrors = [];
    const server = this.server;
    for (const a of this.addressesOf()) {
      // A plain TCP listener per private address that hands sockets to the main
      // HTTP server. Binding each address (never 0.0.0.0) means a public interface
      // on the same PC is never listened on.
      const l = net.createServer((sock) => {
        this.remoteSockets.add(sock);
        sock.once("close", () => this.remoteSockets.delete(sock));
        server.emit("connection", sock);
      });
      try {
        await new Promise<void>((ok, fail) => {
          l.once("error", fail);
          l.listen(this.port, a.address, () => ok());
        });
        this.listeners.push(l);
        this.bound.push(hostOf(a, this.port));
      } catch (e) {
        this.listenErrors.push(`${hostOf(a, this.port)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The router may hand the PC a new address; follow it so the TV keeps working.
    this.rebindTimer ??= setInterval(() => void this.rebindIfMoved(), 60_000);
    this.rebindTimer.unref();
  }

  private async rebindIfMoved(): Promise<void> {
    if (!this.enabled || !this.server) return;
    const want = this.addressesOf().map((a) => hostOf(a, this.port)).sort().join(" ");
    if (want === [...this.bound].sort().join(" ")) return;
    await this.closeListeners();
    await this.openListeners();
  }

  private async closeListeners(): Promise<void> {
    if (this.rebindTimer) clearInterval(this.rebindTimer);
    this.rebindTimer = null;
    const ls = this.listeners;
    this.listeners = [];
    this.bound = [];
    for (const s of this.remoteSockets) s.destroy();
    this.remoteSockets.clear();
    await Promise.all(ls.map((l) => new Promise<void>((r) => l.close(() => r()))));
  }
}

// ---------------------------------------------------------------- helpers

function send(res: http.ServerResponse, status: number, body: unknown): true {
  if (res.headersSent) {
    res.end();
    return true;
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

function page(res: http.ServerResponse, name: string): true {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(readFileSync(join(HERE, name)));
  return true;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const v = s ? JSON.parse(s) : {};
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        resolve({});
      }
    });
  });
}
