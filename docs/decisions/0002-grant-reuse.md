# ADR-0002 — One playback grant per file; players never see redirecting API URLs

**Status:** accepted (2026-10-10) · **Evidence:** EXP-003, EXP-002

## Decision
- The tuner resolves a provider link once (`GrantCache`) and hands the player the resolved URL.
- Concurrent requests for the same file share one in-flight resolve.
- Grants without a stated expiry use a fallback TTL of 60 min (was 10 min; raised after LIVE-001 observed a TorBox link still valid at 120 min).
- On 403/404 from the media host: invalidate and re-resolve **once**; a second failure is an error state, not a loop.
- Superseded tunes abort both the resolve and the media fetch; a new media fetch waits until the previous session has released its connection.
- Provider clients are read-only. Add/select/delete (acquisition) is out of scope until separately approved (gate B5).

## Consequences
In the mock: 400 range reads cost 1 API call instead of 400, and surfing never holds more than one stream client-side.
Live behaviour (link lifetimes, range support, connection limits) is untested.
