// Home network access: the private-address filter, pairing codes, device tokens,
// revocation, and the server refusing anything outside a paired home device.
// Remote devices are simulated by overriding the request's peer address; no
// real network interface is opened.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "debridtv-lan-"));
process.env.DEBRIDTV_HOME = home;

const { isPrivateAddress, isLoopback, normalizeIp, homeAddresses, guessDeviceName, cleanDeviceName, LanAccess, PAIR_TRIES, PAIR_CODE_MS } =
  await import("../app/lan/access.ts");
const { Gates } = await import("../src/gates.ts");
const { createApp } = await import("../app/server.ts");

after(() => rmSync(home, { recursive: true, force: true }));

// ---------------------------------------------------------------- address filter

test("private address filter accepts home ranges only", () => {
  for (const a of ["10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.10.10",
    "127.0.0.1", "::1", "fe80::1", "fe80::1%eth0", "fd12:3456:789a::1", "fc00::1", "::ffff:192.168.0.9", "[fd00::2]"])
    assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.169.1.1", "100.64.0.1", "100.127.255.254",
    "11.0.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "2001:4860:4860::8888", "2606:4700::1111", "::", "ff02::1",
    "::ffff:8.8.8.8", "fec0::1", "999.1.1.1", "", "not-an-ip", "192.168.1", undefined, null])
    assert.equal(isPrivateAddress(a as string), false, String(a));
});

test("address helpers normalise and spot loopback", () => {
  assert.equal(normalizeIp("::FFFF:192.168.1.2"), "192.168.1.2");
  assert.equal(normalizeIp("fe80::1%12"), "fe80::1");
  assert.equal(isLoopback("127.8.9.10"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.2"), false);
});

test("the PC only offers its private, typeable addresses", () => {
  const ifaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    wifi: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::abcd", family: "IPv6", internal: false },
      { address: "fd00::20", family: "IPv6", internal: false },
      { address: "2001:db8::20", family: "IPv6", internal: false },
    ],
    wan: [{ address: "81.2.69.160", family: "IPv4", internal: false }],
    cgnat: [{ address: "100.64.3.4", family: "IPv4", internal: false }],
  } as never;
  assert.deepEqual(homeAddresses(ifaces).map((a) => a.address), ["192.168.1.20", "fd00::20"]);
});

test("device names are guessed and cleaned", () => {
  assert.equal(guessDeviceName("Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit"), "TV");
  assert.equal(guessDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile"), "Phone");
  assert.equal(guessDeviceName("Mozilla/5.0 (Windows NT 10.0)"), "Computer");
  assert.equal(cleanDeviceName("  <b>Den TV</b>  "), "bDen TV/b");
  assert.equal(cleanDeviceName("", "Mozilla (iPad)"), "Tablet");
  assert.equal(cleanDeviceName("x".repeat(80)).length, 40);
});

// ---------------------------------------------------------------- pairing

function access(now: { t: number }, gates = new Gates()) {
  return new LanAccess({ gates, now: () => now.t, listen: false, addresses: () => [{ name: "wifi", address: "192.168.1.20", family: "IPv4" }] });
}

test("pairing needs the switch on, a live code, and the right digits", async () => {
  const now = { t: 1_000_000 };
  const gates = new Gates();
  const lan = access(now, gates);
  await lan.setEnabled(false);
  assert.equal(lan.pair("123456", "TV", "192.168.1.50").ok, false);
  assert.throws(() => lan.startPairing());
  await lan.setEnabled(true);
  assert.equal(gates.isGranted("sharing"), true);
  assert.equal((lan.pair("123456", "TV", "192.168.1.50") as { status: number }).status, 409, "no code is showing");

  const { code } = lan.startPairing();
  assert.match(code, /^\d{6}$/);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((lan.pair("12", "TV", "192.168.1.50") as { status: number }).status, 400);
  for (let i = 1; i < PAIR_TRIES; i++) assert.equal((lan.pair(wrong, "TV", "192.168.1.50") as { status: number }).status, 403);
  // The last wrong try throws the code away; even the right code no longer works.
  assert.equal((lan.pair(wrong, "TV", "192.168.1.50") as { status: number }).status, 429);
  assert.equal((lan.pair(code, "TV", "192.168.1.50") as { status: number }).status, 409);

  const c2 = lan.startPairing().code;
  now.t += PAIR_CODE_MS;
  assert.equal((lan.pair(c2, "TV", "192.168.1.50") as { status: number }).status, 409, "expired codes fail");

  const c3 = lan.startPairing().code;
  const ok = lan.pair(c3.slice(0, 3) + " " + c3.slice(3), "Den TV", "::ffff:192.168.1.50");
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.device.name, "Den TV");
  assert.equal(ok.device.lastAddress, "192.168.1.50");
  assert.equal(lan.verify(ok.token)?.id, ok.device.id);
  assert.equal((lan.pair(c3, "Second", "192.168.1.51") as { status: number }).status, 409, "one code pairs one device");

  // Only a hash of the secret is stored.
  const disk = readFileSync(join(home, "lan.json"), "utf8");
  assert.equal(disk.includes(ok.token.split(".")[1]!), false);
  assert.equal(lan.verify(ok.token.slice(0, -1) + (ok.token.endsWith("A") ? "B" : "A")), null);
  assert.equal(lan.verify(`nope.${ok.token.split(".")[1]}`), null);
  assert.equal(lan.verify("garbage"), null);

  assert.equal(lan.rename(ok.device.id, "Living room"), true);
  assert.equal(lan.devices()[0]!.name, "Living room");
  assert.equal(lan.revoke(ok.device.id), true);
  assert.equal(lan.verify(ok.token), null);
  assert.equal(lan.revoke(ok.device.id), false);

  await lan.setEnabled(false);
  assert.equal(gates.isGranted("sharing"), false);
});

test("the setting survives a restart and re-grants the gate", async () => {
  const now = { t: 5 };
  await access(now).setEnabled(true);
  const gates = new Gates();
  const again = access(now, gates);
  assert.equal(again.enabled, true);
  assert.equal(gates.isGranted("sharing"), true);
  await again.setEnabled(false);
});

// ---------------------------------------------------------------- server

const app = createApp({
  port: 0,
  ffmpeg: false,
  timers: false,
  lan: {
    listen: false,
    addresses: () => [{ name: "wifi", address: "192.168.1.20", family: "IPv4" }],
    // Test-only: the request says which address it comes from.
    peer: (req) => (req.headers["x-test-peer"] as string | undefined) ?? req.socket.remoteAddress,
  },
});
let port = 0;
before(async () => {
  port = await app.listen();
});
after(() => app.close());

interface Res { status: number; body: any; headers: http.IncomingHttpHeaders; socket?: import("node:net").Socket }
function req(method: string, path: string, o: { peer?: string; cookie?: string; host?: string; origin?: string; body?: unknown; agent?: http.Agent } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${port}` };
    if (o.peer) headers["x-test-peer"] = o.peer;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.origin) headers.origin = o.origin;
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (data) headers["content-type"] = "application/json";
    const r = http.request({ host: "127.0.0.1", port, method, path, headers, agent: o.agent ?? false }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        let body: unknown = s;
        try { body = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode!, body, headers: res.headers, socket });
      });
    });
    let socket: import("node:net").Socket | undefined;
    r.on("socket", (s) => (socket = s));
    r.on("error", reject);
    r.end(data);
  });
}
const TV = "192.168.1.50";

test("server: off by default, nothing but the PC gets in", async () => {
  assert.equal((await req("GET", "/api/bootstrap")).status, 200);
  assert.equal((await req("GET", "/api/bootstrap", { peer: TV })).status, 403);
  assert.equal((await req("GET", "/pair", { peer: TV })).status, 403);
  assert.equal((await req("GET", "/api/lan")).body.enabled, false);
  assert.equal((await req("GET", "/api/bootstrap")).body.gates.sharing, false);
  // With it off, the home address isn't an accepted Host either.
  assert.equal((await req("GET", "/api/bootstrap", { host: `192.168.1.20:${port}` })).status, 403);
});

test("server: pair a TV, watch, and keep setup on the PC", async () => {
  const on = await req("POST", "/api/lan", { body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.addresses[0].url, `http://192.168.1.20:${port}`);
  assert.equal((await req("GET", "/api/bootstrap")).body.gates.sharing, true);

  // Outside the home network: refused whatever it carries.
  for (const peer of ["8.8.8.8", "100.64.1.1", "2001:db8::1"]) assert.equal((await req("GET", "/pair", { peer })).status, 403, peer);

  // An unpaired device on the Wi-Fi sees only the pairing screen.
  const root = await req("GET", "/", { peer: TV, host: `192.168.1.20:${port}` });
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/pair");
  assert.equal((await req("GET", "/api/guide", { peer: TV })).status, 401);
  assert.equal((await req("GET", "/media/demo-1", { peer: TV })).status, 401);
  assert.equal((await req("GET", "/js/main.js", { peer: TV })).status, 302);
  const pairPage = await req("GET", "/pair", { peer: TV, host: `192.168.1.20:${port}` });
  assert.equal(pairPage.status, 200);
  assert.match(String(pairPage.body), /Pair this device/);
  assert.equal((await req("GET", "/fonts/fonts.css", { peer: TV })).status, 200);
  const hello = await req("GET", "/api/lan/hello", { peer: TV });
  assert.deepEqual([hello.body.where, hello.body.pairing], ["stranger", false]);
  assert.equal((await req("GET", "/lan", { peer: TV })).status, 302);
  assert.equal((await req("POST", "/api/lan/pairing", { peer: TV, body: {} })).status, 401, "a stranger can't start pairing");
  assert.equal((await req("POST", "/api/lan/pair", { peer: TV, body: { code: "123456" } })).status, 409);

  // The PC shows a code; the TV types it.
  const code = (await req("POST", "/api/lan/pairing", { body: {} })).body.pairing.code as string;
  const paired = await req("POST", "/api/lan/pair", { peer: TV, host: `192.168.1.20:${port}`, origin: `http://192.168.1.20:${port}`, body: { code, name: "Den TV" } });
  assert.equal(paired.status, 200);
  const setCookie = String(paired.headers["set-cookie"]);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0]!;

  const tv = { peer: TV, cookie, host: `192.168.1.20:${port}` };
  assert.equal((await req("GET", "/api/lan/hello", tv)).body.device.name, "Den TV");
  const boot = await req("GET", "/api/bootstrap", tv);
  assert.equal(boot.status, 200);
  assert.ok(boot.body.channels.length > 0);
  assert.equal((await req("GET", "/api/guide", tv)).status, 200);
  assert.equal((await req("GET", "/", tv)).status, 200);
  // Same-origin rules still hold for the home address.
  assert.equal((await req("GET", "/api/bootstrap", { ...tv, origin: "http://evil.example" })).status, 403);
  assert.equal((await req("GET", "/api/bootstrap", { ...tv, host: `evil.example:${port}` })).status, 403);
  // The cookie is useless from outside the home network.
  assert.equal((await req("GET", "/api/bootstrap", { ...tv, peer: "8.8.8.8" })).status, 403);

  // Setup stays on the PC.
  for (const [m, p] of [["GET", "/api/lan"], ["POST", "/api/lan"], ["POST", "/api/lan/pairing"], ["POST", "/api/lan/revoke"],
    ["POST", "/api/sources"], ["POST", "/api/sources/disconnect"], ["POST", "/api/lock/pin"], ["POST", "/api/import"],
    ["POST", "/api/forget"], ["POST", "/api/backups/restore"], ["GET", "/lan"]] as const) {
    const r = await req(m, p, { ...tv, body: m === "POST" ? { enabled: false } : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal((await req("GET", "/api/lan")).body.enabled, true, "the TV couldn't turn it off");
  // Reading sources is fine (keys are never in it); the PIN guard behaves as on the PC.
  const src = await req("GET", "/api/sources", tv);
  assert.equal(src.status, 200);
  assert.equal(JSON.stringify(src.body).includes("Key\""), false);
  assert.equal((await req("POST", "/api/lock/unlock", { ...tv, body: { pin: "0000" } })).status >= 400, true);

  // The PC's own browser on its home address counts as the PC.
  assert.equal((await req("GET", "/api/lan", { peer: "192.168.1.20", host: `192.168.1.20:${port}` })).status, 200);

  // Revoke while the TV holds a connection open: the socket is cut.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const held = await req("GET", "/api/now?channel=none", { ...tv, agent });
  const sock = held.socket!;
  const closed = new Promise<void>((r) => (sock.destroyed ? r() : sock.once("close", () => r())));
  const id = (await req("GET", "/api/lan")).body.devices[0].id;
  assert.equal((await req("GET", "/api/lan")).body.devices[0].connected, true);
  assert.equal((await req("POST", "/api/lan/revoke", { body: { id } })).status, 200);
  await closed;
  agent.destroy();
  assert.equal((await req("GET", "/api/bootstrap", tv)).status, 401);
  assert.equal((await req("GET", "/", tv)).status, 302);
  assert.equal((await req("GET", "/api/lan")).body.devices.length, 0);

  // Turning it off shuts the door again.
  await req("POST", "/api/lan", { body: { enabled: false } });
  assert.equal((await req("GET", "/pair", { peer: TV })).status, 403);
  assert.equal((await req("GET", "/api/bootstrap")).body.gates.sharing, false);
});

test("server: the PC's Home network page", async () => {
  const r = await req("GET", "/lan");
  assert.equal(r.status, 200);
  assert.match(String(r.body), /Let devices on my Wi-Fi watch/);
  assert.equal(r.headers["x-frame-options"], "DENY");
});

test("real listeners: bound per home address next to 127.0.0.1, closed when turned off", async () => {
  const gates = new Gates();
  const lan = new LanAccess({ gates, listen: true, addresses: () => [{ name: "alias", address: "127.0.0.2", family: "IPv4" }] });
  const server = http.createServer((q, s) => s.end("hi"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const p = (server.address() as import("node:net").AddressInfo).port;
  await lan.start(server, p);
  const fetchVia = (host: string) => new Promise<string>((resolve, reject) =>
    http.get({ host, port: p, agent: false }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(s));
    }).on("error", (e) => reject(e)));
  await assert.rejects(fetchVia("127.0.0.2"), "nothing listens there while off");
  await lan.setEnabled(true);
  assert.equal(await fetchVia("127.0.0.2"), "hi");
  assert.deepEqual((lan.status() as { listening: string[] }).listening, [`127.0.0.2:${p}`]);
  await lan.setEnabled(false);
  await assert.rejects(fetchVia("127.0.0.2"));
  assert.equal(await fetchVia("127.0.0.1"), "hi", "the PC's own address is untouched");
  await lan.stop();
  await new Promise<void>((r) => server.close(() => r()));
});
