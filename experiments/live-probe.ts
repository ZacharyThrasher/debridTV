// LIVE-001 — Read-only probe of the account holder's own Real-Debrid / TorBox account.
// Approved by Zachary on 2026-10-10 ("Yes, read-only"). Run by the account holder,
// on their own device, with their own key in an environment variable.
//
// What it does (and nothing else):
//   1. reads account info and one page of the existing library (no changes)
//   2. requests ONE playback link for ONE file already in the library
//   3. reads small byte ranges at the start, middle and end of that file
//   4. optionally re-checks the same link with 1-byte reads to learn its lifetime
// It never adds, selects, deletes or downloads whole files. Media reads are capped.
//
// The report contains timings, sizes, status codes and header names/values that
// carry no secrets. Keys, link URLs and file names are never written to it.
//
//   PowerShell:  $env:RD_TOKEN="..."; node experiments/live-probe.ts
//                $env:TORBOX_TOKEN="..."; node experiments/live-probe.ts
//   Options:     PICK=<n> choose file n from the printed list (default: first video ≥ 100 MB)
//                WATCH_MIN=<m> re-check link lifetime every 15 min for m minutes (default 0)
//                MAX_MB=<n> cap on media bytes read (default 16)

import { writeFileSync, mkdirSync } from "node:fs";
import { RealDebridClient, TorBoxClient } from "../src/providers/clients.ts";
import type { InventoryFile, ProviderClient } from "../src/providers/types.ts";

const MAX_BYTES = Number(process.env.MAX_MB ?? 16) * 1_000_000;
const WATCH_MIN = Number(process.env.WATCH_MIN ?? 0);
const READ = 256 * 1024;
// Overridable only so the probe can be dry-run against the mock providers.
const RD_BASE = process.env.RD_BASE ?? "https://api.real-debrid.com";
const TB_BASE = process.env.TB_BASE ?? "https://api.torbox.app";
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i;

let mediaBytes = 0;
const log: Array<Record<string, unknown>> = [];
const note = (step: string, data: Record<string, unknown>) => {
  log.push({ step, atMs: Math.round(performance.now()), ...data });
  console.log(step, data);
};

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t)];
}

function safeHeaders(h: Headers): Record<string, string> {
  const keep = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control",
    "expires", "last-modified", "etag", "server", "age", "x-cache", "cf-cache-status", "via"];
  return Object.fromEntries(keep.flatMap((k) => (h.get(k) ? [[k, h.get(k)!]] : [])));
}

async function rangeRead(url: string, from: number, len: number) {
  if (mediaBytes + len > MAX_BYTES) throw new Error(`byte cap ${MAX_BYTES} reached`);
  const t = performance.now();
  const res = await fetch(url, { headers: { range: `bytes=${from}-${from + len - 1}` } });
  const ttfbMs = Math.round(performance.now() - t);
  let got = 0;
  if (res.body) for await (const c of res.body) got += (c as Uint8Array).byteLength;
  mediaBytes += got;
  return { status: res.status, ttfbMs, totalMs: Math.round(performance.now() - t), bytes: got,
    redirected: res.redirected, headers: safeHeaders(res.headers) };
}

async function accountInfo(provider: string, token: string) {
  const url = provider === "realdebrid" ? `${RD_BASE}/rest/1.0/user` : `${TB_BASE}/v1/api/user/me`;
  const [res, ms] = await timed(() => fetch(url, { headers: { authorization: `Bearer ${token}` } }));
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  const d = provider === "realdebrid" ? body : body.data ?? {};
  // Plan facts only; no username, email or ids.
  return { status: res.status, latencyMs: ms, type: d.type ?? d.plan ?? null,
    premiumUntil: d.expiration ?? d.premium_expires_at ?? null };
}

async function probe(provider: "realdebrid" | "torbox", token: string) {
  const client: ProviderClient = provider === "realdebrid"
    ? new RealDebridClient(RD_BASE, token)
    : new TorBoxClient(TB_BASE, token);

  note("account", await accountInfo(provider, token));

  const [files, invMs] = await timed(() => client.inventory());
  note("inventory", { latencyMs: invMs, files: files.length,
    states: countBy(files.map((f) => f.providerState)) });
  files.slice(0, 20).forEach((f, i) => console.log(`  [${i}] ${f.name}  (${(f.bytes / 1e9).toFixed(2)} GB, ${f.providerState})`));

  const pick: InventoryFile | undefined = process.env.PICK
    ? files[Number(process.env.PICK)]
    : files.find((f) => VIDEO.test(f.name) && f.bytes >= 100e6);
  if (!pick) return note("stop", { reason: "no suitable file; set PICK=<n>" });
  note("picked", { ext: pick.name.split(".").pop(), bytes: pick.bytes, providerState: pick.providerState });

  const [grant, resolveMs] = await timed(() => client.resolve(pick.ref));
  note("resolve", { latencyMs: resolveMs, statedExpiry: grant.expiresAtMs, hostKind: new URL(grant.url).hostname.split(".").slice(-2).join(".") });

  // Seek test: start, middle, near end. Two reads at the middle show warm vs cold.
  const mid = Math.floor(pick.bytes / 2);
  for (const [label, at] of [["start", 0], ["middle", mid], ["middle-again", mid + READ], ["end", Math.max(0, pick.bytes - READ)]] as const)
    note(`range:${label}`, await rangeRead(grant.url, at, READ));

  // Tune-cancel: open a stream and abort after the first chunk, as a channel change would.
  const ctl = new AbortController();
  const t = performance.now();
  const res = await fetch(grant.url, { headers: { range: `bytes=${mid}-` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const first = await reader.read();
  mediaBytes += first.value?.byteLength ?? 0;
  ctl.abort();
  note("cancel", { status: res.status, firstChunkMs: Math.round(performance.now() - t), firstChunkBytes: first.value?.byteLength ?? 0 });

  // Link lifetime: 1-byte reads every 15 minutes.
  for (let m = 15; m <= WATCH_MIN; m += 15) {
    await new Promise((r) => setTimeout(r, 15 * 60_000));
    const r = await rangeRead(grant.url, 0, 1);
    note("lifetime", { minutes: m, status: r.status, ttfbMs: r.ttfbMs });
    if (r.status >= 400) break;
  }
  const calls = (client as RealDebridClient | TorBoxClient).counter.calls;
  note("totals", { apiCalls: { ...calls, account: 1 }, mediaBytes });
}

function countBy(xs: string[]) {
  return xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}

const runs: Array<["realdebrid" | "torbox", string | undefined]> = [
  ["realdebrid", process.env.RD_TOKEN],
  ["torbox", process.env.TORBOX_TOKEN],
];
if (!runs.some(([, k]) => k)) {
  console.error("Set RD_TOKEN and/or TORBOX_TOKEN first.");
  process.exit(1);
}
for (const [provider, token] of runs) {
  if (!token) continue;
  mediaBytes = 0;
  note("provider", { provider });
  try {
    await probe(provider, token);
  } catch (e) {
    note("error", { provider, message: String(e).replaceAll(token, "<redacted>") });
  }
}

mkdirSync("experiments/out", { recursive: true });
const file = `experiments/out/live-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ experiment: "LIVE-001", node: process.version, platform: process.platform, log }, null, 2));
console.log(`\nReport (no keys, links or file names): ${file}`);
