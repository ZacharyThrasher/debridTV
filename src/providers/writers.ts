// Account-changing calls: adding a torrent, a web link or a Usenet job, and
// choosing which files of a Real-Debrid torrent to keep. Kept apart from the
// read-only clients on purpose. Nothing here runs unless the viewer has allowed
// adding (Settings → Add) and pressed Add, or dropped a file in their watched
// folder (app/acquire.ts). Nothing here ever deletes.

import { classify } from "./types.ts";
/** Anything that counts calls (CallCounter, or the meters' RateCounter). */
type Counter = { add(name: string): void };

export interface AddedTorrent {
  /** The provider's own id for the new torrent or job. */
  id: string;
  /** Lower-case hex info hash, when the provider said. */
  hash?: string;
}

export interface RdTorrentInfo {
  id: string;
  filename: string;
  hash: string;
  status: string;
  files: Array<{ id: number; path: string; bytes: number; selected: number }>;
  links: string[];
}

export class RealDebridWriter {
  private readonly base: string;
  private readonly token: string;
  private readonly counter: Counter;

  constructor(base: string, token: string, counter: Counter) {
    this.base = base;
    this.token = token;
    this.counter = counter;
  }

  async addMagnet(magnet: string, signal?: AbortSignal): Promise<AddedTorrent> {
    this.counter.add("rd.addMagnet");
    const res = await fetch(`${this.base}/rest/1.0/torrents/addMagnet`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet }),
      signal,
    });
    return this.added(res);
  }

  /** The .torrent file as it is, byte for byte (RD reads the raw body). */
  async addTorrent(bytes: Uint8Array, signal?: AbortSignal): Promise<AddedTorrent> {
    this.counter.add("rd.addTorrent");
    const res = await fetch(`${this.base}/rest/1.0/torrents/addTorrent`, {
      method: "PUT",
      headers: { ...this.auth(), "content-type": "application/x-bittorrent" },
      body: Buffer.from(bytes),
      signal,
    });
    return this.added(res);
  }

  async info(id: string, signal?: AbortSignal): Promise<RdTorrentInfo> {
    this.counter.add("rd.torrents.info");
    const res = await fetch(`${this.base}/rest/1.0/torrents/info/${encodeURIComponent(id)}`, { headers: this.auth(), signal });
    if (!res.ok) throw classify(res.status, await res.text(), res.headers.get("retry-after"));
    return (await res.json()) as RdTorrentInfo;
  }

  /** RD keeps nothing until files are chosen; "all" or a list of file ids. */
  async selectFiles(id: string, files: number[] | "all", signal?: AbortSignal): Promise<void> {
    this.counter.add("rd.selectFiles");
    const res = await fetch(`${this.base}/rest/1.0/torrents/selectFiles/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ files: files === "all" ? "all" : files.join(",") }),
      signal,
    });
    if (!res.ok) throw classify(res.status, await res.text(), res.headers.get("retry-after"));
  }

  private async added(res: Response): Promise<AddedTorrent> {
    if (!res.ok) throw classify(res.status, await res.text(), res.headers.get("retry-after"));
    const b = (await res.json()) as { id: string };
    return { id: String(b.id) };
  }

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}

export class TorBoxWriter {
  private readonly base: string;
  private readonly token: string;
  private readonly counter: Counter;

  constructor(base: string, token: string, counter: Counter) {
    this.base = base;
    this.token = token;
    this.counter = counter;
  }

  /** A magnet, or a .torrent file uploaded as it is. */
  async createTorrent(input: { magnet: string } | { file: Uint8Array; name: string }, signal?: AbortSignal): Promise<AddedTorrent> {
    const form = new FormData();
    if ("magnet" in input) form.append("magnet", input.magnet);
    else form.append("file", new Blob([Buffer.from(input.file)], { type: "application/x-bittorrent" }), input.name);
    return this.post("createtorrent", "/v1/api/torrents/createtorrent", form, "torrent_id", signal);
  }

  /** A direct http(s) link TorBox fetches for you ("web download"). */
  async createWebDownload(link: string, signal?: AbortSignal): Promise<AddedTorrent> {
    const form = new FormData();
    form.append("link", link);
    return this.post("createwebdownload", "/v1/api/webdl/createwebdownload", form, "webdownload_id", signal);
  }

  /** A Newznab link or an .nzb file. */
  async createUsenetDownload(input: { link: string } | { file: Uint8Array; name: string }, signal?: AbortSignal): Promise<AddedTorrent> {
    const form = new FormData();
    if ("link" in input) form.append("link", input.link);
    else form.append("file", new Blob([Buffer.from(input.file)], { type: "application/x-nzb" }), input.name);
    return this.post("createusenetdownload", "/v1/api/usenet/createusenetdownload", form, "usenetdownload_id", signal);
  }

  private async post(name: string, path: string, form: FormData, idKey: string, signal?: AbortSignal): Promise<AddedTorrent> {
    this.counter.add(`tb.${name}`);
    const res = await fetch(`${this.base}${path}`, { method: "POST", headers: this.auth(), body: form, signal });
    const text = await res.text();
    if (!res.ok) throw classify(res.status, text, res.headers.get("retry-after"));
    let b: { success?: boolean; error?: string | null; detail?: string; data?: Record<string, unknown> } = {};
    try {
      b = JSON.parse(text);
    } catch {}
    // TorBox can answer 200 with success:false.
    if (b.success === false) throw classify(400, text);
    const d = b.data ?? {};
    return { id: String(d[idKey] ?? d.id ?? ""), hash: typeof d.hash === "string" ? d.hash.toLowerCase() : undefined };
  }

  private auth() {
    return { authorization: `Bearer ${this.token}` };
  }
}
