# DebridTV

A personal pseudo-live television experience over libraries you authorize, with
Real-Debrid and TorBox as first-class sources. Channels keep a timetable whether or
not anyone is watching; only the channel you actually watch fetches media.

**Status: research prototype.** Core scheduling and measurement code only — no UI,
and nothing has been run against a real provider account yet.

## What exists

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
- [NostalgiaTV parity register](docs/parity/nostalgiatv.md) — per surface and version, with a DebridTV status column. Parity is tracked row by row, never declared from the presence of a guide.

## Boundaries (held until the account holder explicitly approves)

Real account access, credential storage, sharing, cloud relaying, tuner/IPTV export,
and any acquisition (adding torrents, selecting files). See the research handoff §4.

## Run

Node ≥ 22.18 (runs TypeScript directly).

```sh
npm install        # dev-only: typescript for typecheck
npm test
npm run typecheck
npm run exp:001    # guide cost
npm run exp:002    # channel-surf cost
npm run exp:003    # link-reuse / request amplification
```
