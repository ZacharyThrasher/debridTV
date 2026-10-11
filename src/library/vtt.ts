// WebVTT cue blocks as ffmpeg writes them, for subtitles sent beside a compatibility stream.

function vttTime(t: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/.exec(t.trim());
  return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) : null;
}

/** One WebVTT cue block → times and text, keeping only <i> and <b>. */
export function parseVttBlock(block: string): { startMs: number; endMs: number; text: string } | null {
  const lines = block.split("\n");
  const i = lines.findIndex((l) => l.includes("-->"));
  if (i < 0) return null;
  const [a, b] = lines[i]!.split("-->");
  const startMs = vttTime(a!);
  const endMs = vttTime((b ?? "").trim().split(/\s+/)[0] ?? "");
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  const text = lines.slice(i + 1).join("\n")
    .replace(/<(\/?)([ib])(?:[.\s][^>]*)?>/gi, "\u0001$1$2\u0002")
    .replace(/<[^>]*>/g, "")
    .replace(/\u0001(\/?)([ib])\u0002/gi, (_, sl: string, t: string) => `<${sl}${t.toLowerCase()}>`)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, "\u00a0")
    .trim();
  return text ? { startMs, endMs, text } : null;
}
