// Run the app against the mock providers, with a made-up library that has every
// kind of file state: ready, not finished at the provider, refused, a multi-file
// pack, an expired account toggle. No real provider is contacted.
//
//   npm run dev:mock            then open http://127.0.0.1:7338
//   DEBRIDTV_MOCK_SHOWS=1 npm run dev:mock   adds shows under many spellings (show identity)
//   keys: TorBox "mock-torbox-key-0000000000", Real-Debrid "mock-rd-key-00000000000000"
//
// The data folder is a fresh temp folder each run unless DEBRIDTV_HOME is set.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEBRIDTV_HOME ??= mkdtempSync(join(tmpdir(), "debridtv-mock-"));
const { startMockProviders } = await import("../src/providers/mock-server.ts");
const { createApp } = await import("./server.ts");

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url)));
const mkv = fx("fixture-h264-aac.mkv");
const mp4 = fx("fixture-h264-aac-faststart.mp4");
const TB = "mock-torbox-key-0000000000";
const RD = "mock-rd-key-00000000000000";

const files = [
  ...Array.from({ length: 10 }, (_, i) => ({ ref: `tb:${10 + i}:1`, name: `Harbor.Lights.S01E${String(i + 1).padStart(2, "0")}.720p.WEB.mkv`, bytes: mkv.byteLength, content: mkv })),
  ...Array.from({ length: 7 }, (_, i) => ({ ref: `tb:${40 + i}:1`, name: `Star Courier (1994) - S02E0${i + 1} - Episode.mp4`, bytes: mp4.byteLength, content: mp4 })),
  { ref: "tb:90:1", name: "Weathervane.Mysteries.S01E01.1080p.mkv", bytes: 1.4e9, state: "downloading" as const },
  { ref: "tb:91:1", name: "Weathervane.Mysteries.S01E02.1080p.mkv", bytes: 1.4e9, state: "downloading" as const },
  { ref: "rd:m1", name: "The.Long.Signal.1987.1080p.BluRay.mkv", bytes: mkv.byteLength, content: mkv },
  { ref: "rd:m2", name: "Neon.Harbor.1989.720p.mkv", bytes: mkv.byteLength, content: mkv, policy: true },
  { ref: "rd:m3", name: "Paper.Rockets.1984.DVDRip.mkv", bytes: mkv.byteLength, content: mkv },
  { ref: "rd:m4", name: "Cassette.Hearts.1986.mkv", bytes: mkv.byteLength, content: mkv },
  { ref: "rd:m5", name: "Static.Summer.1992.mkv", bytes: mkv.byteLength, content: mkv },
  { ref: "rd:m6", name: "Lighthouse.Radio.1998.mkv", bytes: 2.1e9, state: "magnet_error" as const },
  { ref: "tb:95:1", name: "Readme.txt.mkv", bytes: 1200 },
];
if (process.env.DEBRIDTV_MOCK_SHOWS === "1") {
  const { MOCK_SHOW_FILES } = await import("../test/fixtures/show-names.ts");
  files.push(...MOCK_SHOW_FILES.map((name, i) => ({ ref: `tb:${200 + i}:1`, name, bytes: mkv.byteLength, content: mkv })));
}

const mock = await startMockProviders({
  files,
  apiLatencyMs: 120,
  mediaTtfbMs: 150,
  account: { token: [TB, RD], premiumUntilMs: Date.now() + 41 * 86400_000, plan: "2" },
});
const app = createApp({ port: Number(process.env.PORT ?? 7338), bases: { torbox: `${mock.baseUrl}/tb`, realdebrid: `${mock.baseUrl}/rd` } });
const port = await app.listen();
console.log(`\n  DebridTV against MOCK providers:  http://127.0.0.1:${port}`);
console.log(`  TorBox key:       ${TB}\n  Real-Debrid key:  ${RD}`);
console.log(`  Data folder: ${process.env.DEBRIDTV_HOME}`);
console.log(`  Type "expire" + Enter to end the mock premium, "renew" to restore it.\n`);
process.stdin.setEncoding("utf8").on("data", (line: string) => {
  const cmd = line.trim();
  if (cmd === "expire") mock.setAccount({ token: [TB, RD], premiumUntilMs: Date.now() - 86400_000, plan: "2" });
  if (cmd === "renew") mock.setAccount({ token: [TB, RD], premiumUntilMs: Date.now() + 41 * 86400_000, plan: "2" });
  if (cmd) console.log(`  mock: ${cmd}`);
});
