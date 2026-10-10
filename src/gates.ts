// Permission gates (handoff §1.2, §4.3). Each is an independent, explicit grant
// that defaults to off. Nothing in the personal-use core needs any of them; code
// that would share, relay or export must call `require` first, so a missing grant
// fails loudly instead of silently widening the product.

export type Gate = "sharing" | "cloud-relay" | "tuner-export";

export interface GateGrant {
  gate: Gate;
  grantedAt: string; // ISO time
  grantedBy: string; // the account holder, in their own words
  /** What was reviewed before granting, e.g. provider terms version. */
  basis: string;
}

export class GateDeniedError extends Error {
  readonly gate: Gate;
  constructor(gate: Gate) {
    super(`Permission gate "${gate}" has not been granted`);
    this.gate = gate;
  }
}

export class Gates {
  private readonly grants = new Map<Gate, GateGrant>();

  grant(g: GateGrant): void {
    if (!g.grantedBy.trim() || !g.basis.trim())
      throw new Error("a grant needs who granted it and what it was based on");
    this.grants.set(g.gate, g);
  }

  revoke(gate: Gate): void {
    this.grants.delete(gate);
  }

  isGranted(gate: Gate): boolean {
    return this.grants.has(gate);
  }

  require(gate: Gate): GateGrant {
    const g = this.grants.get(gate);
    if (!g) throw new GateDeniedError(gate);
    return g;
  }
}
