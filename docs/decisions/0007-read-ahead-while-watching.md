# ADR-0007 — Read about a minute ahead of the show being watched

**Status:** accepted (2026-10-12). Zachary chose "Buffer current show" on the decision
card, over fetching minutes of the next show. **Evidence:** EXP-012.

## Context

The server used to pipe the host's bytes to the player at the player's pace, so how far
ahead a show was held was up to the browser. EXP-012 measured Chromium holding about 30 s
of a 6 Mb/s file past the picture. A provider that went quiet for 60 s froze the picture
for 27 s.

## Decision

- Once a file has been streaming to the viewer for 10 s (counted per file, because the
  browser reopens its range request now and then), the server keeps reading from the host up to about
  60 s of the file (by its average bitrate) past what the player has taken, never less
  than 8 MiB or more than 128 MiB, and hands it over as the player asks. Before those
  10 s it is a plain pipe, so surfing costs what it did (EXP-002).
- Nothing here opens a request: it only reads further on a stream the player already
  opened. The player dropping the stream (channel change, seek, pause long enough for the
  browser to close it, stop) discards the reserve at once.
- Meters shows the most held at once, and the bytes read but never played because the
  viewer left.

## Consequences

- A 60 s provider stall no longer freezes the picture in EXP-012 (27 s frozen → 0).
- Leaving a show can waste up to about a minute of it (45 MB at 6 Mb/s, at most 128 MiB),
  shown in Meters. Memory: the reserve is held in RAM per open stream.
- Not yet measured on a real provider, on Chrome for Windows, or with the compatibility
  (ffmpeg) path, which reads through the same proxy and so gets the same reserve.
