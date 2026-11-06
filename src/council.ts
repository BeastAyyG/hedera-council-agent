// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Council agent orchestration: pay for a check, get the 0G verdict,
// apply the deterministic mismatch check, apply the World ID gate for
// large proposals, then sign or refuse. Every decision is logged to HCS
// (real) or labelled SIMULATED.

import { sha256, type EntryMeta } from "./auditlog.js";
import { SpendingCap } from "./budget.js";
import { checkProposal } from "./checker.js";
import { HederaClient, hashscanUrl } from "./hedera.js";
import type { CheckPayer } from "./payment.js";
import type { PayeeRegistry } from "./payee.js";
import { scheduleProblem, type ChainPort } from "./chain.js";
import type { Proposal } from "./proposal.js";
import { isLargeProposal, proposalFingerprint } from "./proposal.js";
import { recheckAtExecution } from "./challenge.js";
import { evaluateMandate, openTally, type MandateRules, type VoteTally } from "./mandate.js";
import { worldGate, type WorldCheck } from "./world.js";
import { zeroGVerdict, type ZeroGConfig, type ZeroGVerdict } from "./zeroG.js";

// PENDING_CHALLENGE: every check passed, signing waits for the challenge window
// and a re-check at execution. CANCELLED: a seat revocation cancelled it.
// PENDING_VOTE: outside the active standing instruction; the council decides.
export type CouncilDecision = "SIGNED" | "REFUSED" | "PENDING_CHALLENGE" | "CANCELLED" | "PENDING_VOTE";

// How a proposal stood against the active standing instruction.
export interface OutcomeMandate {
  id: string;
  rulesHash: string;
  within: boolean;
  violations: string[];
}

// The active standing instruction, as the caller sees it at decision time.
export interface MandateContext {
  id: string;
  rulesHash: string;
  rules: MandateRules;
  spentThisMonthTinybars: number;
  // Current seat ids: the electorate if a vote opens.
  seats: string[];
}

export interface CouncilOutcome {
  proposalId: string;
  decision: CouncilDecision;
  reason: string;
  checkMatches: boolean;
  paidVia: "x402" | "simulated";
  paidTxId: string | null;
  paidHashscan: string | null;
  auditTxId: string | null;
  // Position and hash of this decision's entry in the hash-chained HCS log.
  auditSeq: number | null;
  auditHash: string | null;
  auditError: string | null;
  scheduledTxId: string | null;
  scheduleAction: "created" | "signed" | "already-signed" | null;
  zeroGRequestId: string | null;
  zeroGSource: ZeroGVerdict["source"] | "none";
  zeroGVerdictText: string;
  worldGateReason: string | null;
  // True when a large proposal was signed on the strength of a World ID
  // approval; the caller must then spend that approval.
  usedWorldApproval: boolean;
  // ISO time the challenge window closes; set while the decision is PENDING_CHALLENGE.
  challengeUntil: string | null;
  // CANCELLED: the audit entry of the revocation that cancelled it.
  cancelledBy?: { auditSeq: number | null; auditHash: string | null; epoch: number };
  // Set when a standing instruction was active for this decision.
  mandate?: OutcomeMandate | null;
  // Set when the proposal went to (or came back from) a council vote.
  vote?: VoteTally | null;
  // Where the transfer that was checked came from.
  transferSource: "request" | "hedera-mirror-node";
  // The proposal as checked: with the on-chain transfer and schedule id filled in.
  proposal: Proposal;
  mode: "real" | "simulated";
}

export interface CouncilAgent {
  hedera: HederaClient;
  budget: SpendingCap;
  zeroG: ZeroGConfig;
  largeThresholdTinybars: number;
  payer: CheckPayer;
  // Real mode: the Hedera side of the council. Absent in simulated mode.
  chain?: ChainPort;
  // The council payee registry. Absent or empty-and-not-required: not enforced.
  payees?: PayeeRegistry;
  // Fail closed without a 0G verdict, even when no key is set. Defaults to
  // true in real Hedera mode, false in simulated mode.
  requireVerdict?: boolean;
  // ALLOW_NO_0G=true: sign without a 0G verdict (recorded in the log).
  allowNo0G?: boolean;
  // CHALLENGE_WINDOW_SECONDS: 0 or absent signs immediately; above 0 a proposal
  // that passes every check waits that long, then is re-checked at execution.
  challengeWindowSeconds?: number;
  // Injectable clock (tests and the demo).
  now?: () => Date;
}

export const NO_VERDICT_REASON = "0G verdict unavailable, failing closed";

// Why the agent must refuse for want of a 0G verdict, or null to go on.
// A key that is set but whose call failed always fails closed. A missing
// key fails closed only when a verdict is required (real mode by default);
// simulated mode with no key keeps its labelled template verdict.
export function verdictProblem(agent: Pick<CouncilAgent, "hedera" | "requireVerdict" | "allowNo0G">, verdict: ZeroGVerdict): string | null {
  if (agent.allowNo0G) return null;
  if (verdict.source === "unavailable") return `${NO_VERDICT_REASON} (${(verdict.error ?? "no response").slice(0, 160)})`;
  if (verdict.source === "simulated" && (agent.requireVerdict ?? agent.hedera.isReal())) {
    return `${NO_VERDICT_REASON}: no ZERO_G_API_KEY is set, so there is no 0G verdict.`;
  }
  return null;
}

// The anchors each decision carries in its sealed log entry.
function anchors(proposal: Proposal, verdict: ZeroGVerdict | null, payeeStatus: string | null): EntryMeta {
  const proposalHash = sha256(proposalFingerprint(proposal));
  return {
    proposalHash,
    ...(payeeStatus ? { payeeRegistry: payeeStatus } : {}),
    ...(verdict
      ? {
          zeroGRequestId: verdict.requestId?.slice(0, 80) ?? null,
          zeroGModel: verdict.source === "0g" ? verdict.model.slice(0, 48) : null,
          verdictHash: sha256(verdict.text + proposalHash),
        }
      : {}),
  };
}

function emptyOutcome(proposal: Proposal, mode: "real" | "simulated", paidVia: "x402" | "simulated", transferSource: CouncilOutcome["transferSource"]): CouncilOutcome {
  return {
    proposalId: proposal.id,
    decision: "REFUSED",
    reason: "",
    checkMatches: false,
    paidVia,
    paidTxId: null,
    paidHashscan: null,
    auditTxId: null,
    auditSeq: null,
    auditHash: null,
    auditError: null,
    scheduledTxId: null,
    scheduleAction: null,
    zeroGRequestId: null,
    zeroGSource: "none",
    zeroGVerdictText: "",
    worldGateReason: null,
    usedWorldApproval: false,
    challengeUntil: null,
    mandate: null,
    vote: null,
    transferSource,
    proposal,
    mode,
  };
}

export async function processProposal(
  agent: CouncilAgent,
  submitted: Proposal,
  worldCheck: WorldCheck | null,
  mandate: MandateContext | null = null,
): Promise<CouncilOutcome> {
  const mode = agent.hedera.mode;
  const network = agent.hedera.config.network;
  let proposal = submitted;
  let transferSource: CouncilOutcome["transferSource"] = "request";
  const writeAudit = async (proposalId: string, event: string, detail: string, meta?: EntryMeta) => {
    try {
      const r = await agent.hedera.auditEntry({ proposalId, event, detail, at: new Date().toISOString(), meta });
      return { auditTxId: r.txId, auditSeq: r.entry.seq, auditHash: r.entry.hash, auditError: null };
    } catch (err) {
      return { auditTxId: null, auditSeq: null, auditHash: null, auditError: `HCS audit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const auditEarly = (event: string, detail: string) => writeAudit(submitted.id, event, detail, anchors(proposal, null, null));

  // 0. Real mode: the transfer to check is the one on Hedera, read back
  // from the mirror node, never the one that came with the request.
  if (agent.chain) {
    try {
      const onChain = await agent.chain.resolve(submitted);
      const problem = scheduleProblem(onChain, agent.hedera.config.treasuryAccountId);
      proposal = { ...submitted, scheduleId: onChain.scheduleId, transferFromChain: undefined };
      if (onChain.transfer) {
        proposal = { ...proposal, transfer: { payee: onChain.transfer.payee, amountTinybars: onChain.transfer.amountTinybars, token: "HBAR" } };
        transferSource = "hedera-mirror-node";
      }
      if (problem) {
        const reason = `Schedule ${onChain.scheduleId} cannot be signed: ${problem}`;
        return { ...emptyOutcome(proposal, mode, agent.payer.via, transferSource), reason, ...(await auditEarly("REFUSED_SCHEDULE", reason)) };
      }
    } catch (err) {
      const reason = `Could not read the proposal's Scheduled Transaction from Hedera: ${err instanceof Error ? err.message : String(err)}`;
      return { ...emptyOutcome(proposal, mode, agent.payer.via, transferSource), reason };
    }
  } else if (submitted.transferFromChain) {
    return {
      ...emptyOutcome(proposal, mode, agent.payer.via, transferSource),
      reason: "The request names a scheduleId but gives no transfer, and this agent has no Hedera access to read it. The agent does not sign.",
    };
  }
  const check = checkProposal(proposal);
  const base: CouncilOutcome = {
    proposalId: proposal.id,
    decision: "REFUSED",
    reason: "",
    checkMatches: check.matches,
    paidVia: agent.payer.via,
    paidTxId: null,
    paidHashscan: null,
    auditTxId: null,
    auditSeq: null,
    auditHash: null,
    auditError: null,
    scheduledTxId: null,
    scheduleAction: null,
    zeroGRequestId: null,
    zeroGSource: "none",
    zeroGVerdictText: "",
    worldGateReason: null,
    usedWorldApproval: false,
    challengeUntil: null,
    mandate: null,
    vote: null,
    transferSource,
    proposal,
    mode,
  };

  const payeeLookup = agent.payees?.lookup(proposal.transfer.payee) ?? null;
  const payeeStatus = payeeLookup?.status ?? "not-enforced";
  let verdictSeen: ZeroGVerdict | null = null;
  // Set once the active standing instruction has been applied: decisions under it anchor its rulesHash.
  let underRules: string | null = null;
  const audit = (event: string, detail: string) =>
    writeAudit(proposal.id, event, detail, { ...anchors(proposal, verdictSeen, payeeStatus), ...(underRules ? { rulesHash: underRules } : {}) });

  // 1. Pay for the check, under the spending cap. No payment, no check.
  const price = agent.payer.priceAtomic;
  if (!agent.budget.canAfford(price)) {
    return { ...base, reason: `Spending cap reached: cannot afford the check fee (${price} USDC atomic units).` };
  }
  const paid = await agent.payer.payForCheck(proposal);
  if (paid.paymentId) agent.budget.record(price);
  // The 402 offer asked to pay someone other than the registered check
  // service: nothing was paid, and the refusal is logged.
  if (!paid.ok && paid.kind === "payee-swap") {
    return { ...base, reason: paid.error, ...(await audit("REFUSED_PAYEE_SWAP", paid.error)) };
  }
  const paidTxId = paid.paymentId;
  const paidHashscan = mode === "real" && paidTxId ? hashscanUrl(network, paidTxId) : null;
  const afterPay = { ...base, paidTxId, paidHashscan };
  if (!paid.ok) return { ...afterPay, reason: `Check payment failed, the agent does not sign: ${paid.error}` };
  if (!(await agent.hedera.verifyPayment(paid.paymentId))) {
    return { ...afterPay, reason: `Check payment ${paid.paymentId} did not verify as settled on Hedera.` };
  }
  // The paid check service and the local checker must agree.
  if (paid.remoteCheck && (paid.remoteCheck.proposalId !== proposal.id || paid.remoteCheck.matches !== check.matches)) {
    return { ...afterPay, reason: "The paid check result disagrees with the local check. The agent does not sign." };
  }

  // 2. 0G writes the plain-language verdict for this check.
  const verdict = await zeroGVerdict(agent.zeroG, {
    proposalId: proposal.id,
    checkVerdict: check.verdict,
    matches: check.matches,
    amountTinybars: proposal.transfer.amountTinybars,
    payee: proposal.transfer.payee,
  });
  verdictSeen = verdict;
  const afterVerdict = {
    ...afterPay,
    zeroGRequestId: verdict.requestId,
    zeroGSource: verdict.source,
    zeroGVerdictText: verdict.text,
  };

  // 3. Deterministic decision: a mismatch always refuses, whatever 0G says.
  if (!check.matches) {
    return { ...afterVerdict, reason: check.verdict, ...(await audit("REFUSED_MISMATCH", check.verdict)) };
  }

  // 3b. No 0G verdict: fail closed. Paying for the check is not enough.
  const noVerdict = verdictProblem(agent, verdict);
  if (noVerdict) return { ...afterVerdict, reason: noVerdict, ...(await audit("REFUSED_NO_VERDICT", noVerdict)) };
  const verdictNote = agent.allowNo0G && verdict.source !== "0g" ? " ALLOW_NO_0G is on: signed without a 0G verdict." : "";

  // 3c. The recipient must be in the council payee registry, unexpired. Under an
  // active standing instruction a recipient missing from the registry is a new
  // recipient: 3d sends it to the council. Revoked or expired entries always refuse.
  const newRecipient = mandate !== null && payeeLookup?.status === "unregistered";
  if (payeeLookup && payeeLookup.status !== "not-enforced" && payeeLookup.status !== "registered" && !newRecipient) {
    return { ...afterVerdict, reason: payeeLookup.detail, ...(await audit("REFUSED_UNREGISTERED_PAYEE", `Payee registry lookup: ${payeeLookup.status}. ${payeeLookup.detail}`)) };
  }

  // 3d. Standing instruction, only when one is active. Inside it, the adopted
  // instruction is the human approval; outside it, the council votes (or the
  // instruction says refuse).
  let outcomeMandate: OutcomeMandate | null = null;
  let mandatePrefix = "";
  if (mandate) {
    underRules = mandate.rulesHash;
    const ev = evaluateMandate(mandate.rules, proposal, { spentThisMonthTinybars: mandate.spentThisMonthTinybars, payeeStatus });
    outcomeMandate = { id: mandate.id, rulesHash: mandate.rulesHash, within: ev.within, violations: ev.violations };
    const why = ev.violations.join("; ");
    const withMandate = { ...afterVerdict, mandate: outcomeMandate };
    if (!ev.within && mandate.rules.outsideMandate === "refuse") {
      const reason = `Outside standing instruction ${mandate.id}: ${why}. The instruction says to refuse anything else.`;
      return { ...withMandate, reason, ...(await audit("REFUSED_OUTSIDE_MANDATE", reason)) };
    }
    if (!ev.within && mandate.seats.length === 0) {
      const reason = `Outside standing instruction ${mandate.id}: ${why}. No council seats are left to vote on it, so the agent does not sign.`;
      return { ...withMandate, reason, ...(await audit("REFUSED_OUTSIDE_MANDATE", reason)) };
    }
    if (!ev.within) {
      const vote = openTally(mandate.seats);
      const logged = await audit(
        "VOTE_OPENED",
        `${proposal.id} is outside standing instruction ${mandate.id} (${why}). Council vote opened: ${vote.needed} of ${vote.eligible.length} needed.`,
      );
      return {
        ...withMandate,
        decision: "PENDING_VOTE",
        reason: `Outside standing instruction ${mandate.id}: ${why}. Waiting for the council: ${vote.needed} of ${vote.eligible.length} seats must vote yes.`,
        scheduledTxId: proposal.scheduleId ?? null,
        vote,
        ...logged,
      };
    }
    mandatePrefix = `Within standing instruction ${mandate.id}. `;
  }

  // 4. Large proposal: World ID gate before signing, unless an adopted
  // standing instruction covers it.
  const large = isLargeProposal(proposal, agent.largeThresholdTinybars);
  let worldGateReason: string | null = null;
  if (large && outcomeMandate) {
    worldGateReason = `Large proposal inside standing instruction ${outcomeMandate.id}: the council-adopted instruction is the human approval, no per-payment World ID check.`;
  } else if (large) {
    const gate = worldGate(worldCheck, proposal.id, agent.now?.());
    worldGateReason = gate.reason;
    if (!gate.allowed) {
      return {
        ...afterVerdict,
        reason: `Large proposal, World ID gate blocked signing: ${gate.reason}`,
        worldGateReason,
        ...(await audit("REFUSED_WORLD_ID", gate.reason)),
      };
    }
  }

  // 5a. Challenge window: every check passed, but signing waits. The
  // approval is not spent; execution re-checks everything and spends it.
  const windowSeconds = agent.challengeWindowSeconds ?? 0;
  if (windowSeconds > 0) {
    const challengeUntil = new Date((agent.now?.() ?? new Date()).getTime() + windowSeconds * 1000).toISOString();
    const logged = await audit("PROPOSAL_CREATED", `PROPOSAL ${proposal.id} CREATED, challenge until ${challengeUntil}`);
    return {
      ...afterVerdict,
      mandate: outcomeMandate,
      decision: "PENDING_CHALLENGE",
      reason: `${mandatePrefix}Passed every check. Not signed yet: challenge window open until ${challengeUntil}, then POST /proposals/${proposal.id}/execute re-checks and signs.`,
      scheduledTxId: proposal.scheduleId ?? null,
      worldGateReason,
      challengeUntil,
      ...logged,
    };
  }

  // 5. Sign: co-sign the Scheduled Transaction that was just checked.
  let schedule;
  try {
    schedule = agent.chain && proposal.scheduleId ? await agent.chain.sign(proposal.scheduleId) : agent.hedera.simulateSign();
  } catch (err) {
    const msg = `Scheduled Transaction failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...afterVerdict, reason: msg, worldGateReason, ...(await audit("SIGN_FAILED", msg)) };
  }
  const logged = await audit(
    "SIGNED",
    `${mandatePrefix}Agent ${schedule.action} schedule ${schedule.scheduleId}. Check paid ${paidTxId}. 0G request ${verdict.requestId ?? "none"}. Payee registry: ${payeeStatus}.${verdictNote}`,
  );
  return {
    ...afterVerdict,
    mandate: outcomeMandate,
    decision: "SIGNED",
    reason: `${mandatePrefix}Agent signed proposal ${proposal.id}. ${verdict.text}`,
    scheduledTxId: schedule.scheduleId,
    scheduleAction: schedule.action,
    worldGateReason,
    usedWorldApproval: large && !outcomeMandate,
    ...logged,
  };
}

export interface PendingExecution {
  outcome: CouncilOutcome;
  challengeUntil: string;
  challenged: boolean;
  challengeReason?: string | null;
  createdEpoch: number;
}

export type ExecuteResult =
  | { kind: "too-early"; secondsRemaining: number; reason: string }
  | { kind: "challenged"; reason: string }
  | { kind: "done"; outcome: CouncilOutcome };

// Execute a proposal whose challenge window has run: re-check everything from
// scratch, then sign (and the caller spends the World approval) or abort.
export async function executePending(
  agent: CouncilAgent,
  pending: PendingExecution,
  ctx: { currentEpoch: number; approval: WorldCheck | null; mandate?: MandateContext | null },
): Promise<ExecuteResult> {
  const now = agent.now?.() ?? new Date();
  const prev = pending.outcome;
  // A council vote or the adopted standing instruction stands in for the per-payment World ID check.
  const votedThrough = prev.vote?.status === "passed";
  const approvedBy = votedThrough ? "the council vote" : prev.mandate?.within ? `standing instruction ${prev.mandate.id}` : null;
  let proposal = prev.proposal;
  let chainProblem: string | null = null;
  // Real mode: read the schedule back from Hedera again; it may have been deleted or changed.
  if (agent.chain && proposal.scheduleId) {
    try {
      const onChain = await agent.chain.resolve(proposal);
      chainProblem = scheduleProblem(onChain, agent.hedera.config.treasuryAccountId);
      if (onChain.transfer) proposal = { ...proposal, transfer: { payee: onChain.transfer.payee, amountTinybars: onChain.transfer.amountTinybars, token: "HBAR" } };
    } catch (err) {
      chainProblem = `could not read the schedule from Hedera (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const re = recheckAtExecution({
    proposal,
    payees: agent.payees,
    largeThresholdTinybars: agent.largeThresholdTinybars,
    approval: ctx.approval,
    challengeUntil: pending.challengeUntil,
    challenged: pending.challenged,
    challengeReason: pending.challengeReason,
    createdEpoch: pending.createdEpoch,
    currentEpoch: ctx.currentEpoch,
    now,
    approvedBy,
    allowUnregistered: votedThrough,
  });
  if (re.status === "too-early") return { kind: "too-early", secondsRemaining: re.secondsRemaining, reason: re.reason };
  if (re.status === "challenged") return { kind: "challenged", reason: re.reason };

  const proposalHash = sha256(proposalFingerprint(proposal));
  const meta: EntryMeta = {
    proposalHash,
    payeeRegistry: re.status === "ok" ? re.payeeStatus : "not-enforced",
    zeroGRequestId: prev.zeroGRequestId?.slice(0, 80) ?? null,
    zeroGModel: prev.zeroGSource === "0g" ? agent.zeroG.model.slice(0, 48) : null,
    verdictHash: sha256(prev.zeroGVerdictText + proposalHash),
    ...(prev.mandate ? { rulesHash: prev.mandate.rulesHash } : {}),
  };
  const write = async (event: string, detail: string) => {
    try {
      const r = await agent.hedera.auditEntry({ proposalId: proposal.id, event, detail, at: now.toISOString(), meta });
      return { auditTxId: r.txId, auditSeq: r.entry.seq, auditHash: r.entry.hash, auditError: null };
    } catch (err) {
      return { auditTxId: null, auditSeq: null, auditHash: null, auditError: `HCS audit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const aborted = async (reason: string): Promise<ExecuteResult> => ({
    kind: "done",
    outcome: {
      ...prev,
      proposal,
      decision: "REFUSED",
      reason: `re-checked at execution: ${reason}, ABORTED`,
      challengeUntil: null,
      ...(await write("ABORTED_AT_EXECUTION", `re-checked at execution: ${reason}, ABORTED`)),
    },
  });
  if (chainProblem) return aborted(`schedule ${proposal.scheduleId} cannot be signed: ${chainProblem}`);
  if (re.status === "aborted") return aborted(re.reason);
  // Inside-the-instruction proposals: the instruction must still be in force, and
  // the payment still inside it (other payments may have used up the month).
  if (prev.mandate?.within && !votedThrough) {
    const cur = ctx.mandate ?? null;
    if (!cur || cur.id !== prev.mandate.id) return aborted(`standing instruction ${prev.mandate.id} is no longer in force`);
    const ev = evaluateMandate(cur.rules, proposal, { spentThisMonthTinybars: cur.spentThisMonthTinybars, payeeStatus: re.payeeStatus });
    if (!ev.within) return aborted(`now outside standing instruction ${cur.id} (${ev.violations.join("; ")})`);
  }

  let schedule;
  try {
    schedule = agent.chain && proposal.scheduleId ? await agent.chain.sign(proposal.scheduleId) : agent.hedera.simulateSign();
  } catch (err) {
    const msg = `Scheduled Transaction failed: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "done", outcome: { ...prev, proposal, decision: "REFUSED", reason: msg, challengeUntil: null, ...(await write("SIGN_FAILED", msg)) } };
  }
  const logged = await write(
    "SIGNED",
    `Agent ${schedule.action} schedule ${schedule.scheduleId} at execution, after the challenge window (re-checked). Check paid ${prev.paidTxId}. 0G request ${prev.zeroGRequestId ?? "none"}. Payee registry: ${re.payeeStatus}.`,
  );
  return {
    kind: "done",
    outcome: {
      ...prev,
      proposal,
      decision: "SIGNED",
      reason: `Agent signed proposal ${proposal.id} at execution, after a re-check. ${prev.zeroGVerdictText}`,
      scheduledTxId: schedule.scheduleId,
      scheduleAction: schedule.action,
      worldGateReason: re.worldReason ?? prev.worldGateReason,
      usedWorldApproval: re.large && !approvedBy,
      challengeUntil: null,
      ...logged,
    },
  };
}

// Resolve a closed council vote on a PENDING_VOTE proposal. The x402 check is
// not paid again: like executePending, the deterministic checks are re-run
// (and the schedule re-read in real mode), then the challenge window or sign.
export async function resolveVote(
  agent: CouncilAgent,
  prev: CouncilOutcome,
  vote: VoteTally,
  ctx: { createdEpoch: number; currentEpoch: number },
): Promise<CouncilOutcome> {
  const now = agent.now?.() ?? new Date();
  const tally = `${vote.yes} yes, ${vote.no} no of ${vote.eligible.length} seats, ${vote.needed} needed`;
  let proposal = prev.proposal;
  const proposalHash = sha256(proposalFingerprint(proposal));
  let payeeStatus = "not-enforced";
  const write = async (event: string, detail: string) => {
    const meta: EntryMeta = {
      proposalHash,
      payeeRegistry: payeeStatus,
      zeroGRequestId: prev.zeroGRequestId?.slice(0, 80) ?? null,
      zeroGModel: prev.zeroGSource === "0g" ? agent.zeroG.model.slice(0, 48) : null,
      verdictHash: sha256(prev.zeroGVerdictText + proposalHash),
      ...(prev.mandate ? { rulesHash: prev.mandate.rulesHash } : {}),
    };
    try {
      const r = await agent.hedera.auditEntry({ proposalId: proposal.id, event, detail, at: now.toISOString(), meta });
      return { auditTxId: r.txId, auditSeq: r.entry.seq, auditHash: r.entry.hash, auditError: null };
    } catch (err) {
      return { auditTxId: null, auditSeq: null, auditHash: null, auditError: `HCS audit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const closed = { ...prev, vote, challengeUntil: null };
  if (vote.status === "failed") {
    const reason = `Council vote failed (${tally}). The agent does not sign.`;
    return { ...closed, decision: "REFUSED", reason, ...(await write("VOTE_FAILED", `Council vote on ${proposal.id} failed (${tally}).`)) };
  }
  if (vote.status !== "passed") return prev;

  let problem: string | null = null;
  if (agent.chain && proposal.scheduleId) {
    try {
      const onChain = await agent.chain.resolve(proposal);
      const p = scheduleProblem(onChain, agent.hedera.config.treasuryAccountId);
      if (p) problem = `schedule ${proposal.scheduleId} cannot be signed: ${p}`;
      if (onChain.transfer) proposal = { ...proposal, transfer: { payee: onChain.transfer.payee, amountTinybars: onChain.transfer.amountTinybars, token: "HBAR" } };
    } catch (err) {
      problem = `could not read the schedule from Hedera (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  if (!problem && ctx.createdEpoch !== ctx.currentEpoch) problem = "seat revoked / epoch changed";
  if (!problem) {
    const check = checkProposal(proposal);
    if (!check.matches) problem = `proposal no longer matches its description (${check.mismatches.map((m) => m.field).join(", ")})`;
  }
  if (!problem) {
    const payee = agent.payees?.lookup(proposal.transfer.payee, now) ?? null;
    payeeStatus = payee?.status ?? "not-enforced";
    // The council just approved this payment, a new recipient included; revoked or expired entries still abort.
    if (payee && payee.status !== "not-enforced" && payee.status !== "registered" && payee.status !== "unregistered") {
      problem = `payee ${payee.status}`;
    }
  }
  const after = { ...closed, proposal, worldGateReason: `Council vote passed (${tally}): a majority of World-ID-verified seats approved this payment.`, usedWorldApproval: false };
  if (problem) {
    const reason = `Council vote passed (${tally}), but re-checked after the vote: ${problem}, ABORTED`;
    return { ...after, decision: "REFUSED", reason, ...(await write("ABORTED_AFTER_VOTE", reason)) };
  }

  const windowSeconds = agent.challengeWindowSeconds ?? 0;
  if (windowSeconds > 0) {
    const challengeUntil = new Date(now.getTime() + windowSeconds * 1000).toISOString();
    const logged = await write("VOTE_PASSED", `Council vote on ${proposal.id} passed (${tally}). Re-checked, no second check fee. Challenge until ${challengeUntil}.`);
    return {
      ...after,
      decision: "PENDING_CHALLENGE",
      reason: `Council vote passed (${tally}). Not signed yet: challenge window open until ${challengeUntil}, then POST /proposals/${proposal.id}/execute re-checks and signs.`,
      scheduledTxId: proposal.scheduleId ?? null,
      challengeUntil,
      ...logged,
    };
  }
  const passed = await write("VOTE_PASSED", `Council vote on ${proposal.id} passed (${tally}). Re-checked, no second check fee.`);
  let schedule;
  try {
    schedule = agent.chain && proposal.scheduleId ? await agent.chain.sign(proposal.scheduleId) : agent.hedera.simulateSign();
  } catch (err) {
    const msg = `Scheduled Transaction failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...after, decision: "REFUSED", reason: msg, ...(await write("SIGN_FAILED", msg)) };
  }
  const logged = await write(
    "SIGNED",
    `Agent ${schedule.action} schedule ${schedule.scheduleId} after the council vote (${tally}). Check paid ${prev.paidTxId} (once). Payee registry: ${payeeStatus}.`,
  );
  return {
    ...after,
    decision: "SIGNED",
    reason: `Council vote passed (${tally}). Agent signed proposal ${proposal.id} after a re-check, without a second check fee. ${prev.zeroGVerdictText}`,
    scheduledTxId: schedule.scheduleId,
    scheduleAction: schedule.action,
    ...logged,
    auditError: logged.auditError ?? passed.auditError,
  };
}
