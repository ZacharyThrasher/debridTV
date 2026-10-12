// Subtitle files you load from your own device (docs/parity/player.md). Pure: no DOM, so tests can import it.

/** Parse SubRip or WebVTT into [{ s, e, text }] (ms). Only <i> and <b> survive; ASS override tags are dropped. */
export function parseSubs(text) {
  const out = [];
  const time = (t) => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t);
    return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0")) : NaN;
  };
  for (const block of String(text).replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const s = time(a), e = time(b);
    const body = lines.slice(at + 1).join("\n").replace(/<(?!\/?[ib]>)[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
    if (Number.isFinite(s) && Number.isFinite(e) && e > s && body) out.push({ s, e, text: body });
  }
  return out;
}

