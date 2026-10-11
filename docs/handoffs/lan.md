# Home network access (sharing gate) handoff, 2026-10-11

Branch `claude/project-thread-av90vu`, on top of main `14f0a5e`. Zachary approved home
network access on 2026-10-11.

## What it does

- Off by default. Turned on only from the PC itself at `http://127.0.0.1:7337/lan`.
- When on, the app also listens on each of the PC's private addresses (one TCP listener
  per address, never `0.0.0.0`), handing sockets to the same HTTP server. No port
  forwarding, no UPnP. Addresses are re-checked every minute (DHCP changes).
- Turning it on grants the `sharing` gate (`src/gates.ts`); turning it off revokes it,
  closes the listeners and cuts every remote connection. Opening listeners calls
  `gates.require("sharing")`.
- Only private peers are accepted: loopback, 10/8, 172.16/12, 192.168/16, 169.254/16,
  fe80::/10, fc00::/7 (IPv4-mapped forms too). CGNAT 100.64/10 and public addresses get 403.
- Host must be `127.0.0.1:port`, `localhost:port`, or (when on) one of the PC's own home
  addresses with the port; Origin must match Host. Literal addresses only, so DNS
  rebinding still can't reach it.
- Pairing: the PC shows a 6-digit code (5 min, 5 wrong tries then void, one code = one
  device). The device gets `dtv_device=<id>.<secret>` (HttpOnly, SameSite=Strict, 400 days).
  Only sha256(secret) is stored in `<data>/lan.json` (chmod 600). Max 24 devices.
- Unpaired devices on the Wi-Fi can load only `/pair`, `/fonts/*`, `/icon.svg`,
  `GET /api/lan/hello`, `POST /api/lan/pair`. Pages redirect to `/pair`; `/api` and
  `/media` get `401 {error, pair: "/pair"}`.
- Paired devices use the normal handler, so PIN locks, final 409/451/403 and the no-fetch
  rules apply unchanged. PC-only for devices (403 `{pcOnly: true}`): `POST /api/sources`,
  `/api/sources/disconnect`, `/api/sources/account`, `/api/forget`, `/api/import`,
  `POST /api/backups`, `/api/backups/restore`, `/api/lock/pin`, `/api/lan/*` admin, `/lan`.
- Revoking a device destroys its open sockets at once.
- The PC's own browser on its home address counts as the PC.

## Files

- `app/lan/access.ts`: filter, pairing, tokens, request screening, listeners.
- `app/lan/pair.html`: TV/phone pairing screen (remote digits, arrows, OK, Back keys incl. webOS 461 / Tizen 10009).
- `app/lan/manage.html`: PC page (switch, address, code with countdown, devices, rename, remove).
- `app/server.ts`: small hooks only (import, `lan` instance, `lan.intercept` replaces the
  old Host/Origin check, `lan.start/stop` in listen/close, `opts.lan` for tests).
- `test/lan.test.ts`: 10 tests (filter, addresses, names, pairing, restart, server flow, revocation cutting a socket, real listener on 127.0.0.2).

## API

- PC only: `GET /api/lan` → `{enabled, enabledAt, port, addresses[{name,address,family,url}], listening[], errors[], pairing|null {code, expiresAt, triesLeft}, devices[{id,name,pairedAt,lastSeenAt,lastAddress,connected}], maxDevices}`;
  `POST /api/lan {enabled}`; `POST /api/lan/pairing`; `POST /api/lan/pairing/cancel`;
  `POST /api/lan/revoke {id}`; `POST /api/lan/rename {id,name}`. All return the status shape.
- Anyone on the home network: `GET /api/lan/hello` → `{where: "pc"|"device"|"stranger", enabled, device?{id,name}, pairing?, suggestedName?}`; `POST /api/lan/pair {code, name?}`.

## Asked of other threads (via coordinator)

- C4 / settings panel: a "Home network" row in Settings that links to `/lan` (or embeds the
  same calls), shown only when `hello.where === "pc"`.
- B4 / UI: on any `401` with `pair` in the body, `location.replace("/pair")`; on
  `403 {pcOnly}`, show "Change this on the PC" instead of an error. Optionally hide Sources
  and PIN-change controls when `hello.where === "device"`.

## Open

- Real TV/phone check: runbook step 9 in `/mnt/project-files/debridTV/runbooks/pc-checks.md`.
- Traffic on the home network is plain HTTP (no certificate on a LAN IP). Anyone already
  on the Wi-Fi who sniffs traffic could copy a device cookie. Acceptable for home use;
  revoke fixes it. HTTPS would need a self-signed cert the TV would refuse.
- PIN unlock is global (existing behaviour): unlocking on the TV unlocks the PC for 4 h too.
- Possible later: QR code on `/lan` for phones; mDNS name (`debridtv.local`) would need a
  Host allowance and a rebinding review.
