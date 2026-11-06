// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// The challenge window and the re-check at execution. A proposal that passes
// every check is not signed straight away: it waits out CHALLENGE_WINDOW_SECONDS,
// during which anyone with the API key can challenge it. Execution then
// re-runs the checks from scratch, because the world can change inside the
// window: a payee gets revoked, a World ID approval expires, a seat is revoked.

import { checkProposal } from "./checker.js";
import type { PayeeRegistry } from "./payee.js";
import { isLargeProposal, type Proposal } from "./proposal.js";
import { worldGate, type WorldCheck } from "./world.js";

export interface RecheckInput {
  proposal: Proposal;
  payees?: PayeeRegistry;
  largeThresholdTinybars: number;
  // The server-held approval as of `now`, or null if none is left.
  approval: WorldCheck | null;
  challengeUntil: string;
  challenged: boolean;
  challengeReason?: string | null;
  createdEpoch: number;
  currentEpoch: number;
  now: Date;
  // Set when a council vote or the adopted standing instruction is the human
  // approval: the per-payment World ID check does not apply.
  approvedBy?: string | null;
  // A council vote approved a recipient not in the registry; revoked or expired entries still abort.
  allowUnregistered?: boolean;
}

export type Recheck =
  | { status: "ok"; payeeStatus: string; worldReason: string | null; large: boolean }
  | { status: "too-early"; secondsRemaining: number; reason: string }
  | { status: "challenged"; reason: string }
  | { status: "aborted"; reason: string };

export const EXPIRED_IN_WINDOW = "World ID approval expired during the challenge window";

// Pure: no I/O and no clock of its own (`now` is a parameter).
export function recheckAtExecution(i: RecheckInput): Recheck {
  if (i.challenged) {
    return { status: "challenged", reason: `Proposal ${i.proposal.id} is challenged${i.challengeReason ? `: ${i.challengeReason}` : ""}. Resume it before executing.` };
  }
  const waitMs = Date.parse(i.challengeUntil) - i.now.getTime();
  if (waitMs > 0) {
    const secondsRemaining = Math.ceil(waitMs / 1000);
    return { status: "too-early", secondsRemaining, reason: `The challenge window is open for ${secondsRemaining} more second(s), until ${i.challengeUntil}.` };
  }
  if (i.createdEpoch !== i.currentEpoch) {
    return { status: "aborted", reason: "seat revoked / epoch changed" };
  }
  const check = checkProposal(i.proposal);
  if (!check.matches) return { status: "aborted", reason: `proposal no longer matches its description (${check.mismatches.map((m) => m.field).join(", ")})` };
  const payee = i.payees?.lookup(i.proposal.transfer.payee, i.now) ?? null;
  const payeeStatus = payee?.status ?? "not-enforced";
  if (payee && payee.status !== "not-enforced" && payee.status !== "registered" && !(i.allowUnregistered && payee.status === "unregistered")) {
    return { status: "aborted", reason: payee.status === "unregistered" ? "payee not registered" : `payee ${payee.status}` };
  }
  const large = isLargeProposal(i.proposal, i.largeThresholdTinybars);
  let worldReason: string | null = null;
  if (large && i.approvedBy) {
    worldReason = `Large proposal approved by ${i.approvedBy}; no per-payment World ID check.`;
  } else if (large) {
    if (!i.approval) return { status: "aborted", reason: EXPIRED_IN_WINDOW };
    const gate = worldGate(i.approval, i.proposal.id, i.now);
    if (!gate.allowed) return { status: "aborted", reason: /expired/.test(gate.reason) ? EXPIRED_IN_WINDOW : gate.reason };
    worldReason = gate.reason;
  }
  return { status: "ok", payeeStatus, worldReason, large };
}
