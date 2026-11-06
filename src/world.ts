// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// World ID gate, backend side.
// For a LARGE proposal the agent may only sign after its owner passes a
// fresh World ID check tied to that exact proposal: its id (the action)
// and its fingerprint (the IDKit signal).
//
// Flow (World ID 4.0, IDKit 4.x, verified 2026-11-06 against docs.world.org):
//   1. The server signs the proof request for one action with the RP
//      signing key (`signRequest` from @worldcoin/idkit-core/signing).
//      The key never leaves the server.
//   2. The owner scans the IDKit QR in World App (public/assets/world-flow.js).
//   3. The server forwards the IDKit result as-is to
//      POST https://developer.world.org/api/v4/verify/{rp_id}, with the
//      environment pinned from server config so a client cannot pick
//      "staging" or "sandbox" (which accept test proofs).
//   4. The approval is stored server-side and spent once, keyed on
//      action + nullifier. A client-supplied "approved" object is never
//      accepted as authorization.
// This is the same pattern World documents for human-in-the-loop agent
// approvals (docs.world.org/agents/human-in-the-loop/integrate).
//
// Demo mode: with no World credentials, explicitly mocked approvals are
// accepted on testnet only, and are labelled MOCKED everywhere.

import { sha256 } from "./auditlog.js";
import { hashSignal } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";

export type WorldEnvironment = "production" | "staging" | "sandbox";

export interface WorldConfig {
  rpId: string;
  appId: string;
  signingKey: string;
  environment: WorldEnvironment;
}

export function loadWorldConfig(env: NodeJS.ProcessEnv): WorldConfig {
  const e = (env.WORLD_ENVIRONMENT ?? "production").trim();
  if (e !== "production" && e !== "staging" && e !== "sandbox") {
    throw new Error(`WORLD_ENVIRONMENT must be production, staging or sandbox, got "${e}"`);
  }
  return {
    rpId: (env.WORLD_RP_ID ?? "").trim(),
    appId: (env.WORLD_APP_ID ?? "").trim(),
    signingKey: (env.WORLD_SIGNING_KEY ?? "").trim(),
    environment: e,
  };
}

export function isWorldConfigured(config: WorldConfig): boolean {
  return Boolean(config.rpId && config.appId && config.signingKey);
}

// Mocked approvals carry no proof of a real human, so they are only
// accepted when World is not configured, and never on mainnet.
export function mockedAllowed(config: WorldConfig, hederaNetwork: string): boolean {
  return !isWorldConfigured(config) && hederaNetwork !== "mainnet";
}

export const JOIN_ACTION = "join-council";

// A World ID nullifier is per (person, app, action), so revoking must be proven under the join
// action for its nullifier to match a seat. The signal tells the two intents apart: a join proof
// cannot be replayed as a revocation, and a revocation names the seat it targets.
export const JOIN_SIGNAL = "council-join";
export function revokeSignal(seat: string): string {
  return `council-revoke:${seat}`;
}

export function councilSignAction(proposalId: string): string {
  return `council-sign:${proposalId}`;
}

// IDKit signal for one proposal: binds the proof to the exact transfer
// bytes, not just the proposal id.
export function proposalSignal(fingerprint: string): string {
  return `council-proposal:${sha256(fingerprint)}`;
}

// Signal hashes arrive as 0x-hex; compare as numbers so case and
// leading zeros do not matter.
function sameHash(a: unknown, b: string): boolean {
  if (typeof a !== "string" || a.length === 0 || a.length > 80) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

export function rpContextFor(config: WorldConfig, action: string): RpContext {
  const s = signRequest({ signingKeyHex: config.signingKey, action, ttl: 300 });
  return { rp_id: config.rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig };
}

// Nullifiers arrive as decimal or 0x-hex strings; parse like the verifier
// does so "0x01" and "1" are the same person.
export function normalizeNullifier(n: unknown): string | null {
  if (typeof n !== "string" || n.length === 0 || n.length > 80) return null;
  try {
    const v = BigInt(n);
    return v < 0n ? null : v.toString(16);
  } catch {
    return null;
  }
}

export interface VerifiedProof {
  ok: boolean;
  nullifier: string | null;
  detail: string;
}

interface VerifyResponse {
  success?: boolean;
  action?: string;
  environment?: string;
  nullifier?: string;
  code?: string;
  detail?: string;
  results?: Array<{ success?: boolean; nullifier?: string; code?: string; detail?: string }>;
}

// Verify an IDKit result for one exact action. Never throws for a bad
// proof (returns ok:false); network failures do throw, and callers treat
// a throw as "does not sign".
export async function verifyWorldProof(
  config: WorldConfig,
  idkitResult: Record<string, unknown>,
  expectedAction: string,
  fetchImpl: typeof fetch = fetch,
  expectedSignal?: string,
): Promise<VerifiedProof> {
  if (idkitResult.action !== expectedAction) {
    return { ok: false, nullifier: null, detail: `Proof is for action "${String(idkitResult.action)}", expected "${expectedAction}".` };
  }
  if (expectedSignal !== undefined) {
    const want = hashSignal(expectedSignal);
    const rs = idkitResult.responses;
    if (!Array.isArray(rs) || rs.length === 0 || !rs.every((r) => sameHash((r as { signal_hash?: unknown })?.signal_hash, want))) {
      return { ok: false, nullifier: null, detail: "Proof was not made for this exact request (signal mismatch). The agent does not act on it." };
    }
  }
  const res = await fetchImpl(`https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...idkitResult, environment: config.environment }),
    signal: AbortSignal.timeout(10_000),
  });
  const v = (await res.json().catch(() => null)) as VerifyResponse | null;
  const resultsOk =
    Array.isArray(v?.results) && v.results.length > 0 && v.results.every((r) => r.success !== false);
  const ok =
    res.ok &&
    v?.success === true &&
    resultsOk &&
    (v.action === undefined || v.action === expectedAction) &&
    (v.environment === undefined || v.environment === config.environment);
  const responses = idkitResult.responses as Array<{ nullifier?: string }> | undefined;
  const nullifier = normalizeNullifier(v?.nullifier ?? v?.results?.[0]?.nullifier ?? responses?.[0]?.nullifier);
  if (ok && !nullifier) {
    return { ok: false, nullifier: null, detail: "World verified the proof but no nullifier was found." };
  }
  return {
    ok,
    nullifier,
    detail: ok ? "World ID proof verified by developer.world.org." : `World ID verify failed (${res.status}): ${v?.code ?? ""} ${v?.detail ?? v?.results?.[0]?.detail ?? ""}`.trim(),
  };
}

export interface WorldCheck {
  proposalId: string;
  status: "approved" | "denied" | "expired" | "cancelled";
  verifiedAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp
  source: "world" | "mocked";
  // Backend validation result, when a real verifier ran.
  backendValidated?: boolean;
}

export interface WorldGateResult {
  allowed: boolean;
  reason: string;
}

export function worldGate(check: WorldCheck | null, proposalId: string, now = new Date()): WorldGateResult {
  if (!check) {
    return { allowed: false, reason: "No World ID check was presented for this large proposal." };
  }
  if (check.proposalId !== proposalId) {
    return { allowed: false, reason: `World ID check was for proposal ${check.proposalId}, not ${proposalId}.` };
  }
  if (check.status !== "approved") {
    return { allowed: false, reason: `World ID check was ${check.status}, not approved. The agent does not sign.` };
  }
  if (new Date(check.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "World ID check has expired. The agent does not sign." };
  }
  if (check.source === "world" && check.backendValidated !== true) {
    return { allowed: false, reason: "World ID proof failed backend validation. The agent does not sign." };
  }
  return {
    allowed: true,
    reason:
      check.source === "mocked"
        ? "World ID check approved (MOCKED proof, demo only)."
        : "World ID check approved and backend-validated for this exact proposal.",
  };
}

export const APPROVAL_TTL_MINUTES = 5;

export function verifiedWorldCheck(proposalId: string, now = new Date()): WorldCheck {
  return {
    proposalId,
    status: "approved",
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000).toISOString(),
    source: "world",
    backendValidated: true,
  };
}

// Demo helper: build a mocked check. Only for the demo rehearsal, never
// presented as a real World verification.
export function mockedWorldCheck(
  proposalId: string,
  status: WorldCheck["status"],
  minutesValid = APPROVAL_TTL_MINUTES,
): WorldCheck {
  const now = new Date();
  return {
    proposalId,
    status,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutesValid * 60_000).toISOString(),
    source: "mocked",
    backendValidated: false,
  };
}

// Server-held approvals, one per proposal. Only the server writes here,
// after it has verified a proof (or accepted a labelled mock in demo mode).
export class ApprovalStore {
  private approvals = new Map<string, WorldCheck>();

  set(check: WorldCheck): void {
    this.approvals.set(check.proposalId, check);
  }

  get(proposalId: string, now = new Date()): WorldCheck | null {
    const c = this.approvals.get(proposalId);
    if (!c) return null;
    if (new Date(c.expiresAt).getTime() <= now.getTime()) {
      this.approvals.delete(proposalId);
      return null;
    }
    return c;
  }

  delete(proposalId: string): void {
    this.approvals.delete(proposalId);
  }
}
