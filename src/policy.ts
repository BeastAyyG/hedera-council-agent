// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// The agent's published policy: the rules it signs under, as data. Its
// hash is written into every HCS audit entry, so each logged decision
// commits to the exact policy in force when it was made, and anyone can
// fetch GET /policy and check the hash.

import { canonical, sha256 } from "./auditlog.js";

export interface AgentPolicy {
  version: 1;
  network: string;
  mode: "real" | "simulated";
  treasury: string;
  signers: { agent: string; proposer: string | null; threshold: string };
  largeThresholdTinybars: number;
  check: { via: "x402" | "simulated"; priceUsdc: string; spendCapUsdc: string; decidedBy: string; payTo?: string };
  // The council's own payee registry (not ERC-8004/8478). "demo registry"
  // means the built-in demo payees, simulated mode only.
  payees: { count: number; enforce: boolean; source: string };
  verdict: { zeroG: string; requireVerdict: boolean; allowNo0G: boolean };
  worldGate: { requiredForLarge: boolean; environment: string; approvalTtlMinutes: number; singleUse: boolean };
  transferSource: "hedera-mirror-node" | "request";
  // 0 seconds: no window, the agent signs as soon as every check passes.
  challenge?: { windowSeconds: number; recheckAtExecution: boolean };
  // Whether state-changing routes need the API key. Never the key itself.
  auth?: { enabled: boolean };
  rules: string[];
}

export function buildPolicy(p: Omit<AgentPolicy, "version" | "rules">): { policy: AgentPolicy; hash: string } {
  const policy: AgentPolicy = {
    version: 1,
    ...p,
    rules: [
      "Sign only the Scheduled Transaction read back from Hedera, never a transfer supplied with the request.",
      "Refuse when payee, amount or token differ from the description. The deterministic checker decides; no model is in the decision path.",
      "Refuse a schedule that pays out of any account other than the council treasury, or that is deleted or already executed.",
      "Pay for every check over x402 under a spending cap, and never pay above the configured price.",
      "Pay only a 402 offer whose payTo is the registered check service wallet; the 402 response is untrusted. A swapped payTo is refused before anything is paid.",
      p.payees.enforce
        ? `Refuse a recipient whose entry in the council payee registry (${p.payees.source}, ${p.payees.count} entries) is revoked, expired or not yet valid. A recipient not in the registry is refused, unless a standing instruction is in force: then it is a new recipient and goes to a council vote (or is refused if the instruction says so).`
        : "No payee registry is enforced: a recipient that matches its description may be signed. Set PAYEE_REGISTRY or REQUIRE_REGISTERED_PAYEE=true to enforce one.",
      p.verdict.allowNo0G
        ? "ALLOW_NO_0G is on: the agent may sign without a 0G verdict. Every entry still records the verdict hash or its absence."
        : "Fail closed: with no 0G verdict (call failed, or no key in real mode) the agent refuses. In simulated mode without a key the verdict is a labelled template.",
      "Every decision entry anchors the proposal hash, the 0G request id and model, a hash of the verdict plus the proposal hash, and the payee registry result.",
      `With no standing instruction covering it, a large proposal needs a fresh World ID approval for that exact proposal: single use, ${p.worldGate.approvalTtlMinutes} minutes, verified on the server.`,
      "A standing instruction is the owner's plain-language rules, compiled into fixed rules by 0G and adopted by a majority vote of the council; its rulesHash is logged. Inside it, a payment of any size is signed with no vote and no per-payment World ID check. Outside it, the payment waits for a council vote: a majority of the World-ID-verified seats that existed when the vote opened, each ballot a proof bound to the exact payment and choice. After a passing vote the payment is re-checked before signing, with no second check fee.",
      ...(p.challenge && p.challenge.windowSeconds > 0
        ? [
            `A proposal that passes every check waits ${p.challenge.windowSeconds} seconds before it can be signed. It executes only after a re-check at execution: the mismatch check, the payee registry, the revocation epoch and, for large proposals, a World ID approval that is still unexpired. A challenged proposal does not execute.`,
          ]
        : []),
      ...(p.auth?.enabled ? ["State-changing routes require the API key; the key is never published."] : []),
      "Council admission: one seat per World ID nullifier. The first seat founds the council; every later seat needs a single-use invite from a current seat holder, valid 24 hours and void once the inviter's seat is revoked.",
      "A seat holder may leave the council at once. Removing another seat takes a council vote: a majority of the other seats. A revocation bumps the epoch, blocks that person from rejoining, cancels every pending proposal and closes every open vote.",
      "Log every decision to the HCS audit topic as a hash-chained entry that commits to this policy.",
    ],
  };
  return { policy, hash: sha256(canonical(policy)) };
}
