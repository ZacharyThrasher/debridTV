# ADR-0008: DebridTV's own window on Windows, with mpv playing the video

Status: accepted (2026-10-12). Amends ADR-0004 for the PC app window.

## Context

In Firefox and Chrome, Dolby Digital, DTS and TrueHD sound can't be decoded, so
those files went through compatibility mode (ffmpeg converting live), which was
the source of "no sound" and choppy sound reports. Edge decodes Dolby Digital on
most PCs but not DTS or TrueHD, and the viewer had to remember to use it.

Options weighed (see /mnt/project-files/debridTV/research/native-app-options.md):
an Edge app window, a WebView2 shell, Electron (no AC-3/DTS at all), a WebView2
shell with mpv under the page, and a fully native UI (a rewrite of every screen).

## Decision

DebridTV.exe opens its own window (`desktop/`, Rust: tao + wry). The window has
two layers: mpv draws the picture in a native child window at the bottom, and the
page sits on top in WebView2 with a see-through background. This is the layout
Stremio's Windows app uses.

- **The page doesn't change.** `app/public/js/native-video.js` stands in for the
  `#video` element: it answers `src`, `currentTime`, `play()`, `buffered`, events
  and so on from mpv's JSON IPC, so player.js, controls, captions and Lean-back
  drive mpv as they drive a `<video>`. In a browser it does nothing.
- **Compatibility URLs become direct plays.** A `/media/:id/live?start=&a=&s=&ad=`
  URL is played as the file itself from `start`, with those tracks (matched by
  FFmpeg stream index) and that sound delay. A seek in the same file is a seek, not
  a reopen. Phones, TVs and browsers keep compatibility mode as before.
- **mpv is a separate process**, started with `--wid` and a named pipe, tied to the
  window by a job object. A player crash can't take the window down.
- **mpv isn't shipped.** The first start downloads the mpv project's official
  Windows build (v0.41.0, pinned SHA-256) into `%LOCALAPPDATA%\DebridTV\mpv`, like
  ffmpeg. Until it's there, the window plays video the way Edge does. mpv is
  GPL-2.0+; DebridTV runs it unchanged as a separate program and never
  redistributes it, so DebridTV's own license is unaffected. THIRD-PARTY.txt says
  where its source is and that it can be swapped.
- **Fallbacks:** no mpv → WebView2 plays video itself; no WebView2 → an Edge app
  window (`--edge`); no Edge → the default browser (`--browser`).

## Consequences

- Every format plays as-is on the PC, with hardware decoding and HDR tone mapping.
- Passthrough to a receiver becomes possible in the window (mpv `--audio-spdif`);
  ADR-0004's "won't do" now applies to browsers only. Not exposed as a setting yet
  (`DEBRIDTV_MPV_ARGS` can pass it for testing).
- Text captions drawn by the page (live subtitles) aren't needed in the window:
  mpv draws the chosen subtitle track itself, including picture subtitles.
- Windows-only for now. macOS/Linux could reuse the same page shim with a host
  that embeds mpv the same way.
