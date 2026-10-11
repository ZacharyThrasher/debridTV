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

export class ProviderError extends Error {
  readonly kind: "rate-limited" | "auth" | "not-found" | "policy" | "transient" | "unknown";
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
}

// Provider error codes that change what we may do next. A policy denial is not a
// transport failure: it is never retried, and never "repaired" by trying another
// provider or account (handoff §5.4, gate E6). Codes from R02; LIVE-001 observed
// RD 35 on a file the inventory listed as "downloaded".
const RD_CODES: Record<number, ProviderError["kind"]> = {
  8: "auth", // bad_token
  9: "auth", // permission_denied
  34: "rate-limited", // too_many_requests
  35: "policy", // infringing_file
};
const TB_ERRORS: Record<string, ProviderError["kind"]> = {
  AUTH_ERROR: "auth",
  BAD_TOKEN: "auth",
  NOT_FOUND: "not-found",
};

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
