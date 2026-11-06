// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Council agent orchestration: pay for a check, get the 0G verdict,
// apply the deterministic mismatch check, apply the World ID gate for
// large proposals, then sign or refuse. Every step is logged to HCS
// (real) or labelled SIMULATED.

import { SpendingCap } from "./budget.js";
import { checkProposal } from "./checker.js";
import { HederaClient, hashscanUrl } from "./hedera.js";
import type { Proposal } from "./proposal.js";
import { isLargeProposal } from "./proposal.js";
import { worldGate, type WorldCheck } from "./world.js";
import { zeroGVerdict, type ZeroGConfig } from "./zeroG.js";

export type CouncilDecision = "SIGNED" | "REFUSED";

export interface CouncilOutcome {
  proposalId: string;
  decision: CouncilDecision;
  reason: string;
  checkMatches: boolean;
  paidTxId: string | null;
  paidHashscan: string | null;
  auditTxId: string | null;
  scheduledTxId: string | null;
  zeroGRequestId: string | null;
  zeroGSource: "0g" | "simulated";
  zeroGVerdictText: string;
  worldGateReason: string | null;
  mode: "real" | "simulated";
}

export interface CouncilAgent {
  hedera: HederaClient;
  budget: SpendingCap;
  zeroG: ZeroGConfig;
  largeThresholdTinybars: number;
  checkPriceTinybars: number;
  payTo: string;
}

export async function processProposal(
  agent: CouncilAgent,
  proposal: Proposal,
  worldCheck: WorldCheck | null,
): Promise<CouncilOutcome> {
  const mode = agent.hedera.mode;
  const check = checkProposal(proposal);

  // 1. Pay for the check, under the spending cap. No payment, no check.
  let paidTxId: string | null = null;
  if (!agent.budget.canAfford(agent.checkPriceTinybars)) {
    return {
      proposalId: proposal.id,
      decision: "REFUSED",
      reason: `Spending cap reached: cannot afford the ${agent.checkPriceTinybars} tinybar check fee.`,
      checkMatches: check.matches,
      paidTxId: null,
      paidHashscan: null,
      auditTxId: null,
      scheduledTxId: null,
      zeroGRequestId: null,
      zeroGSource: "simulated",
      zeroGVerdictText: "",
      worldGateReason: null,
      mode,
    };
  }
  paidTxId = await agent.hedera.pay(agent.payTo, agent.checkPriceTinybars, `check ${proposal.id}`);
  agent.budget.record(agent.checkPriceTinybars);
  const verified = await agent.hedera.verifyPayment(paidTxId);
  if (!verified) {
    return {
      proposalId: proposal.id,
      decision: "REFUSED",
      reason: `Check payment ${paidTxId} did not verify as settled.`,
      checkMatches: check.matches,
      paidTxId,
      paidHashscan: mode === "real" ? hashscanUrl(agent.hedera.config.network, paidTxId) : null,
      auditTxId: null,
      scheduledTxId: null,
      zeroGRequestId: null,
      zeroGSource: "simulated",
      zeroGVerdictText: "",
      worldGateReason: null,
      mode,
    };
  }

  // 2. 0G writes the plain-language verdict for this check.
  const verdict = await zeroGVerdict(agent.zeroG, {
    proposalId: proposal.id,
    checkVerdict: check.verdict,
    matches: check.matches,
    amountTinybars: proposal.transfer.amountTinybars,
    payee: proposal.transfer.payee,
  });

  // 3. Deterministic decision: a mismatch always refuses, whatever 0G says.
  if (!check.matches) {
    const auditTxId = await agent.hedera.audit({
      proposalId: proposal.id,
      event: "REFUSED_MISMATCH",
      detail: check.verdict,
      at: new Date().toISOString(),
    });
    return {
      proposalId: proposal.id,
      decision: "REFUSED",
      reason: check.verdict,
      checkMatches: false,
      paidTxId,
      paidHashscan: mode === "real" ? hashscanUrl(agent.hedera.config.network, paidTxId) : null,
      auditTxId,
      scheduledTxId: null,
      zeroGRequestId: verdict.requestId,
      zeroGSource: verdict.source,
      zeroGVerdictText: verdict.text,
      worldGateReason: null,
      mode,
    };
  }

  // 4. Large proposal: World ID gate before signing.
  let worldGateReason: string | null = null;
  if (isLargeProposal(proposal, agent.largeThresholdTinybars)) {
    const gate = worldGate(worldCheck, proposal.id);
    worldGateReason = gate.reason;
    if (!gate.allowed) {
      const auditTxId = await agent.hedera.audit({
        proposalId: proposal.id,
        event: "REFUSED_WORLD_ID",
        detail: gate.reason,
        at: new Date().toISOString(),
      });
      return {
        proposalId: proposal.id,
        decision: "REFUSED",
        reason: `Large proposal, World ID gate blocked signing: ${gate.reason}`,
        checkMatches: true,
        paidTxId,
        paidHashscan: mode === "real" ? hashscanUrl(agent.hedera.config.network, paidTxId) : null,
        auditTxId,
        scheduledTxId: null,
        zeroGRequestId: verdict.requestId,
        zeroGSource: verdict.source,
        zeroGVerdictText: verdict.text,
        worldGateReason,
        mode,
      };
    }
  }

  // 5. Sign: create the Scheduled Transaction for the exact transfer.
  const scheduledTxId = await agent.hedera.createScheduledTransfer(
    proposal.transfer,
    `proposal ${proposal.id}: ${proposal.description.purpose}`,
  );
  const auditTxId = await agent.hedera.audit({
    proposalId: proposal.id,
    event: "SIGNED",
    detail: `Agent signed. Scheduled tx ${scheduledTxId}. 0G request ${verdict.requestId ?? "none"}.`,
    at: new Date().toISOString(),
  });
  return {
    proposalId: proposal.id,
    decision: "SIGNED",
    reason: `Agent signed proposal ${proposal.id}. ${verdict.text}`,
    checkMatches: true,
    paidTxId,
    paidHashscan: mode === "real" ? hashscanUrl(agent.hedera.config.network, paidTxId) : null,
    auditTxId,
    scheduledTxId,
    zeroGRequestId: verdict.requestId,
    zeroGSource: verdict.source,
    zeroGVerdictText: verdict.text,
    worldGateReason,
    mode,
  };
}
