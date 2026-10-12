// Serves the window check (page.html) on 127.0.0.1:<port>: the page, the real
// native-video.js, one media file with byte ranges (so mpv can seek), and a
// /report endpoint that writes what the page saw to <report>.
//   node test/desktop/serve.mjs <port> <media file> <report.json>
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [port, media, reportFile] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && p === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => (writeFileSync(reportFile, body), res.end("ok")));
    return;
  }
  if (p === "/") return res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(here, "page.html")));
  if (p === "/js/native-video.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(here, "../../app/public/js/native-video.js")));
  if (p === "/media/test") {
    const size = statSync(media).size;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      "content-type": "video/x-matroska", "accept-ranges": "bytes", "content-length": end - start + 1,
      ...(m ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    return createReadStream(media, { start, end }).pipe(res);
  }
  res.writeHead(404).end();
}).listen(Number(port), "127.0.0.1", () => console.log(`window check page on http://127.0.0.1:${port}/`));
