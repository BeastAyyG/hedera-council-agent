// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Demo rehearsal: 12 scenes, the exact moments the submission video shows.
// Scene 1: routine proposal, paid check, agent signs.
// Scene 2: mismatched proposal, paid check, agent refuses.
// Scene 3: large proposal, World ID approved, agent signs.
// Scene 4: large proposal, World ID denied, agent does not sign.
// Scene 5: yesterday's World ID approval is spent; reusing it is refused.
// Scene 6: the 402 names a swapped recipient; refused before paying.
// Scene 7: 0G is unavailable; the agent fails closed.
// Scene 8: challenge window. A proposal passes and waits; its payee is revoked
//          in the window; at execution the agent re-checks and aborts. A second
//          proposal executes after the window and signs. A fake clock, no sleeps.
// Scene 9: the owner's standing instruction is compiled (SIMULATED 0G unless keyed)
//          and adopted 2 of 3 by mocked council members.
// Scene 10: a large payment inside the instruction is signed with no vote and no World ID check.
// Scene 11: a payment to a payee new to the instruction opens a council vote; 2 yes,
//           signed after a re-check, without a second check fee.
// Scene 12: a payment over the monthly cap opens a vote; 2 no, refused.
// In real mode the paid check service (POST /check) is started in-process
// unless CHECK_SERVICE_URL points elsewhere, and the agent pays it via x402.
// World ID approvals in this rehearsal are MOCKED; the real World ID flow
// runs through the server and the console UI.
import type { Server } from "node:http";
import { atomicToUsd, SpendingCap, usdcToAtomic } from "./budget.js";
import { processProposal } from "./council.js";
import { buildAgent, createApp } from "./server.js";
import { ApprovalStore, mockedWorldCheck } from "./world.js";
import { SimulatedCheckPayer } from "./payment.js";
import { executePending, type PendingExecution } from "./council.js";
import { PayeeRegistry } from "./payee.js";
import type { Proposal } from "./proposal.js";
import { resolveVote, type CouncilOutcome, type MandateContext } from "./council.js";
import { castBallot, compileMandate, hbar, openTally, rulesHash, summarize, TINYBARS_PER_HBAR, type VoteTally } from "./mandate.js";
import { StateStore } from "./store.js";
import { canonical, sha256 } from "./auditlog.js";

function proposal(id: string, payee: string, amount: number, purpose: string, transferPayee?: string, transferAmount?: number): Proposal {
  return {
    id,
    description: { payee, amountTinybars: amount, token: "HBAR", purpose },
    transfer: { payee: transferPayee ?? payee, amountTinybars: transferAmount ?? amount, token: "HBAR" },
    createdAt: new Date().toISOString(),
  };
}

function printScene(n: number, title: string, o: Awaited<ReturnType<typeof processProposal>>): void {
  console.log(`\n--- Scene ${n}: ${title} ---`);
  console.log(`Decision: ${o.decision}`);
  console.log(`Reason: ${o.reason}`);
  console.log(`Mode: ${o.mode}${o.mode === "simulated" ? " (SIMULATED, no real chain ids)" : ""}`);
  console.log(`Check paid via ${o.paidVia}: ${o.paidTxId ?? "none"}${o.paidHashscan ? `  HashScan: ${o.paidHashscan}` : ""}`);
  console.log(`0G verdict [${o.zeroGSource}]: ${o.zeroGVerdictText}`);
  console.log(`0G request id: ${o.zeroGRequestId ?? "none"}`);
  if (o.worldGateReason) console.log(`World ID gate: ${o.worldGateReason}`);
  console.log(`Scheduled tx: ${o.scheduledTxId ?? "none"}${o.scheduleAction ? ` (${o.scheduleAction})` : ""}`);
  console.log(`HCS audit tx: ${o.auditTxId ?? "none"}${o.auditError ? `  (${o.auditError})` : ""}`);
}

async function main(): Promise<void> {
  const env = { ...process.env };
  let server: Server | null = null;
  const real = Boolean(env.HEDERA_ACCOUNT_ID?.trim() && env.HEDERA_PRIVATE_KEY?.trim());
  if (real && !env.CHECK_SERVICE_URL?.trim()) {
    const app = await createApp({ env });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    env.CHECK_SERVICE_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/check`;
  }
  const agent = buildAgent(env);
  const mode = agent.mode;
  // Real transfers need payees that exist; default to the fee account.
  const realPayee = (env.DEMO_PAYEE_ACCOUNT_ID ?? "").trim() || agent.payTo;
  const payee = (n: number) => (mode === "real" ? realPayee : `0.0.100${n}`);
  // Schedules are unique by content, so real runs get fresh ids.
  const tag = mode === "real" ? `-${Date.now().toString(36)}` : "";

  console.log(`hedera-council-agent demo rehearsal, mode=${mode}`);
  console.log(`Check price: ${atomicToUsd(agent.priceAtomic)} via ${agent.payer.via}. Spend cap: ${atomicToUsd(agent.budget.remainingAtomic)}.`);
  if (mode === "real") console.log(`Paid check service: ${agent.checkServiceUrl}, fees to ${agent.payTo}. Treasury: ${agent.hedera.config.treasuryAccountId}.`);

  try {
    const s1 = await processProposal(agent, proposal(`P-001${tag}`, payee(1), 10_000_000, "Pay the venue deposit"), null);
    printScene(1, "Routine proposal, paid check, agent signs", s1);

    const s2 = await processProposal(
      agent,
      proposal(`P-002${tag}`, payee(2), 20_000_000, "Pay the caterer", "0.0.9999", 90_000_000),
      null,
    );
    printScene(2, "Mismatched proposal, paid check, agent refuses", s2);

    const s3 = await processProposal(
      agent,
      proposal(`P-003${tag}`, payee(3), 80_000_000, "Pay the main sponsor grant"),
      mockedWorldCheck(`P-003${tag}`, "approved"),
    );
    printScene(3, "Large proposal, World ID approved (MOCKED), agent signs", s3);

    const s4 = await processProposal(
      agent,
      proposal(`P-004${tag}`, payee(4), 80_000_000, "Pay the main sponsor grant"),
      mockedWorldCheck(`P-004${tag}`, "denied"),
    );
    printScene(4, "Large proposal, World ID denied (MOCKED), agent does not sign", s4);

    // Scene 5: an approval is single use. The server deletes it the moment
    // it backs a signature, so the same proposal resubmitted with yesterday's
    // approval finds none, and the World ID gate refuses.
    const approvals = new ApprovalStore();
    approvals.set(mockedWorldCheck(`P-005${tag}`, "approved"));
    const s5a = await processProposal(agent, proposal(`P-005${tag}`, payee(1), 80_000_000, "Pay the main sponsor grant"), approvals.get(`P-005${tag}`));
    if (s5a.usedWorldApproval) approvals.delete(`P-005${tag}`);
    console.log(`\nScene 5 setup: P-005 signed on a World ID approval (MOCKED): ${s5a.decision}. The approval is now spent.`);
    const s5 = await processProposal(agent, s5a.proposal, approvals.get(`P-005${tag}`));
    printScene(5, "Reuse of yesterday's World approval is refused", s5);

    // Scene 6: same amount, same description as scene 1, but the 402 offer
    // names a different recipient than the registered check service.
    const spendBefore = agent.budget.remainingAtomic;
    const checkService = mode === "real" ? agent.payTo : "0.0.7000";
    const swapAgent = {
      ...agent,
      payer: new SimulatedCheckPayer(agent.hedera, agent.priceAtomic, { expectedPayTo: checkService, offeredPayTo: "0.0.6666" }),
    };
    const s6 = await processProposal(swapAgent, proposal(`P-006${tag}`, payee(1), 10_000_000, "Pay the venue deposit"), null);
    printScene(6, "Same amount, same description, swapped recipient in the 402: refused before paying", s6);
    console.log(`Spent on this check: ${atomicToUsd(spendBefore - agent.budget.remainingAtomic)}. The amount was right. The recipient was a lie.`);

    // Scene 7: 0G cannot be reached (nothing listens on port 9). A verdict is
    // part of the decision record, so no verdict means no signature.
    const noZeroG = { ...agent, zeroG: { ...agent.zeroG, apiKey: "demo-unreachable-key", baseUrl: "http://127.0.0.1:9" }, allowNo0G: false };
    const s7 = await processProposal(noZeroG, proposal(`P-007${tag}`, payee(1), 10_000_000, "Pay the venue deposit"), null);
    printScene(7, "0G unavailable: the agent fails closed", s7);

    // Scene 8: a 600 second challenge window on a fake clock (no sleeping).
    // Each proposal gets its own one-entry payee registry, so revoking one payee
    // cannot touch the other scenes (in real mode every scene pays the same account).
    let clock = new Date();
    const windowed = (account: string) => ({
      ...agent,
      challengeWindowSeconds: 600,
      now: () => clock,
      payees: new PayeeRegistry([{ account, label: "demo payee" }], { source: "env" }),
    });
    const pend = (o: Awaited<ReturnType<typeof processProposal>>): PendingExecution => ({ outcome: o, challengeUntil: o.challengeUntil ?? "", challenged: false, createdEpoch: 1 });
    const aw = windowed(payee(8));
    const s8 = await processProposal(aw, proposal(`P-008${tag}`, payee(8), 10_000_000, "Pay the venue deposit"), null);
    printScene(8, "Challenge window: payee revoked during the window, execution aborts", s8);
    console.log(`Window: PROPOSAL P-008${tag} CREATED, challenge until ${s8.challengeUntil}. Not signed yet.`);
    aw.payees.revoke(payee(8), clock);
    console.log(`Payee ${payee(8)} revoked during the window.`);
    clock = new Date(clock.getTime() + 601_000);
    const x8 = await executePending(aw, pend(s8), { currentEpoch: 1, approval: null });
    const s8x = x8.kind === "done" ? x8.outcome : null;
    console.log(s8x ? `Execution: ${s8x.reason}` : `Execution did not run: ${x8.kind}`);

    clock = new Date();
    const ap = windowed(payee(9));
    const s8b = await processProposal(ap, proposal(`P-009${tag}`, payee(9), 10_000_000, "Pay the venue deposit"), null);
    console.log(`\nSecond proposal P-009${tag}: ${s8b.decision}, challenge until ${s8b.challengeUntil}. Executing too early:`);
    const early = await executePending(ap, pend(s8b), { currentEpoch: 1, approval: null });
    console.log(`  ${early.kind}${early.kind === "too-early" ? `, ${early.secondsRemaining}s remaining` : ""}`);
    clock = new Date(clock.getTime() + 601_000);
    const x9 = await executePending(ap, pend(s8b), { currentEpoch: 1, approval: null });
    const s8c = x9.kind === "done" ? x9.outcome : null;
    console.log(`  After the window, re-checked at execution: ${s8c?.decision ?? x9.kind}. Scheduled tx ${s8c?.scheduledTxId ?? "none"}`);

    // Scenes 9-12: standing instruction and council votes. Their own spend cap
    // (the same size as the agent's), so the earlier scenes cannot starve them.
    const ma = { ...agent, budget: new SpendingCap(usdcToAtomic(agent.spendCapUsd)) };
    const council = new StateStore(null);
    const members = ["asha", "bilal", "chen"].map((n) => council.addSeat(`mock:demo-${n}`, "mocked")!);
    const unit = mode === "real" ? TINYBARS_PER_HBAR / 100 : TINYBARS_PER_HBAR; // real runs move 1/100 of the HBAR
    const allowedA = payee(1);
    const allowedB = mode === "real" ? realPayee : "0.0.1002";
    const newPayee = mode === "real" ? (env.DEMO_NEW_PAYEE_ACCOUNT_ID ?? "").trim() || agent.hedera.config.accountId : "0.0.1003";
    const text = `Pay ${allowedA}${allowedB !== allowedA ? ` or ${allowedB}` : ""} up to ${(50 * unit) / TINYBARS_PER_HBAR} HBAR each, at most ${(100 * unit) / TINYBARS_PER_HBAR} HBAR a month. Anything else goes to the council.`;
    const compiled = await compileMandate(text, agent.zeroG);
    console.log(`\n--- Scene 9: Owner instruction compiled and adopted by the council ---`);
    console.log(`Instruction: "${text}"`);
    let adopted = false;
    let ctx: MandateContext | null = null;
    if (!compiled.ok) console.log(`Compile failed (fail closed): ${compiled.error}`);
    else {
      console.log(`Compiled by ${compiled.source === "0g" ? `0G, request ${compiled.requestId ?? "none"}` : "the SIMULATED parser (no ZERO_G_API_KEY)"}:`);
      for (const line of summarize(compiled.rules)) console.log(`  - ${line}`);
      let tally: VoteTally = openTally(members.map((m) => m.seat));
      for (const [m, choice] of [[members[0]!, "yes"], [members[1]!, "yes"]] as const) {
        const c = castBallot(tally, { seat: m.seat, choice, at: new Date().toISOString(), source: "mocked" }, "M-1");
        if (c.ok) tally = c.tally;
        console.log(`  ${m.seat} (MOCKED) voted ${choice}: ${tally.yes} of ${tally.needed} needed`);
      }
      adopted = tally.status === "passed";
      const hash = rulesHash(compiled.rules);
      const logged = adopted
        ? await ma.hedera.auditEntry({ proposalId: "M-1", event: "MANDATE_ADOPTED", detail: `Standing instruction M-1 adopted by the council (${tally.yes} of ${tally.eligible.length}).`, at: new Date().toISOString(), meta: { rulesHash: hash, textHash: sha256(text) } }).catch(() => null)
        : null;
      console.log(`Adopted: ${adopted ? "yes" : "no"}. rulesHash ${hash} (sha256 of ${canonical(compiled.rules).length} bytes of canonical rules). HCS entry ${logged?.entry.seq ?? "none"}.`);
      if (adopted) ctx = { id: "M-1", rulesHash: hash, rules: compiled.rules, spentThisMonthTinybars: 0, seats: members.map((m) => m.seat) };
    }
    const withSpend = (): MandateContext | null => (ctx ? { ...ctx, spentThisMonthTinybars: council.spentThisMonth(new Date()) } : null);
    const record = (o: CouncilOutcome) => {
      if (o.decision === "SIGNED") council.recordSpend({ proposalId: o.proposal.id, amountTinybars: o.proposal.transfer.amountTinybars, at: new Date().toISOString() });
    };
    const voteOn = async (o: CouncilOutcome, choices: Array<"yes" | "no">) => {
      let tally = o.vote!;
      for (const [i, choice] of choices.entries()) {
        const c = castBallot(tally, { seat: members[i]!.seat, choice, at: new Date().toISOString(), source: "mocked" }, o.proposalId);
        if (c.ok) tally = c.tally;
        console.log(`  ${members[i]!.seat} (MOCKED) voted ${choice}: ${tally.yes} yes, ${tally.no} no, ${tally.needed} needed`);
      }
      return resolveVote(ma, o, tally, { createdEpoch: 1, currentEpoch: 1 });
    };

    const s10 = await processProposal(ma, proposal(`P-010${tag}`, allowedA, 50 * unit, "Pay the venue balance"), null, withSpend());
    record(s10);
    printScene(10, `A ${hbar(50 * unit)} payment inside the instruction: signed, no vote, no World ID check`, s10);

    const s11 = await processProposal(ma, proposal(`P-011${tag}`, newPayee, 30 * unit, "Pay the new AV vendor"), null, withSpend());
    printScene(11, "A payment to a payee new to the instruction opens a council vote", s11);
    const feeBefore = ma.budget.spentAtomic;
    const s11v = s11.decision === "PENDING_VOTE" ? await voteOn(s11, ["yes", "yes"]) : s11;
    record(s11v);
    const voteFee = ma.budget.spentAtomic - feeBefore;
    console.log(`After the vote: ${s11v.decision}. ${s11v.reason}`);
    console.log(`Check fee paid during the vote: ${atomicToUsd(voteFee)} (the check was paid once, ${s11v.paidTxId ?? "none"}).`);

    const s12 = await processProposal(ma, proposal(`P-012${tag}`, allowedB, 40 * unit, "Pay the caterer"), null, withSpend());
    printScene(12, `A payment over the monthly cap (${hbar(council.spentThisMonth(new Date()))} spent) opens a vote`, s12);
    const s12v = s12.decision === "PENDING_VOTE" ? await voteOn(s12, ["no", "no"]) : s12;
    console.log(`After the vote: ${s12v.decision}. ${s12v.reason}`);

    const passed =
      s1.decision === "SIGNED" && s2.decision === "REFUSED" && s2.checkMatches === false &&
      s3.decision === "SIGNED" && s4.decision === "REFUSED" && s4.worldGateReason !== null &&
      s5a.decision === "SIGNED" && s5a.usedWorldApproval && s5.decision === "REFUSED" && s5.worldGateReason !== null &&
      s6.decision === "REFUSED" && s6.paidTxId === null && /402 offer asks to pay/.test(s6.reason) &&
      s7.decision === "REFUSED" && s7.zeroGSource === "unavailable" && /failing closed/.test(s7.reason) &&
      s8.decision === "PENDING_CHALLENGE" && s8.scheduledTxId === (mode === "real" ? s8.proposal.scheduleId : null) &&
      s8x?.decision === "REFUSED" && /^re-checked at execution: payee revoked, ABORTED$/.test(s8x.reason) &&
      s8b.decision === "PENDING_CHALLENGE" && early.kind === "too-early" && s8c?.decision === "SIGNED" &&
      adopted && compiled.ok && compiled.rules.monthlyCapTinybars === 100 * unit &&
      s10.decision === "SIGNED" && s10.mandate?.within === true && !s10.usedWorldApproval &&
      s11.decision === "PENDING_VOTE" && s11.mandate?.within === false && s11v.decision === "SIGNED" &&
      s11v.paidTxId === s11.paidTxId && voteFee === 0 &&
      s12.decision === "PENDING_VOTE" && /would bring this month to/.test(s12.mandate?.violations.join(" ") ?? "") &&
      s12v.decision === "REFUSED" && s12v.vote?.status === "failed";
    console.log(`\nRehearsal: ${passed ? "ALL 12 SCENES CORRECT" : "FAILED, check the scenes above"}`);
    if (!passed) process.exitCode = 1;
  } finally {
    server?.close();
    agent.hedera.close();
  }
}

await main();
