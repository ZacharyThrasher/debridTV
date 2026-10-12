// Builds DebridTV.exe: one Windows x64 file with Node and the whole app inside
// (Node single executable application). Runs on Linux, macOS or Windows.
//
//   npm run build:exe                 dist/DebridTV.exe + dist/DebridTV-v<version>-win-x64.zip
//   node scripts/build-exe.mjs --host builds for this machine instead (smoke tests)
//
// The Node used to run this script must be the same version that ends up in the
// exe, because the app blob is tied to it. The Windows Node download is checked
// against nodejs.org's published SHA-256 sums and cached in dist/cache.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const WORK = join(DIST, "build");
const CACHE = join(DIST, "cache");
const host = process.argv.includes("--host");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const nodeVersion = process.version;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// 1. One CommonJS file (what Node's single executable support runs).
const bundle = join(WORK, "debridtv.cjs");
await build({
  entryPoints: [join(ROOT, "app/launcher.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${nodeVersion.slice(1).split(".")[0]}`,
  // Inside the exe there is no source file; this stand-in keeps server.ts's
  // "am I the entry point?" check false. Page folders come from the launcher.
  define: { "import.meta.url": JSON.stringify("file:///C:/debridtv-exe/app/server.js") },
  legalComments: "none",
  logLevel: "warning",
});

// 2. Page files, packed as assets and unpacked once per version on first start.
const assets = {};
const files = [];
const walk = (dir, prefix) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, `${prefix}/${name}`);
    else {
      const key = `${prefix}/${name}`;
      assets[key] = p;
      files.push(key);
    }
  }
};
walk(join(ROOT, "app/public"), "public");
for (const name of readdirSync(join(ROOT, "app/lan"))) if (name.endsWith(".html")) {
  assets[`lan/${name}`] = join(ROOT, "app/lan", name);
  files.push(`lan/${name}`);
}
const hash = createHash("sha256");
for (const f of files.sort()) hash.update(f).update(readFileSync(assets[f]));
const manifest = join(WORK, "manifest.json");
writeFileSync(manifest, JSON.stringify({ version, files, contentHash: hash.digest("hex") }));
assets["manifest.json"] = manifest;

const blob = join(WORK, "sea-prep.blob");
const seaConfig = join(WORK, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false, // code cache is platform specific; the exe is built cross-platform
  assets,
}, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3. A copy of the right Node binary.
let base;
if (host) base = process.execPath;
else {
  const name = `node-${nodeVersion}-win-x64`;
  const zip = join(CACHE, `${name}.zip`);
  const sums = join(CACHE, `SHASUMS256-${nodeVersion}.txt`);
  const url = `https://nodejs.org/dist/${nodeVersion}`;
  if (!existsSync(sums)) writeFileSync(sums, Buffer.from(await (await fetch(`${url}/SHASUMS256.txt`)).arrayBuffer()));
  if (!existsSync(zip)) {
    console.log(`Downloading ${name}.zip`);
    const res = await fetch(`${url}/${name}.zip`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const want = readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${name}.zip`))?.split(" ")[0];
  const got = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (!want || want !== got) throw new Error(`${name}.zip checksum mismatch (want ${want}, got ${got})`);
  execFileSync("unzip", ["-o", "-q", "-j", zip, `${name}/node.exe`, `${name}/LICENSE`, "-d", join(CACHE, name)]);
  base = join(CACHE, name, "node.exe");
}

const exe = join(DIST, host ? (process.platform === "win32" ? "DebridTV-host.exe" : "debridtv-host") : "DebridTV.exe");
rmSync(exe, { force: true });
copyFileSync(base, exe);
if (!host) stripSignature(exe);
const postject = join(ROOT, "node_modules/postject/dist/cli.js");
execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" && host ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
console.log(`Built ${relative(ROOT, exe)} (${(statSync(exe).size / 1048576).toFixed(1)} MB, Node ${nodeVersion})`);

// 4. The zip people download.
if (!host) {
  const stage = join(WORK, "zip", "DebridTV");
  mkdirSync(stage, { recursive: true });
  copyFileSync(exe, join(stage, "DebridTV.exe"));
  copyFileSync(join(ROOT, "packaging/README.txt"), join(stage, "README.txt"));
  copyFileSync(join(CACHE, `node-${nodeVersion}-win-x64`, "LICENSE"), join(stage, "LICENSE-node.txt"));
  const out = join(DIST, `DebridTV-v${version}-win-x64.zip`);
  rmSync(out, { force: true });
  execFileSync("zip", ["-q", "-r", "-9", out, "DebridTV"], { cwd: join(WORK, "zip") });
  console.log(`Built ${relative(ROOT, out)} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
}

/**
 * Remove node.exe's Authenticode signature (what `signtool remove /s` does). Adding
 * the app breaks it anyway, and Windows treats a broken signature worse than none.
 */
function stripSignature(file) {
  const buf = readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error("not a PE file");
  const opt = pe + 24;
  if (buf.readUInt16LE(opt) !== 0x20b) throw new Error("expected a 64-bit PE file");
  const dir = opt + 112 + 4 * 8; // data directory 4: certificate table
  const at = buf.readUInt32LE(dir);
  const size = buf.readUInt32LE(dir + 4);
  if (!at) return;
  buf.writeUInt32LE(0, dir);
  buf.writeUInt32LE(0, dir + 4);
  writeFileSync(file, at + size === buf.length ? buf.subarray(0, at) : buf);
}
