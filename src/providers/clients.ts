// Thin, read-only clients for Real-Debrid and TorBox. They take a base URL so the
// same code runs against the mock server today. No credentials are stored here and
// nothing has been exercised against a live account (that waits for an explicit
// go-ahead). Every call is counted so API usage is measurable from the client side.

import { classify, type InventoryFile, type PlaybackGrant, type ProviderClient } from "./types.ts";

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

  async inventory(signal?: AbortSignal): Promise<InventoryFile[]> {
    this.counter.add("rd.torrents");
    const res = await fetch(`${this.base}/rest/1.0/torrents`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text());
    const rows = (await res.json()) as Array<{ id: string; filename: string; bytes: number; status: string; links: string[] }>;
    return rows.map((r) => ({
      provider: "realdebrid",
      ref: r.links[0] ?? r.id,
      name: r.filename,
      bytes: r.bytes,
      providerState: r.status,
    }));
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

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}

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

  /** The redirecting API URL. Handing this to a player is the A03 anti-pattern. */
  requestUrl(ref: string, redirect: boolean): string {
    const [, tid, fid] = ref.split(":");
    const q = new URLSearchParams({ torrent_id: tid!, file_id: fid!, redirect: String(redirect) });
    return `${this.base}/v1/api/torrents/requestdl?${q}`;
  }

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}
