# DebridTV

A personal pseudo-live television experience over libraries you authorize, with
Real-Debrid and TorBox as first-class sources. Channels keep a timetable whether or
not anyone is watching; only the channel you actually watch fetches media.

**Status: watchable prototype.** Open it in a browser and channel-surf. With no
account connected it runs demo channels (made-up shows painted in the browser, zero
traffic). Connect TorBox, Real-Debrid or a folder of videos to put your own library
on the air.

## Install on Windows (DebridTV.exe)

1. Download `DebridTV-v0.1.2-win-x64.zip` from
   [Releases](https://github.com/ZacharyThrasher/debridTV/releases) and unzip it anywhere
   (for example `C:\Apps\DebridTV`). Nothing else to install: Node is inside the exe.
2. Double-click **DebridTV.exe**. A small console window opens and your browser opens
   the guide at **http://127.0.0.1:7337**. Keep the window open while you watch; closing
   it turns DebridTV off. Starting it again while it runs just reopens the browser; if an older DebridTV
   (such as `npm start` from a checkout) holds the port, the exe closes it and takes over.
3. The exe isn't code-signed yet, so the first start may show "Windows protected your
   PC". Click **More info → Run anyway**.
4. The exe has no demo channels: until your library is on the air it shows the setup
   steps (connect a source, scan, watch). `npm start` from source still shows the demo.

Your settings, keys, channels and history live in `%APPDATA%\DebridTV`, never next to
the exe. Running from a git checkout (`npm start`) uses the same folder, so switching to
the exe, or replacing it with a newer one, keeps everything. Page files are unpacked once
per version to `%LOCALAPPDATA%\DebridTV\app`.

Compatibility mode sets itself up. The first time DebridTV.exe starts on a PC without
ffmpeg, it downloads the Windows build from gyan.dev in the background (about 110 MB),
checks it against the published SHA-256, and keeps it in `%LOCALAPPDATA%\DebridTV\ffmpeg`.
Settings → Sources shows the progress; reload the page when it says ready. Nothing else
on the PC changes. An ffmpeg already on your PATH, or `ffmpeg.exe` and `ffprobe.exe` next
to `DebridTV.exe`, is used instead. Set `DEBRIDTV_NO_FFMPEG_DOWNLOAD=1` to skip it.

On Windows the guide opens in its own window, which uses Edge's engine so Dolby Digital sound plays without conversion. Options: `DebridTV.exe --browser` to use your default browser instead, `DebridTV.exe --no-browser`, and `set PORT=7340` before starting to change the port.

Releases are made by the **Release** workflow (Actions → Release → Run workflow): it
builds the exe, starts it on a real Windows machine (including the ffmpeg download),
and only then creates the GitHub release. Build it yourself with `npm ci && npm run build:exe` (needs `zip` and `unzip`; builds on
Linux, macOS or Windows with Git Bash). Output lands in `dist/`.

## Run from source (Windows, macOS or Linux)

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
| ← / → | Skip back 10 s / ahead 30 s, on any channel |
| [ / ] (or Shift+← / →) | Previous / next program |
| L or Backspace | Back to live after skipping; otherwise last channel |
| Space | Pause (resuming plays on from where you paused) |
| M / F | Mute / full screen |
| S | Settings |

On a phone or tablet: swipe up or down to change channel, tap for info.

There are no station breaks unless you turn them on (Settings → Look & feel →
Station breaks): shows play back to back. See ADR-0006.

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

- [PC checks runbook](docs/runbooks/pc-checks.md): the checks only your PC can run.
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
