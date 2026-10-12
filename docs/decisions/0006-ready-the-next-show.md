# ADR-0006 — Ready the next show on the channel being watched

**Status:** accepted (2026-10-12). Asked for by Zachary ("pre-load the upcoming show
while the prior show is playing so it feels instant"). **Amends ADR-0003**, whose edge
cache was filled only from bytes already on their way to a viewer. **Evidence:** EXP-011.

## Context

At a program boundary the player opens the next file cold: one API call for its link
(LIVE-001 TorBox: ~370 ms), then the browser's header, index and start reads, each
paying the media host's time to first byte (~200 ms). The viewer sees static for that
time at every boundary, while sitting still on a channel, which is when a wait feels
worst. ADR-0003's edge cache only helps files that were tuned before.

## Decision

Late in a program, the player on the channel being watched asks the server to ready
the next program: resolve (or reuse) its link and fetch the two ends the edge cache
keeps, the first 1 MiB and the last 256 KiB. The tune at the boundary is then answered
from this PC, and only the bytes after the first MiB come from the host.

Narrow by design:

- **Only the next program on the channel on screen, only on the device watching it.**
  Never for the guide, the guide preview, surfing, other channels, On Demand, or a
  time-shifted position.
- **Only once the viewer has settled:** 10 s on the channel, and from 60 s before the
  next program starts. Surfing past a channel costs nothing, as before.
- **Never for** local or demo files (nothing to gain), locked items (403 as everywhere),
  a copy a provider refused or couldn't serve, or a file whose account or state the
  player wouldn't play. Nothing is retried: a refused link or odd answer just stops it,
  and the real tune re-resolves on its own (ADR-0002). A refusal met while readying is
  recorded exactly as a refusal met while watching (ADR-0005 still holds).
- **Cancelled at once** by a channel change, pause, seek, On Demand or sign-off: the
  player drops the request and the server aborts the host fetch.
- **Counted apart.** Meters shows `preload` bytes separately from watched, scan and
  cached bytes, the API calls it made, and how many pre-loads were played versus
  wasted (nobody played the file within 15 minutes).
- **Off switch:** Settings › "Get the next show ready" (pref `preloadNext`, on by default).

## Consequences

- Cost per boundary: about 1.3 MB and at most one API call (the link the tune would
  have asked for anyway). When the viewer tunes away first, those bytes are wasted and
  shown as such. Bounded by the existing 256 MiB edge-cache limit.
- The "never retrieve unwatched media" goal now has one explicit, measured exception:
  the opening second or so of the program the viewer is about to see on the channel
  they are watching.
- Contract with the seeking work: `cancelPreload()` on entering a shifted position;
  `planPreload()` is only called for live tunes.
- Not yet measured on a real provider or with H.264/HEVC MKVs from Chrome on Windows.
