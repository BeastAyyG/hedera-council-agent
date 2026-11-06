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
        ? `Refuse a recipient that is not in the council payee registry (${p.payees.source}, ${p.payees.count} entries) or whose entry has expired.`
        : "No payee registry is enforced: a recipient that matches its description may be signed. Set PAYEE_REGISTRY or REQUIRE_REGISTERED_PAYEE=true to enforce one.",
      p.verdict.allowNo0G
        ? "ALLOW_NO_0G is on: the agent may sign without a 0G verdict. Every entry still records the verdict hash or its absence."
        : "Fail closed: with no 0G verdict (call failed, or no key in real mode) the agent refuses. In simulated mode without a key the verdict is a labelled template.",
      "Every decision entry anchors the proposal hash, the 0G request id and model, a hash of the verdict plus the proposal hash, and the payee registry result.",
      `Large proposals need a fresh World ID approval for that exact proposal: single use, ${p.worldGate.approvalTtlMinutes} minutes, verified on the server.`,
      ...(p.challenge && p.challenge.windowSeconds > 0
        ? [
            `A proposal that passes every check waits ${p.challenge.windowSeconds} seconds before it can be signed. It executes only after a re-check at execution: the mismatch check, the payee registry, the revocation epoch and, for large proposals, a World ID approval that is still unexpired. A challenged proposal does not execute.`,
          ]
        : []),
      ...(p.auth?.enabled ? ["State-changing routes require the API key; the key is never published."] : []),
      "Revoking a council seat bumps the epoch, blocks that person from rejoining and cancels every pending proposal.",
      "Log every decision to the HCS audit topic as a hash-chained entry that commits to this policy.",
    ],
  };
  return { policy, hash: sha256(canonical(policy)) };
}
