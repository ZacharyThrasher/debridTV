// Core vocabulary. "Listed", "cached", "playable" and "scheduled" are kept as
// separate facts on purpose (handoff §5.4): an item can be on the schedule while
// its file is currently unavailable, and the timeline must not move because of it.

export type ProviderId = "realdebrid" | "torbox" | "local";

/** What the provider last told us about the file. Never feeds the schedule. */
export type Availability =
  | "unknown" // never checked
  | "listed" // present in the account inventory
  | "cached" // provider says ready without acquisition
  | "playable" // a playback grant was obtained recently
  | "unavailable" // missing, expired or failing; with a reason elsewhere
  | "policy-blocked"; // rights/policy denial: never auto-repaired

export interface MediaItem {
  /** Stable DebridTV identity for this file/edition (not a provider id). */
  id: string;
  title: string;
  showId?: string;
  season?: number;
  episode?: number;
  /** Exact file duration. null = unknown, which makes the item unschedulable. */
  durationMs: number | null;
  /** Trusted mid-program break points in file time (chapters/user markers). */
  breakpointsMs?: number[];
  rating?: string;
  source: { provider: ProviderId; ref: string };
}

export type Ordering =
  | "cyclic"
  | "shuffle"
  | "block-shuffle"
  | "block-cyclic"
  | "marathon-shuffle"
  | "marathon-cyclic"
  | "round-robin-shuffle"
  | "round-robin-cyclic";

export interface ChannelRevision {
  /** UTC ms. Each revision's timeline is anchored here. */
  effectiveFromMs: number;
  seed: string;
  itemIds: string[];
  ordering: Ordering;
  /** If set, each airing is padded with a break up to a multiple of this. */
  slotMs?: number;
  /** Length of each mid-program break inserted at a trusted breakpoint. */
  midBreakMs?: number;
}

export interface Channel {
  id: string;
  number: number;
  name: string;
  /** Sorted ascending by effectiveFromMs. */
  revisions: ChannelRevision[];
}

export type Segment =
  | {
      kind: "program";
      itemId: string;
      startMs: number;
      endMs: number;
      /** File position at startMs. */
      fileFromMs: number;
    }
  | {
      kind: "break";
      startMs: number;
      endMs: number;
      reason: "mid" | "padding";
    };

export interface Airing {
  channelId: string;
  itemId: string;
  startMs: number;
  endMs: number;
  segments: Segment[];
  /** Cut short because a later revision starts before the airing ends. */
  truncated: boolean;
}

export interface TuneTarget {
  airing: Airing;
  segment: Segment;
  offsetInSegmentMs: number;
  /** Set when the segment is program material: where the player should seek. */
  fileOffsetMs: number | null;
}
