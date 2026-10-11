# ADR-0005: When one provider refuses a title, another source's copy may air

Status: accepted (2026-10-11), parity N-01d. Decided by Zachary ("Play other copy").
Supersedes the round-5 rule that a refused copy kept the whole title off the air.

## Context

The same episode or film can sit in several places: this PC, TorBox and
Real-Debrid. N-01d keeps one copy per title. A provider can refuse a file,
for example Real-Debrid's `infringing_file` (LIVE-001). Round 5 made one refused
copy keep the whole title off the air and out of On Demand. Before round 5, the
other provider's copy aired without any note.

## Decision

- **The refused copy is final.** It never airs, its link is never requested
  again, and `/media` 409/451/403 stay final for it. The probe still never
  "fixes" a refusal by asking another provider for that file (gate E6).
- **Another source's copy of the title may air.** `dedupeGroups` never keeps a
  refused copy (`airable`), so the next copy by rank airs: local, then known
  playable, then TorBox, then Real-Debrid. On Demand offers the same copy.
- **The viewer is told.** The info banner shows a small badge, for example
  "Real-Debrid refused its copy". The Library row says the same next to
  "Also in …". A title that only the refusing provider has stays off the air.

## Consequences

- No request is made to find a replacement. The other copy was already in the
  library, from the user's own account.
- A custom channel or group that picked the refused copy gets the copy that airs.
- Tests: `library.test` "N-01d/E6: a refused copy never airs, another source's
  copy airs instead".
