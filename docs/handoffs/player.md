# Handoff: the player (control bar and feature set)

Owner thread: "Full-featured video player" (2026-10-12). Register: docs/parity/player.md.

## Files
- `app/public/js/controls.js` — the YouTube-style bar (replaces the old #dock), settings menu, shortcut sheet, keys, touch. Reads `player.timeline()`, calls `seekTo/seekBy/skipProgram/backToLive` (ADR-0006, owned by the seeking work), `setRate`, `pickAudio`.
- `app/public/js/avfx.js` — Web Audio (boost to 200%, sound-later delay, night mode, bass/treble; the graph is only built once one of them is used), picture (zoom, rotate, mirror, brightness/contrast/colour as CSS), subtitle delay (shifts every text cue on the video), loaded subtitle files, frame step, screenshot, A–B loop, stats.
- `app/public/js/subfile.js` — SRT/WebVTT parser (pure; test/subfile.test.ts).
- `app/public/player.css` — all bar styling, on `--pb-*` tokens that fall back to the redesign's tokens.css names.
- `player.js` "control bar" section — `setRate/speedOk/currentRate`, `playing()`, `pickAudio()`, `reapplyAudioShift()`, `demoCanvas()`.
- Server: `/media/:id/live?ad=<ms>` (±10000) shifts the sound in compatibility mode (`adelay` / `atrim`). Sound earlier than the picture needs it; later is a browser delay.

## Contracts
- Captions: `import("./captions.js")` is optional. When it exports `openCaptions()` and `captionsState()` the CC button uses them; otherwise CC cycles tracks.
- Prefs: volume, boost, muted, nightMode, bassDb, trebleDb, audioDelayMs, subDelayMs, picture {zoom, rotate, flip, brightness, contrast, saturation}, aspect.
- Keys owned by the bar (capture phase, after spatial.js): , . < > / * P X D ? M F Home End(On Demand) Shift+←/→ (chapters, falls through to skipProgram), Down (onto the bar when it was shown by a key).

## Known limits / next
- Pan while zoomed isn't built. Deinterlace isn't built (compat `yadif` if a real file needs it).
- Picture subtitles (PGS) are burned in on the PC and can't be delayed.
- Scrubbing thumbnails won't be built (they'd fetch unwatched media).
