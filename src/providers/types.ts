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

export function classify(status: number, body: string): ProviderError {
  if (status === 429) return new ProviderError("rate-limited", status, body);
  if (status === 401 || status === 403) return new ProviderError("auth", status, body);
  if (status === 404) return new ProviderError("not-found", status, body);
  if (status === 451) return new ProviderError("policy", status, body);
  if (status >= 500) return new ProviderError("transient", status, body);
  return new ProviderError("unknown", status, body);
}
