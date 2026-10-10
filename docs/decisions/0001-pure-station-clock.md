# ADR-0001 — The station timeline is a pure function, never a provider query

**Status:** accepted (2026-10-10) · **Evidence:** EXP-001, `test/clock.test.ts`

## Context
The product must keep every channel "live" without retrieving unwatched media
(handoff §1.1, gates B1/B2/C1/C6). Availability is volatile; the timeline must not be.

## Decision
`StationClock` computes what airs at time *t* from channel config, exact file
durations and a seed. It never calls a provider. Availability (`listed`, `cached`,
`playable`, `unavailable`, `policy-blocked`) is stored next to items but **does not
feed scheduling**; an unavailable item keeps its slot and shows an honest
"unavailable" state instead of shifting the evening.

Items with unknown duration are excluded with a reason rather than guessed (D6).
Edits create a new revision effective at the end of the current airing (C7).

## Consequences
+ Guide browsing and regeneration cost 0 API calls and 0 bytes.
+ Any device with the same config computes the same lineup; no sync of schedules needed, only of config.
− Exact durations are required up front; acquiring them cheaply for debrid-only items is now the main metadata problem (handoff §6).
− Slots are UTC-anchored today; local-time grids across DST are an open decision (C5).
