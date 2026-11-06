// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
import test from "node:test";
import assert from "node:assert/strict";
import { SpendingCap } from "../src/budget.js";
import { checkProposal } from "../src/checker.js";
import { processProposal } from "../src/council.js";
import { HederaClient } from "../src/hedera.js";
import { loadZeroGConfig } from "../src/zeroG.js";
import { mockedWorldCheck, worldGate } from "../src/world.js";
import type { Proposal } from "../src/proposal.js";

const simHedera = () =>
  new HederaClient(
    { network: "testnet", accountId: "", privateKey: "", topicId: "", checkPriceTinybars: 100000 },
    "simulated",
  );

function makeAgent() {
  return {
    hedera: simHedera(),
    budget: new SpendingCap(1_000_000),
    zeroG: loadZeroGConfig({}),
    largeThresholdTinybars: 50_000_000,
    checkPriceTinybars: 100000,
    payTo: "0.0.1000",
  };
}

function prop(id: string, amount: number, transferPayee?: string, transferAmount?: number): Proposal {
  return {
    id,
    description: { payee: "0.0.1001", amountTinybars: amount, token: "HBAR", purpose: "test" },
    transfer: { payee: transferPayee ?? "0.0.1001", amountTinybars: transferAmount ?? amount, token: "HBAR" },
    createdAt: new Date().toISOString(),
  };
}

test("matching proposal signs", async () => {
  const o = await processProposal(makeAgent(), prop("T-1", 10_000_000), null);
  assert.equal(o.decision, "SIGNED");
  assert.equal(o.checkMatches, true);
});

test("mismatched payee refuses", async () => {
  const o = await processProposal(makeAgent(), prop("T-2", 10_000_000, "0.0.9999"), null);
  assert.equal(o.decision, "REFUSED");
  assert.equal(o.checkMatches, false);
});

test("mismatched amount refuses", async () => {
  const o = await processProposal(makeAgent(), prop("T-3", 10_000_000, undefined, 90_000_000), null);
  assert.equal(o.decision, "REFUSED");
});

test("checker reports the exact mismatch fields", () => {
  const r = checkProposal(prop("T-4", 10_000_000, "0.0.9999", 90_000_000));
  assert.equal(r.matches, false);
  assert.deepEqual(
    r.mismatches.map((m) => m.field).sort(),
    ["amountTinybars", "payee"],
  );
});

test("large proposal without World ID refuses", async () => {
  const o = await processProposal(makeAgent(), prop("T-5", 80_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /World ID/);
});

test("large proposal with denied World ID refuses", async () => {
  const o = await processProposal(makeAgent(), prop("T-6", 80_000_000), mockedWorldCheck("T-6", "denied"));
  assert.equal(o.decision, "REFUSED");
});

test("large proposal with expired World ID refuses", async () => {
  const check = mockedWorldCheck("T-7", "approved", -5);
  assert.equal(worldGate(check, "T-7").allowed, false);
  const o = await processProposal(makeAgent(), prop("T-7", 80_000_000), check);
  assert.equal(o.decision, "REFUSED");
});

test("large proposal with approved World ID signs", async () => {
  const o = await processProposal(makeAgent(), prop("T-8", 80_000_000), mockedWorldCheck("T-8", "approved"));
  assert.equal(o.decision, "SIGNED");
});

test("World ID check for a different proposal refuses", async () => {
  const o = await processProposal(makeAgent(), prop("T-9", 80_000_000), mockedWorldCheck("OTHER", "approved"));
  assert.equal(o.decision, "REFUSED");
});

test("spending cap blocks an over-budget payment", async () => {
  const agent = makeAgent();
  agent.budget = new SpendingCap(50000);
  const o = await processProposal(agent, prop("T-10", 10_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /Spending cap/);
  assert.equal(o.paidTxId, null);
});
