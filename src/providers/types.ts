import type { ProviderId } from "../clock/types.ts";

export interface InventoryFile {
  provider: ProviderId;
  /** Provider-side reference sufficient to request playback later. */
  ref: string;
  name: string;
  bytes: number;
  /** Provider's own readiness wording, kept verbatim for honest UI. */
  providerState: string;
}

export interface PlaybackGrant {
  url: string;
  /** null when the provider did not say; callers then use a conservative TTL. */
  expiresAtMs: number | null;
  obtainedAtMs: number;
}

/** Plan facts only. No username, email or account id is kept. */
export interface AccountInfo {
  plan: string | null;
  /** When paid access ends; null if the provider didn't say. */
  premiumUntilMs: number | null;
  /** False once the paid period is over (links then stop working). */
  premium: boolean;
  checkedAtMs: number;
}

export class ProviderError extends Error {
  readonly kind: "rate-limited" | "auth" | "account" | "gone" | "not-found" | "not-ready" | "policy" | "transient" | "unknown";
  readonly status: number;
  constructor(kind: ProviderError["kind"], status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Read-only surface. Account-mutating calls (add, select, delete) are deliberately
 * absent: acquisition is a separate product scope (handoff §1.3, gate B5).
 */
export interface ProviderClient {
  readonly id: ProviderId;
  inventory(signal?: AbortSignal): Promise<InventoryFile[]>;
  resolve(ref: string, signal?: AbortSignal): Promise<PlaybackGrant>;
  account(signal?: AbortSignal): Promise<AccountInfo>;
}

/**
 * Whether the provider says a file is finished and stored, in its own words.
 * Anything else is "not ready": DebridTV never asks the provider to fetch it (gate B5).
 */
export function providerReady(provider: ProviderId, state: string): boolean {
  if (provider === "realdebrid") return state === "downloaded";
  if (provider === "torbox") return state === "download_finished";
  return true;
}

// Provider error codes that change what we may do next. A policy denial is not a
// transport failure: it is never retried, and never "repaired" by trying another
// provider or account (handoff §5.4, gate E6). Codes from R02; LIVE-001 observed
// RD 35 on a file the inventory listed as "downloaded".
const RD_CODES: Record<number, ProviderError["kind"]> = {
  8: "auth", // bad_token
  // RD documents 403 permission_denied as "account locked, not premium": the account,
  // not the key, so signing in again changes nothing (measured by Debrid Media Manager).
  9: "account", // permission_denied
  14: "account", // account_locked
  24: "gone", // unavailable_file: RD no longer has the file, for anyone
  34: "rate-limited", // too_many_requests
  20: "not-found", // unknown_ressource
  35: "policy", // infringing_file
};
const TB_ERRORS: Record<string, ProviderError["kind"]> = {
  AUTH_ERROR: "auth",
  BAD_TOKEN: "auth",
  NOT_FOUND: "not-found",
  TOO_MANY_REQUESTS: "rate-limited",
  DOWNLOAD_NOT_READY: "not-ready",
  PLAN_RESTRICTED_FEATURE: "account", // the plan has no API access
};

/**
 * Release tags Real-Debrid refuses to stream (`451 infringing_file` on
 * /unrestrict/link), matched anywhere in a file's own name, in any case. Only the
 * exact dot or hyphen counts: WEB.DL, WEBDL and BluRay-x264 stream. Measured by
 * Debrid Media Manager on 2026-10-10 over 214 adds and 22 link requests on a
 * clean test account (their deInfringe.ts; facts only, no code copied). RD changed
 * this list during October 2026, so a match is a prediction: the file is skipped
 * without asking, and "Check now" can still ask once.
 */
const RD_REFUSED_TAG = /web-dl|(?:web|bd|hd|dvd)rip|bluray\.x264|p\.bluray\.dts|hdtv\.(?:x264|xvid)|web\.(?:x264|h264)/i;

/** The tag in this file's own name (not its folders) that Real-Debrid refuses, or null. */
export function rdRefusedTag(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = RD_REFUSED_TAG.exec(base);
  if (!m) return null;
  // "1080p.BluRay.DTS" matches from the "p"; show the tag itself.
  return m[0].replace(/^p\./i, "");
}

export function classify(status: number, body: string): ProviderError {
  let parsed: { error_code?: unknown; error?: unknown } = {};
  try {
    const j: unknown = JSON.parse(body);
    if (j && typeof j === "object") parsed = j;
  } catch {}
  const byCode =
    (typeof parsed.error_code === "number" && RD_CODES[parsed.error_code]) ||
    (typeof parsed.error === "string" && TB_ERRORS[parsed.error]);
  if (byCode) return new ProviderError(byCode, status, body);
  if (status === 429) return new ProviderError("rate-limited", status, body);
  if (status === 401 || status === 403) return new ProviderError("auth", status, body);
  if (status === 404) return new ProviderError("not-found", status, body);
  if (status === 451) return new ProviderError("policy", status, body);
  if (status >= 500) return new ProviderError("transient", status, body);
  return new ProviderError("unknown", status, body);
}
