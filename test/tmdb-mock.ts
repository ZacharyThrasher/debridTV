// A stand-in for TMDB's API and image host. Replays fixtures/tmdb/responses.json,
// records every request (so tests can check what left the PC) and answers 401 to
// any key but the test key.

import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

export const TEST_KEY = "0123456789abcdef0123456789abcdef";
const RESPONSES = JSON.parse(readFileSync(new URL("./fixtures/tmdb/responses.json", import.meta.url), "utf8")) as Record<string, unknown>;
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

export async function startTmdbMock(opts: { tooMany?: number } = {}) {
  const requests: Array<{ url: string; auth?: string; referer?: string }> = [];
  let tooMany = opts.tooMany ?? 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    requests.push({ url: req.url!, auth: req.headers.authorization, referer: req.headers.referer });
    if (url.pathname.startsWith("/img/")) {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
      return res.end(PNG);
    }
    const key = url.searchParams.get("api_key") ?? req.headers.authorization?.replace(/^Bearer /, "");
    if (key !== TEST_KEY) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status_code: 7, status_message: "Invalid API key: You must be granted a valid key." }));
    }
    if (tooMany > 0) {
      tooMany--;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      return res.end("{}");
    }
    const path = url.pathname.replace(/^\/3/, "");
    const q = url.searchParams.get("query");
    const y = url.searchParams.get("year");
    const k = q ? `${path}?query=${q}${y ? `&year=${y}` : ""}` : path;
    const body = RESPONSES[k] ?? (path.startsWith("/search/") ? { page: 1, results: [], total_results: 0 } : undefined);
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status_code: 34, status_message: "The resource you requested could not be found." }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    requests,
    apiBase: `${base}/3`,
    imageBase: `${base}/img`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
