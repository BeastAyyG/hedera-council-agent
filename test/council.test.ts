// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
import test from "node:test";
import assert from "node:assert/strict";
import { SpendingCap } from "../src/budget.js";
import { checkProposal } from "../src/checker.js";
import { processProposal } from "../src/council.js";
import { HederaClient } from "../src/hedera.js";
import { SimulatedCheckPayer, type CheckPayer } from "../src/payment.js";
import { validateProposal } from "../src/proposal.js";
import { loadZeroGConfig, zeroGVerdict } from "../src/zeroG.js";
import { mockedWorldCheck, worldGate } from "../src/world.js";
import type { Proposal } from "../src/proposal.js";

const simHedera = () =>
  new HederaClient(
    { network: "testnet", accountId: "", privateKey: "", topicId: "", treasuryAccountId: "", topicAdminKey: "" },
    "simulated",
  );

// Prices are USDC atomic units: $0.01 = 10000, cap $0.10.
function makeAgent() {
  const hedera = simHedera();
  return {
    hedera,
    budget: new SpendingCap(100_000),
    zeroG: loadZeroGConfig({}),
    largeThresholdTinybars: 50_000_000,
    payer: new SimulatedCheckPayer(hedera, 10_000) as CheckPayer,
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
  agent.budget = new SpendingCap(5_000);
  const o = await processProposal(agent, prop("T-10", 10_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /Spending cap/);
  assert.equal(o.paidTxId, null);
});

test("x402 payment failure refuses without signing", async () => {
  const agent = makeAgent();
  agent.payer = {
    via: "x402",
    expectedPayTo: "0.0.0",
    priceAtomic: 10_000,
    payForCheck: async () => ({ ok: false, paymentId: null, via: "x402", error: "facilitator down" }),
  };
  const o = await processProposal(agent, prop("T-11", 10_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /facilitator down/);
  assert.equal(agent.budget.spentAtomic, 0);
});

test("paid check that disagrees with the local check refuses", async () => {
  const agent = makeAgent();
  agent.payer = {
    via: "simulated",
    expectedPayTo: "0.0.0",
    priceAtomic: 10_000,
    payForCheck: async (p) => ({
      ok: true,
      paymentId: agent.hedera.simId("PAY"),
      via: "simulated",
      remoteCheck: { proposalId: p.id, matches: false, mismatches: [], verdict: "remote says no" },
    }),
  };
  const o = await processProposal(agent, prop("T-12", 10_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /disagrees/);
});

test("0G outage is recorded, not fatal", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const v = await zeroGVerdict(loadZeroGConfig({ ZERO_G_API_KEY: "sk-test" }), {
      proposalId: "T-13", checkVerdict: "ok", matches: true, amountTinybars: 1, payee: "0.0.1",
    });
    assert.equal(v.source, "unavailable");
    assert.equal(v.requestId, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("validateProposal rejects malformed input", () => {
  assert.equal(validateProposal(null).ok, false);
  assert.equal(validateProposal({ ...prop("T-14", 1), id: "bad id!" }).ok, false);
  assert.equal(validateProposal({ ...prop("T-14", 1), transfer: { payee: "alice", amountTinybars: 1, token: "HBAR" } }).ok, false);
  assert.equal(validateProposal({ ...prop("T-14", 0) }).ok, false);
  assert.equal(validateProposal(prop("T-14", 5)).ok, true);
});

test("raw hex keys parse as ECDSA, DER keys keep their type", async () => {
  const { PrivateKey } = await import("@hiero-ledger/sdk");
  const { parsePrivateKey } = await import("../src/keys.js");
  const ecdsa = PrivateKey.generateECDSA();
  assert.equal(parsePrivateKey(ecdsa.toStringRaw()).publicKey.toStringRaw(), ecdsa.publicKey.toStringRaw());
  assert.equal(parsePrivateKey(`0x${ecdsa.toStringRaw()}`).publicKey.toStringRaw(), ecdsa.publicKey.toStringRaw());
  const ed = PrivateKey.generateED25519();
  assert.equal(parsePrivateKey(ed.toStringDer()).publicKey.toStringRaw(), ed.publicKey.toStringRaw());
  assert.equal(parsePrivateKey(ed.toStringRaw(), "ed25519").publicKey.toStringRaw(), ed.publicKey.toStringRaw());
});

test("mirror decoder reads the transfer an SDK-built schedule will execute", async () => {
  const sdk = await import("@hiero-ledger/sdk");
  const { decodeScheduledTransfer } = await import("../src/mirror.js");
  const { proto } = await import("@hiero-ledger/proto");
  // The same encoding the network stores for a schedule's transaction_body.
  const body = (tx: InstanceType<typeof sdk.TransferTransaction>) =>
    Buffer.from(proto.SchedulableTransactionBody.encode(tx._getScheduledTransactionBody()).finish()).toString("base64");
  const ok = new sdk.TransferTransaction()
    .addHbarTransfer("0.0.1000", sdk.Hbar.fromTinybars(-5_000))
    .addHbarTransfer("0.0.1001", sdk.Hbar.fromTinybars(5_000));
  const d = decodeScheduledTransfer(body(ok));
  assert.equal(d.problem, null);
  assert.deepEqual(d.transfer, { from: "0.0.1000", payee: "0.0.1001", amountTinybars: 5_000, token: "HBAR" });
  const split = new sdk.TransferTransaction()
    .addHbarTransfer("0.0.1000", sdk.Hbar.fromTinybars(-5_000))
    .addHbarTransfer("0.0.1001", sdk.Hbar.fromTinybars(2_500))
    .addHbarTransfer("0.0.9999", sdk.Hbar.fromTinybars(2_500));
  assert.match(decodeScheduledTransfer(body(split)).problem ?? "", /exactly one sender/);
});

// --- real-mode council logic against an injected chain (no network) ---
import type { ChainPort } from "../src/chain.js";
import { scheduleProblem } from "../src/chain.js";
import type { OnChainSchedule } from "../src/mirror.js";

const chainSchedule = (over: Partial<OnChainSchedule> = {}, transfer = { from: "0.0.5000", payee: "0.0.1001", amountTinybars: 10_000_000 }): OnChainSchedule => ({
  scheduleId: "0.0.7777", memo: "", creator: "0.0.6000", payer: "0.0.6000", executed: false, deleted: false, signedBy: 1,
  hbarTransfers: [], transfer: { ...transfer, token: "HBAR" }, problem: null, ...over,
});

function agentWithChain(schedule: OnChainSchedule | Error) {
  const signed: string[] = [];
  const chain: ChainPort = {
    resolve: async () => { if (schedule instanceof Error) throw schedule; return schedule; },
    sign: async (id) => { signed.push(id); return { scheduleId: id, action: "signed" }; },
  };
  const agent = { ...makeAgent(), chain };
  agent.hedera.config.treasuryAccountId = "0.0.5000";
  return { agent, signed };
}

test("chain: the agent checks the transfer on Hedera, not the one in the request", async () => {
  // The request claims a matching transfer, but the schedule pays someone else.
  const { agent, signed } = agentWithChain(chainSchedule({}, { from: "0.0.5000", payee: "0.0.9999", amountTinybars: 10_000_000 }));
  const o = await processProposal(agent, prop("C-1", 10_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.equal(o.checkMatches, false);
  assert.equal(o.transferSource, "hedera-mirror-node");
  assert.equal(o.proposal.transfer.payee, "0.0.9999");
  assert.deepEqual(signed, []);
});

test("chain: a matching schedule is co-signed", async () => {
  const { agent, signed } = agentWithChain(chainSchedule());
  const o = await processProposal(agent, prop("C-2", 10_000_000), null);
  assert.equal(o.decision, "SIGNED");
  assert.equal(o.scheduledTxId, "0.0.7777");
  assert.deepEqual(signed, ["0.0.7777"]);
});

test("chain: a schedule naming a scheduleId only is checked against its description", async () => {
  const { agent } = agentWithChain(chainSchedule({}, { from: "0.0.5000", payee: "0.0.1001", amountTinybars: 90_000_000 }));
  const submitted = { ...prop("C-3", 10_000_000), scheduleId: "0.0.7777", transferFromChain: true };
  const o = await processProposal(agent, submitted, null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /amountTinybars described as 10000000 but transfer is 90000000/);
});

test("chain: refuses schedules from the wrong treasury, executed, deleted, unreadable", async () => {
  for (const [label, sch, re] of [
    ["wrong treasury", chainSchedule({}, { from: "0.0.4242", payee: "0.0.1001", amountTinybars: 10_000_000 }), /not the council treasury/],
    ["executed", chainSchedule({ executed: true }), /already executed/],
    ["deleted", chainSchedule({ deleted: true }), /deleted/],
    ["not a transfer", chainSchedule({ transfer: null, problem: "The scheduled transaction is not a crypto transfer." }), /not a crypto transfer/],
    ["unreadable", new Error("Mirror node has no schedule 0.0.7777 (HTTP 404)."), /Could not read/],
  ] as const) {
    const { agent, signed } = agentWithChain(sch);
    const o = await processProposal(agent, prop(`C-4-${label}`, 10_000_000), null);
    assert.equal(o.decision, "REFUSED", label);
    assert.match(o.reason, re, label);
    assert.equal(o.paidTxId, null, `${label}: no check fee is paid for a schedule that cannot be signed`);
    assert.deepEqual(signed, [], label);
  }
  assert.equal(scheduleProblem(chainSchedule(), "0.0.5000"), null);
});

test("chain: a large matching schedule still needs the World ID gate", async () => {
  const { agent, signed } = agentWithChain(chainSchedule({}, { from: "0.0.5000", payee: "0.0.1001", amountTinybars: 80_000_000 }));
  const o = await processProposal(agent, prop("C-5", 80_000_000), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /World ID/);
  assert.deepEqual(signed, []);
  const ok = await processProposal(agent, prop("C-5", 80_000_000), mockedWorldCheck("C-5", "approved"));
  assert.equal(ok.decision, "SIGNED");
  assert.deepEqual(signed, ["0.0.7777"]);
});

test("a scheduleId without a transfer cannot be signed without Hedera access", async () => {
  const o = await processProposal(makeAgent(), { ...prop("C-6", 10_000_000), scheduleId: "0.0.7777", transferFromChain: true }, null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /no Hedera access/);
});

// --- tamper-evident audit log ---
import { EMPTY_HEAD, sealEntry, verifyChain, canonical, GENESIS } from "../src/auditlog.js";
import { buildPolicy } from "../src/policy.js";
import { fetchTopicMessages, parseMessages } from "../src/mirror.js";

const mk = (n: number) => {
  let head = EMPTY_HEAD;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = sealEntry(head, { proposalId: `P-${i}`, event: "SIGNED", detail: `d${i}`, at: "2026-11-06T00:00:00Z", policy: "ab".repeat(32) });
    out.push(e);
    head = { seq: e.seq, hash: e.hash };
  }
  return out;
};

test("audit chain: an intact log verifies, starts at genesis, ignores foreign messages", () => {
  const log = mk(4);
  assert.equal(log[0]!.prev, GENESIS);
  const r = verifyChain([{ hello: "world" }, null, ...log]);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 4);
  assert.equal(r.ignored, 2);
  assert.equal(r.head?.seq, 4);
});

test("audit chain: edited, dropped, reordered and forged entries are detected", () => {
  const log = mk(5);
  const edited = log.map((e, i) => (i === 2 ? { ...e, detail: "Agent signed a different transfer" } : e));
  assert.match(verifyChain(edited).reason ?? "", /altered/);
  assert.equal(verifyChain(edited).brokenAt, 3);
  const dropped = [log[0]!, log[1]!, log[3]!, log[4]!];
  assert.match(verifyChain(dropped).reason ?? "", /missing or out of order/);
  const swapped = [log[0]!, log[2]!, log[1]!, log[3]!];
  assert.equal(verifyChain(swapped).ok, false);
  // A forged entry that hashes itself correctly but links to nothing real.
  const forged = sealEntry({ seq: 2, hash: "cd".repeat(32) }, { proposalId: "P-X", event: "SIGNED", detail: "x", at: "t", policy: "" });
  assert.match(verifyChain([...log.slice(0, 3), forged]).reason ?? "", /missing or out of order|does not link/);
  const relinked = sealEntry({ seq: 3, hash: "cd".repeat(32) }, { proposalId: "P-X", event: "SIGNED", detail: "x", at: "t", policy: "" });
  assert.match(verifyChain([...log.slice(0, 3), relinked]).reason ?? "", /does not link/);
});

test("audit chain: the simulated agent logs a verifiable chain that commits to the policy", async () => {
  const agent = makeAgent();
  const { hash } = buildPolicy({
    network: "testnet", mode: "simulated", treasury: "simulated",
    signers: { agent: "simulated", proposer: null, threshold: "simulated" },
    largeThresholdTinybars: 50_000_000,
    check: { via: "simulated", priceUsdc: "0.01", spendCapUsdc: "0.10", decidedBy: "deterministic checker" },
    worldGate: { requiredForLarge: true, environment: "production", approvalTtlMinutes: 5, singleUse: true },
    payees: { count: 0, enforce: false, source: "empty" },
    verdict: { zeroG: "not configured", requireVerdict: false, allowNo0G: false },
    transferSource: "request",
  });
  agent.hedera.setPolicy(hash);
  const a = await processProposal(agent, prop("A-1", 10_000_000), null);
  const b = await processProposal(agent, prop("A-2", 10_000_000, "0.0.9999"), null);
  assert.equal(a.auditSeq, 1);
  assert.equal(b.auditSeq, 2);
  const log = await agent.hedera.readAuditLog();
  const r = verifyChain(log.messages);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 2);
  assert.equal(r.head?.hash, b.auditHash);
  assert.ok(log.messages.every((m) => (m as { policy: string }).policy === hash));
});

test("audit chain: concurrent decisions cannot fork the chain", async () => {
  const agent = makeAgent();
  await Promise.all([1, 2, 3, 4, 5].map((i) => processProposal(agent, prop(`K-${i}`, 10_000_000), null)));
  const r = verifyChain((await agent.hedera.readAuditLog()).messages);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 5);
});

test("policy hash is stable and changes with any rule", () => {
  const base = {
    network: "testnet", mode: "real" as const, treasury: "0.0.5", signers: { agent: "0.0.1", proposer: "0.0.2", threshold: "2 of 2" },
    largeThresholdTinybars: 1, check: { via: "x402" as const, priceUsdc: "0.01", spendCapUsdc: "0.10", decidedBy: "deterministic checker" },
    worldGate: { requiredForLarge: true, environment: "production", approvalTtlMinutes: 5, singleUse: true }, transferSource: "hedera-mirror-node" as const,
    payees: { count: 0, enforce: false, source: "empty" }, verdict: { zeroG: "configured", requireVerdict: true, allowNo0G: false },
  };
  assert.equal(buildPolicy(base).hash, buildPolicy(structuredClone(base)).hash);
  assert.notEqual(buildPolicy(base).hash, buildPolicy({ ...base, largeThresholdTinybars: 2 }).hash);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: undefined }] }), '{"a":[2,{"d":1}],"b":1}');
});

test("mirror topic reader follows pagination and treats a missing topic as empty", async () => {
  const page = (msgs: string[], next: string | null) =>
    new Response(JSON.stringify({ messages: msgs.map((m, i) => ({ sequence_number: i + 1, consensus_timestamp: "1.0", message: Buffer.from(m).toString("base64") })), links: { next } }), { status: 200 });
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return String(url).includes("page=2") ? page(['{"b":2}'], null) : page(['{"a":1}', "not json"], "/api/v1/topics/0.0.9/messages?page=2");
  }) as unknown as typeof fetch;
  const r = await fetchTopicMessages("testnet", "0.0.9", { fetchImpl });
  assert.equal(r.messages.length, 3);
  assert.deepEqual(parseMessages(r.messages), [{ a: 1 }, null, { b: 2 }]);
  assert.equal(calls.length, 2);
  const none = await fetchTopicMessages("testnet", "0.0.404", { fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch });
  assert.deepEqual(none, { messages: [], truncated: false });
});
