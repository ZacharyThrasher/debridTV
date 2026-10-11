// Core vocabulary. "Listed", "cached", "playable" and "scheduled" are kept as
// separate facts on purpose (handoff §5.4): an item can be on the schedule while
// its file is currently unavailable, and the timeline must not move because of it.

import type { Dayparts } from "./dayparts.ts";
import type { Rating } from "./ratings.ts";

export type ProviderId = "realdebrid" | "torbox" | "local" | "demo";

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
  /** Nothing rated above this airs on the channel at all (kid channels). Unrated items never pass. */
  maxRating?: Rating;
  /** Wall-clock rules: restricted hours and weekday time slots (see dayparts.ts). */
  dayparts?: Dayparts;
  /** Show weights, airtime balance, premieres and marathons (see WindowPlan in schedule.ts). */
  mix?: MixRules;
}

/**
 * Instead of a fixed cycle, each next program comes from the show that is most
 * behind its share: share = weight, "behind" = turns (or airtime) so far ÷ weight.
 * Programs without a show count as one group, "films".
 */
export interface MixRules {
  /** Group (show id, or "films") → weight 0–100; missing = 50; 0 = never. */
  weights?: Record<string, number>;
  /** Balance by turns taken (default) or by airtime. */
  balance?: "count" | "duration";
  /** Chance per pick (0–1) of staying on the picked show for up to maxMs. */
  marathon?: { chance: number; maxMs: number };
  /** Items to air first, once, with their show's weight tripled until they have. */
  premieres?: string[];
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
