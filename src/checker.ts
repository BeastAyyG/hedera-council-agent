// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Deterministic mismatch checker. No LLM in the decision path.
// The check compares the description against the exact transfer, field
// by field. A 0G verdict is plain-language commentary on top of this
// check; it never overrides a mismatch.

import type { Proposal } from "./proposal.js";

export interface Mismatch {
  field: string;
  described: string;
  actual: string;
}

export interface CheckResult {
  proposalId: string;
  matches: boolean;
  mismatches: Mismatch[];
  verdict: string;
}

export function checkProposal(p: Proposal): CheckResult {
  const mismatches: Mismatch[] = [];
  const d = p.description;
  const t = p.transfer;
  if (d.payee.trim() !== t.payee.trim()) {
    mismatches.push({ field: "payee", described: d.payee, actual: t.payee });
  }
  if (d.amountTinybars !== t.amountTinybars) {
    mismatches.push({
      field: "amountTinybars",
      described: String(d.amountTinybars),
      actual: String(t.amountTinybars),
    });
  }
  if (d.token !== t.token) {
    mismatches.push({ field: "token", described: d.token, actual: t.token });
  }
  const matches = mismatches.length === 0;
  return {
    proposalId: p.id,
    matches,
    mismatches,
    verdict: matches
      ? `Proposal ${p.id} matches its description: ${d.amountTinybars} tinybars of ${d.token} to ${d.payee} for "${d.purpose}".`
      : `Proposal ${p.id} does NOT match its description: ${mismatches
          .map((m) => `${m.field} described as ${m.described} but transfer is ${m.actual}`)
          .join("; ")}.`,
  };
}
