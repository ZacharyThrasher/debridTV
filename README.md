# DebridTV

A personal pseudo-live television experience over libraries you authorize, with
Real-Debrid and TorBox as first-class sources. Channels keep a timetable whether or
not anyone is watching; only the channel you actually watch fetches media.

**Status: watchable prototype.** Open it in a browser and channel-surf. With no
account connected it runs demo channels (made-up shows painted in the browser, zero
traffic). Connect TorBox, Real-Debrid or a folder of videos to put your own library
on the air.

## Watch it (Windows, macOS or Linux)

You need [Node.js](https://nodejs.org) 22.18 or newer. [ffmpeg](https://ffmpeg.org) is
optional but recommended: it turns on *compatibility mode* for files the browser can't
play as-is (most often AC3/DTS/E-AC3 audio in MKV files).

```powershell
git clone https://github.com/ZacharyThrasher/debridTV
cd debridTV
git checkout claude/debridtv-rnd-9768mu
npm start
```

Then open **http://127.0.0.1:7337** in Chrome or Edge.

- Optional ffmpeg on Windows: `winget install Gyan.FFmpeg`, then open a new terminal.
- Connect a source: press **S** → Sources → paste your key → Connect. Then **Scan now**
  so each file's running time is known (it reads a few KB per file, never whole files).
- Keys and history are stored only on your PC: `%APPDATA%\DebridTV` on Windows,
  `~/.debridtv` elsewhere, or `$DEBRIDTV_HOME`.

| Key | Does |
|---|---|
| ↑ / ↓ (or PgUp / PgDn) | Change channel |
| 0–9 | Go to a channel number |
| G or Enter | Program guide |
| I | What's on now |
| L or Backspace | Last channel |
| Space | Pause (resuming returns to live, like TV) |
| M / F | Mute / full screen |
| S | Settings |

On a phone or tablet: swipe up or down to change channel, tap for info.

### What it costs your provider

Browsing the guide and surfing past channels costs nothing. Watching a program costs
one link request (reused for an hour) plus the video you watch; leaving a channel
cancels its stream at once. Settings → Meters counts every call and byte.

## What exists

| Piece | Where |
|---|---|
| Local server (127.0.0.1 only), metered media proxy, ffmpeg compatibility mode | `app/server.ts` |
| Library: filename parsing, header-only runtime probing (MKV, MP4) | `src/library/`, `app/library.ts` |
| Channel lineup with stable numbers; show, mix, movie, decade and custom channels | `app/lineup.ts` |
| TV front end: tuner, static, breaks, guide, banner, settings | `app/public/` |
| Fictional demo library | `app/demo.ts` |

Research core:

| Piece | Where | Proven by |
|---|---|---|
| Station clock (pure schedule, 3 ordering modes, breaks, slot padding, edits that don't disturb on-air) | `src/clock/` | `test/clock.test.ts`, EXP-001 |
| Watched history separate from the timeline (late joins aren't "watched") | `src/history/` | test D8 |
| Permission gates: `sharing`, `cloud-relay`, `tuner-export` — independent, default closed | `src/gates.ts` | tests |
| Read-only Real-Debrid / TorBox clients with call counters | `src/providers/clients.ts` | experiments |
| Mock providers that meter API calls, 429s, media bytes, open streams | `src/providers/mock-server.ts` | experiments |
| Tuner with cancel / dwell strategies and one-grant-per-file reuse | `src/tuner/` | EXP-002, EXP-003 |

## Research trail

- [Experiment log](docs/experiments/LOG.md) — hypothesis → experiment → result → next.
- [Decisions](docs/decisions/) — ADRs with the evidence behind them.
- [NostalgiaTV parity register](docs/parity/nostalgiatv.md) — 61 rows per surface and version, with a DebridTV status column scored only from tests and the [app audit](docs/parity/audit/app-audit.mjs). Parity is tracked row by row, never declared from the presence of a guide.

## Boundaries (held until the account holder explicitly approves)

Sharing, cloud relaying, tuner/IPTV export and any acquisition (adding torrents,
selecting files) are not built and stay off. A provider key is stored only when you
paste it into Settings on your own PC, and Disconnect deletes it. See the research
handoff §4.

## Develop

Node ≥ 22.18 (runs TypeScript directly).

```sh
npm install        # dev-only: typescript for typecheck
npm test
npm run typecheck
npm run exp:001    # guide cost
npm run exp:002    # channel-surf cost
npm run exp:003    # link-reuse / request amplification
```
