// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Demo rehearsal: 4 scenes, the exact moments the submission video shows.
// Scene 1: routine proposal, paid check, agent signs.
// Scene 2: mismatched proposal, paid check, agent refuses.
// Scene 3: large proposal, World ID approved, agent signs.
// Scene 4: large proposal, World ID denied, agent does not sign.
import { SpendingCap } from "./budget.js";
import { processProposal } from "./council.js";
import { HederaClient, loadHederaConfig } from "./hedera.js";
import { loadZeroGConfig } from "./zeroG.js";
import { mockedWorldCheck } from "./world.js";
import type { Proposal } from "./proposal.js";

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
  console.log(`Check paid: ${o.paidTxId ?? "none"}${o.paidHashscan ? `  HashScan: ${o.paidHashscan}` : ""}`);
  console.log(`0G verdict [${o.zeroGSource}]: ${o.zeroGVerdictText}`);
  console.log(`0G request id: ${o.zeroGRequestId ?? "none (simulated)"}`);
  if (o.worldGateReason) console.log(`World ID gate: ${o.worldGateReason}`);
  console.log(`Scheduled tx: ${o.scheduledTxId ?? "none"}`);
  console.log(`HCS audit tx: ${o.auditTxId ?? "none"}`);
}

async function main(): Promise<void> {
  const { config, mode } = loadHederaConfig(process.env);
  const agent = {
    hedera: new HederaClient(config, mode),
    budget: new SpendingCap(Number(process.env.AGENT_SPEND_CAP_TINYBARS ?? 1_000_000)),
    zeroG: loadZeroGConfig(process.env),
    largeThresholdTinybars: Number(process.env.LARGE_PROPOSAL_TINYBARS ?? 50_000_000),
    checkPriceTinybars: config.checkPriceTinybars,
    payTo: config.accountId || "0.0.0",
  };
  console.log(`hedera-council-agent demo rehearsal, mode=${mode}`);
  console.log(`Check price: ${agent.checkPriceTinybars} tinybars. Spend cap: ${agent.budget.remainingTinybars} tinybars.`);

  const s1 = await processProposal(
    agent,
    proposal("P-001", "0.0.1001", 10_000_000, "Pay the venue deposit", undefined, undefined),
    null,
  );
  printScene(1, "Routine proposal, paid check, agent signs", s1);

  const s2 = await processProposal(
    agent,
    proposal("P-002", "0.0.1002", 20_000_000, "Pay the caterer", "0.0.9999", 90_000_000),
    null,
  );
  printScene(2, "Mismatched proposal, paid check, agent refuses", s2);

  const s3 = await processProposal(
    agent,
    proposal("P-003", "0.0.1003", 80_000_000, "Pay the main sponsor grant"),
    mockedWorldCheck("P-003", "approved"),
  );
  printScene(3, "Large proposal, World ID approved, agent signs", s3);

  const s4 = await processProposal(
    agent,
    proposal("P-004", "0.0.1004", 80_000_000, "Pay the main sponsor grant"),
    mockedWorldCheck("P-004", "denied"),
  );
  printScene(4, "Large proposal, World ID denied, agent does not sign", s4);

  const passed =
    s1.decision === "SIGNED" && s2.decision === "REFUSED" && s3.decision === "SIGNED" && s4.decision === "REFUSED";
  console.log(`\nRehearsal: ${passed ? "ALL 4 SCENES CORRECT" : "FAILED, check the scenes above"}`);
  if (!passed) process.exitCode = 1;
}

await main();
