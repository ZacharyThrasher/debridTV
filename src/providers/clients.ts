// Thin, read-only clients for Real-Debrid and TorBox. They take a base URL so the
// same code runs against the mock server today. No credentials are stored here and
// nothing has been exercised against a live account (that waits for an explicit
// go-ahead). Every call is counted so API usage is measurable from the client side.

import { classify, type AccountInfo, type InventoryFile, type PlaybackGrant, type ProviderClient } from "./types.ts";

export class CallCounter {
  readonly calls: Record<string, number> = {};
  add(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }
  get total(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
}

export class RealDebridClient implements ProviderClient {
  readonly id = "realdebrid" as const;
  private readonly base: string;
  private readonly token: string;
  readonly counter: CallCounter;

  constructor(base: string, token: string, counter = new CallCounter()) {
    this.base = base;
    this.token = token;
    this.counter = counter;
  }

  /**
   * One entry per torrent. Single-file torrents carry their one link as `ref`;
   * multi-file packs are returned with `ref = "pack:<id>"` and need `expand()`
   * (one extra call each), which callers do deliberately and at a polite rate.
   */
  async inventory(signal?: AbortSignal): Promise<InventoryFile[]> {
    const out: InventoryFile[] = [];
    for (let page = 1; page <= 20; page++) {
      this.counter.add("rd.torrents");
      const q = new URLSearchParams({ limit: "500", page: String(page) });
      const res = await fetch(`${this.base}/rest/1.0/torrents?${q}`, { headers: this.auth(), signal });
      if (res.status === 204) break;
      if (!res.ok) throw classify(res.status, await res.text());
      const rows = (await res.json()) as Array<{ id: string; filename: string; bytes: number; status: string; links: string[] }>;
      for (const r of rows)
        out.push({
          provider: "realdebrid",
          // Not finished at RD: listed so the viewer can see it, never resolved or expanded.
          ref: r.status !== "downloaded" ? `torrent:${r.id}` : r.links.length === 1 ? r.links[0]! : `pack:${r.id}`,
          name: r.filename,
          bytes: r.bytes,
          providerState: r.status,
        });
      if (rows.length < 500) break;
    }
    return out;
  }

  /** Per-file entries of a multi-file torrent (selected files pair with links in order). */
  async expand(torrentId: string, signal?: AbortSignal): Promise<InventoryFile[]> {
    this.counter.add("rd.torrents.info");
    const res = await fetch(`${this.base}/rest/1.0/torrents/info/${encodeURIComponent(torrentId)}`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const t = (await res.json()) as {
      status: string;
      files: Array<{ id: number; path: string; bytes: number; selected: number }>;
      links: string[];
    };
    const selected = t.files.filter((f) => f.selected === 1);
    return selected.flatMap((f, i) =>
      t.links[i]
        ? [{ provider: "realdebrid" as const, ref: t.links[i]!, name: f.path.replace(/^\//, ""), bytes: f.bytes, providerState: t.status }]
        : [],
    );
  }

  async resolve(ref: string, signal?: AbortSignal): Promise<PlaybackGrant> {
    this.counter.add("rd.unrestrict");
    const res = await fetch(`${this.base}/rest/1.0/unrestrict/link`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link: ref }),
      signal,
    });
    if (!res.ok) throw classify(res.status, await res.text());
    const body = (await res.json()) as { download: string };
    // R02 documents no lifetime for unrestricted links.
    return { url: body.download, expiresAtMs: null, obtainedAtMs: Date.now() };
  }

  /** GET /user: one call. Keeps the plan type and premium end, nothing personal. */
  async account(signal?: AbortSignal): Promise<AccountInfo> {
    this.counter.add("rd.user");
    const res = await fetch(`${this.base}/rest/1.0/user`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const u = (await res.json()) as { type?: string; premium?: number; expiration?: string | null };
    const until = u.expiration ? Date.parse(u.expiration) : NaN;
    return {
      plan: u.type ?? null,
      premiumUntilMs: Number.isFinite(until) ? until : null,
      premium: u.type === "premium" && (u.premium ?? 1) > 0,
      checkedAtMs: Date.now(),
    };
  }

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}

// TorBox plan codes as used by its SDK (inferred; unknown codes are shown as-is).
const TB_PLANS: Record<number, string> = { 0: "Free", 1: "Essential", 2: "Pro", 3: "Standard" };

export class TorBoxClient implements ProviderClient {
  readonly id = "torbox" as const;
  private readonly base: string;
  private readonly token: string;
  readonly counter: CallCounter;

  constructor(base: string, token: string, counter = new CallCounter()) {
    this.base = base;
    this.token = token;
    this.counter = counter;
  }

  async inventory(signal?: AbortSignal): Promise<InventoryFile[]> {
    this.counter.add("tb.mylist");
    const res = await fetch(`${this.base}/v1/api/torrents/mylist`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const body = (await res.json()) as {
      data: Array<{ id: number; download_finished: boolean; files: Array<{ id: number; name: string; size: number }> }>;
    };
    return body.data.flatMap((t) =>
      t.files.map((f) => ({
        provider: "torbox" as const,
        ref: `tb:${t.id}:${f.id}`,
        name: f.name,
        bytes: f.size,
        // T10 warns the finished flag alone is not a readiness signal; keep it verbatim.
        providerState: t.download_finished ? "download_finished" : "not_finished",
      })),
    );
  }

  /** Always asks for the JSON form (redirect=false) so the CDN URL can be reused. */
  async resolve(ref: string, signal?: AbortSignal): Promise<PlaybackGrant> {
    this.counter.add("tb.requestdl");
    const res = await fetch(this.requestUrl(ref, false), { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const body = (await res.json()) as { data: string };
    // SDK text conflicts on 1h vs 3h link windows (handoff §5.2): do not trust either.
    return { url: body.data, expiresAtMs: null, obtainedAtMs: Date.now() };
  }

  /** GET /user/me: one call. Plan and premium end only. */
  async account(signal?: AbortSignal): Promise<AccountInfo> {
    this.counter.add("tb.user");
    const res = await fetch(`${this.base}/v1/api/user/me`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const d = ((await res.json()) as { data?: { plan?: number; premium_expires_at?: string | null } }).data ?? {};
    const until = d.premium_expires_at ? Date.parse(d.premium_expires_at) : NaN;
    const untilMs = Number.isFinite(until) ? until : null;
    return {
      plan: typeof d.plan === "number" ? (TB_PLANS[d.plan] ?? `Plan ${d.plan}`) : null,
      premiumUntilMs: untilMs,
      premium: d.plan !== 0 && (untilMs == null || untilMs > Date.now()),
      checkedAtMs: Date.now(),
    };
  }

  /** The redirecting API URL. Handing this to a player is the A03 anti-pattern. */
  requestUrl(ref: string, redirect: boolean): string {
    const [, tid, fid] = ref.split(":");
    // TorBox's docs take the key as a `token` query parameter on this route.
    const q = new URLSearchParams({ token: this.token, torrent_id: tid!, file_id: fid!, redirect: String(redirect) });
    return `${this.base}/v1/api/torrents/requestdl?${q}`;
  }

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}
