# ADR-0004: Transcode cap, and why there is no audio passthrough

Status: accepted (2026-10-11), parity N-19.

## Context

NostalgiaTV-style players offer three things that sit under "N-19":

1. Direct play whenever possible.
2. A cap on transcode resolution, for machines that can't convert 4K in real time.
3. Passthrough: sending Dolby Digital (AC-3), E-AC-3, DTS or TrueHD to an AV
   receiver untouched, so the receiver decodes surround sound.

DebridTV already does (1). It plays the file directly when the browser can
decode it (A20), and it falls back to compatibility mode (ffmpeg) only for what
the browser can't decode (A24).

## Decision

**Transcode cap.** The player sends `&maxh=720` or `&maxh=1080` on compatibility
streams when the pref `compatMaxHeight` is set. The server applies it only when
it is already converting the picture. A copied picture is never scaled, since
copying costs nothing. Unset keeps the current behaviour, up to 1080 lines.
The server side and the settings control belong to workstream C.

**No passthrough.** A web page can't bitstream audio. Browsers decode every
track to PCM before it reaches the operating system. No web API sends an
encoded AC-3 or DTS stream to HDMI or S/PDIF, and `<video>` can't do it either.
Compatibility mode therefore converts surround tracks to stereo AAC (or Opus
where the browser has no AAC). Surround sound on a receiver needs a native
player, which is out of scope for a browser app.

## Consequences

- Weak PCs can pick 720p and keep real-time conversion for 4K or HEVC files.
- Viewers with receivers get stereo from compatibility mode. Files whose audio
  the browser decodes natively (AAC 5.1, Opus, FLAC) play directly, and the
  browser downmixes or outputs multichannel PCM as the operating system allows.
- The parity register should mark passthrough "won't do (platform)", not a gap.
