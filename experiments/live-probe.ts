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
//   Options:     LIST=1        print the numbered list of video files and stop (one request, no links)
//                PICK=<n>      choose file n from that list (default: first video ≥ 100 MB);
//                              RD_PICK / TB_PICK pick per provider when both run.
//                              A multi-file pack expands (one request); PICK=<n>.<m> picks file m in it.
//                ETAG=1        edition test: a second link for the same file, and (with
//                              ETAG_PICK2=<n>) another file you know is a different version of
//                              the same episode; compares ETags (stored hashed, never raw)
//                WATCH_MIN=<m> re-check link lifetime every 15 min for m minutes (default 0)
//                MAX_MB=<n> cap on media bytes read (default 16)
//   Runbook:     docs/runbooks/live-probe.md

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { RealDebridClient, TorBoxClient } from "../src/providers/clients.ts";
import { ProviderError, type InventoryFile, type ProviderClient } from "../src/providers/types.ts";

const MAX_BYTES = Number(process.env.MAX_MB ?? 16) * 1_000_000;
const WATCH_MIN = Number(process.env.WATCH_MIN ?? 0);
const READ = 256 * 1024;
// Overridable only so the probe can be dry-run against the mock providers.
const RD_BASE = process.env.RD_BASE ?? "https://api.real-debrid.com";
const TB_BASE = process.env.TB_BASE ?? "https://api.torbox.app";
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts)$/i;
const ETAG = process.env.ETAG === "1";

/** ETags are compared, not kept: a short hash plus the shape (weak? md5-like? multipart?). */
function etagFacts(raw: string | null) {
  if (!raw) return { etag: null };
  const v = raw.replace(/^W\//, "").replace(/"/g, "");
  return {
    etag: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    weak: raw.startsWith("W/"),
    shape: /^[0-9a-f]{32}$/i.test(v) ? "hex32 (md5-like)" : /^[0-9a-f]{32}-\d+$/i.test(v) ? "hex32-N (multipart)" : /^[0-9a-f]+-[0-9a-f]+$/i.test(v) ? "hex-hex (size/mtime-like)" : `other, ${v.length} chars`,
  };
}
const etagSeen: Record<string, Array<{ label: string; etag: string | null; bytes: number }>> = {};

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
  const out: Record<string, unknown> = Object.fromEntries(keep.flatMap((k) => (h.get(k) ? [[k, h.get(k)!]] : [])));
  if (out.etag) out.etag = etagFacts(String(out.etag)); // compared by hash, not kept raw
  return out as Record<string, string>;
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
  const listAll = process.env.LIST === "1";
  // The numbered list stays on screen only (names never go in the report).
  files.forEach((f, i) => {
    if (!listAll && i >= 20) return;
    if (listAll && !VIDEO.test(f.name) && !f.ref.startsWith("pack:")) return;
    const kind = f.ref.startsWith("pack:") ? " [pack: several files]" : f.ref.startsWith("torrent:") ? " [not finished: can't be picked]" : "";
    console.log(`  [${i}] ${f.name}  (${(f.bytes / 1e9).toFixed(2)} GB, ${f.providerState})${kind}`);
  });
  if (listAll) return note("stop", { reason: "LIST=1: list printed, no links requested" });

  const pickVar = (provider === "realdebrid" ? process.env.RD_PICK : process.env.TB_PICK) ?? process.env.PICK;
  const pick = await choose(client, files, pickVar);
  if (!pick) return note("stop", { reason: "no suitable file; run with LIST=1 and set PICK=<n>" });
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

  if (ETAG) await etagTest(provider, client, files, pick, grant.url);

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

/** PICK=n, PICK=n.m inside a pack, or the first big video. Never a file that isn't finished. */
async function choose(client: ProviderClient, files: InventoryFile[], pickVar: string | undefined): Promise<InventoryFile | undefined> {
  if (!pickVar) return files.find((f) => VIDEO.test(f.name) && f.bytes >= 100e6 && !f.ref.startsWith("pack:") && !f.ref.startsWith("torrent:"));
  const [n, m] = pickVar.split(".").map(Number);
  const f = files[n!];
  if (!f) throw new Error(`PICK=${pickVar}: there is no file ${n}`);
  if (f.ref.startsWith("torrent:")) throw new Error(`PICK=${pickVar}: the provider hasn't finished this one ("${f.providerState}"); pick another`);
  if (!f.ref.startsWith("pack:")) return f;
  const inner = await (client as RealDebridClient).expand(f.ref.slice(5));
  const vids = inner.filter((x) => VIDEO.test(x.name));
  vids.forEach((x, i) => console.log(`      [${n}.${i}] ${x.name}  (${(x.bytes / 1e9).toFixed(2)} GB)`));
  note("pack", { files: inner.length, videos: vids.length });
  return m != null && Number.isFinite(m) ? vids[m] : vids.sort((a, b) => b.bytes - a.bytes)[0];
}

/**
 * Edition evidence (HANDOFF §4 "ETag as edition identity"). Questions:
 *  1. Does the same file keep its ETag across two separately issued links?
 *  2. Does a different version of the same episode get a different ETag?
 *  3. Across providers, does the same file get the same ETag (content-derived)?
 * Costs one extra link request per file and 1-byte reads.
 */
async function etagTest(provider: string, client: ProviderClient, files: InventoryFile[], pick: InventoryFile, firstUrl: string) {
  const seen = (etagSeen[provider] ??= []);
  const a = await rangeRead(firstUrl, 0, 1);
  const fa = a.headers.etag as unknown as ReturnType<typeof etagFacts> ?? etagFacts(null);
  seen.push({ label: "picked, link 1", etag: fa.etag, bytes: pick.bytes });
  const [again] = await timed(() => client.resolve(pick.ref));
  const b = await rangeRead(again.url, 0, 1);
  const fb = b.headers.etag as unknown as ReturnType<typeof etagFacts> ?? etagFacts(null);
  seen.push({ label: "picked, link 2", etag: fb.etag, bytes: pick.bytes });
  note("etag:same-file", { sameLinkUrl: again.url === firstUrl, link1: fa, link2: fb,
    stableAcrossLinks: fa.etag != null && fa.etag === fb.etag, lastModifiedSame: a.headers["last-modified"] === b.headers["last-modified"] });
  const p2 = (provider === "realdebrid" ? process.env.RD_PICK2 : process.env.TB_PICK2) ?? process.env.ETAG_PICK2;
  if (!p2) return;
  try {
    const other = await choose(client, files, p2);
    if (!other) return note("etag:other-version", { error: `no file ${p2}` });
    const [g] = await timed(() => client.resolve(other.ref));
    const c = await rangeRead(g.url, 0, 1);
    const fc = c.headers.etag as unknown as ReturnType<typeof etagFacts> ?? etagFacts(null);
    seen.push({ label: "second version", etag: fc.etag, bytes: other.bytes });
    note("etag:other-version", { other: fc, sameSize: other.bytes === pick.bytes, differsFromPicked: fc.etag !== fa.etag });
  } catch (e) {
    // A refusal here is reported like any other and never worked around.
    note("etag:other-version", { error: e instanceof ProviderError ? { kind: e.kind, status: e.status } : String(e) });
  }
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
    const pe = e instanceof ProviderError ? { kind: e.kind, status: e.status } : {};
    note("error", { provider, ...pe, message: String(e).replaceAll(token, "<redacted>") });
    if (e instanceof ProviderError && e.kind === "policy")
      console.log(`\n  ${provider} refused this file. That's final for this file: the probe won't retry it or try it elsewhere.\n  To test playback, run again with LIST=1, then ${provider === "realdebrid" ? "RD_PICK" : "TB_PICK"}=<another number>.\n`);
    // A policy block is reported, never worked around by picking another file
    // automatically. Choosing a different file is the account holder's call (PICK=n).
  }
}

if (ETAG && etagSeen.realdebrid && etagSeen.torbox) {
  // Only meaningful if you picked the same file on both (same size is a hint).
  const r = etagSeen.realdebrid[0]!, t = etagSeen.torbox[0]!;
  note("etag:cross-provider", { sameSize: r.bytes === t.bytes, sameEtag: r.etag != null && r.etag === t.etag });
}

mkdirSync("experiments/out", { recursive: true });
const file = `experiments/out/live-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ experiment: "LIVE-001", node: process.version, platform: process.platform, log }, null, 2));
console.log(`\nReport (no keys, links or file names): ${file}`);
