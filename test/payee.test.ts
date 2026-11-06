// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// Payee registry, 402 payTo check, 0G fail-closed and anchored verdicts.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, sealEntry, verifyChain, EMPTY_HEAD, MAX_ENTRY_BYTES, type ChainedEntry } from "../src/auditlog.js";
import { SpendingCap } from "../src/budget.js";
import { processProposal, verdictProblem, type CouncilAgent } from "../src/council.js";
import { HederaClient } from "../src/hedera.js";
import { DEMO_PAYEES, PayeeRegistry, loadPayeeRegistry, sameAccount } from "../src/payee.js";
import { SimulatedCheckPayer } from "../src/payment.js";
import { proposalFingerprint, type Proposal } from "../src/proposal.js";
import { createApp, buildAgent } from "../src/server.js";
import { loadZeroGConfig } from "../src/zeroG.js";
import { PayeeSwapError, x402Check } from "../src/x402Client.js";
import { mockedWorldCheck } from "../src/world.js";

const REGISTERED = "0.0.5001";
const simHedera = () =>
  new HederaClient({ network: "testnet", accountId: "", privateKey: "", topicId: "", treasuryAccountId: "" }, "simulated");

function makeAgent(over: Partial<CouncilAgent> & { offeredPayTo?: string } = {}): CouncilAgent {
  const hedera = simHedera();
  const { offeredPayTo, ...rest } = over;
  return {
    hedera,
    budget: new SpendingCap(100_000),
    zeroG: loadZeroGConfig({}),
    largeThresholdTinybars: 50_000_000,
    payer: new SimulatedCheckPayer(hedera, 10_000, { expectedPayTo: "0.0.7000", offeredPayTo }),
    ...rest,
  };
}

function prop(id: string, payee = REGISTERED, amount = 10_000_000): Proposal {
  return {
    id,
    description: { payee, amountTinybars: amount, token: "HBAR", purpose: "test" },
    transfer: { payee, amountTinybars: amount, token: "HBAR" },
    createdAt: new Date().toISOString(),
  };
}

const registry = (...entries: ConstructorParameters<typeof PayeeRegistry>[0]) => new PayeeRegistry(entries, { source: "env" });

async function log(agent: CouncilAgent) {
  return (await agent.hedera.readAuditLog()).messages as ChainedEntry[];
}

// --- 402 payTo: the seller's answer is untrusted ---

test("a swapped payTo in the 402 is refused before paying, budget unchanged, and logged", async () => {
  const agent = makeAgent({ offeredPayTo: "0.0.6666" });
  const before = agent.budget.remainingAtomic;
  const o = await processProposal(agent, prop("S-1"), null);
  assert.equal(o.decision, "REFUSED");
  assert.equal(o.reason, "The 402 offer asks to pay 0.0.6666, not the registered check service 0.0.7000");
  assert.equal(o.paidTxId, null);
  assert.equal(agent.budget.remainingAtomic, before);
  const entries = await log(agent);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.event, "REFUSED_PAYEE_SWAP");
  assert.match(entries[0]!.detail, /not the registered check service/);
});

test("the registered payTo is paid as before", async () => {
  const agent = makeAgent({ offeredPayTo: "0.0.7000" });
  const o = await processProposal(agent, prop("S-2"), null);
  assert.equal(o.decision, "SIGNED");
  assert.ok(o.paidTxId?.startsWith("SIM-PAY-"));
  assert.ok(agent.budget.remainingAtomic < 100_000);
});

test("account ids compare by shard.realm.num, checksum ignored", () => {
  assert.equal(sameAccount("0.0.123", "0.0.123"), true);
  assert.equal(sameAccount("0.0.123-abcde", "0.0.123"), true);
  assert.equal(sameAccount("0.0.123", "0.0.124"), false);
  assert.equal(sameAccount("0.0.123", "alice"), false);
});

// The real x402 client, against a local seller that answers 402 with a
// swapped payTo. The policy must reject it before anything is signed.
async function sellerOffering(payTo: string): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    const required = {
      x402Version: 2,
      error: "Payment required",
      resource: { url: "http://localhost/check" },
      accepts: [
        { scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", amount: "10000", payTo, maxTimeoutSeconds: 60, extra: { feePayer: "0.0.7000" } },
      ],
    };
    res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64"), "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`, hits: () => hits };
}

test("real x402 client: a 402 naming another payTo throws PayeeSwapError without paying", async () => {
  const { PrivateKey } = await import("@hiero-ledger/sdk");
  const seller = await sellerOffering("0.0.6666");
  try {
    await assert.rejects(
      x402Check(seller.url, prop("S-3"), {
        accountId: "0.0.5000",
        privateKey: PrivateKey.generateECDSA().toStringRaw(),
        network: "hedera:testnet",
        maxAmountAtomic: 10_000,
        expectedPayTo: "0.0.7000",
      }),
      (err: unknown) => err instanceof PayeeSwapError && err.offered === "0.0.6666" && err.expected === "0.0.7000" && /not the registered check service/.test(err.message),
    );
    assert.equal(seller.hits(), 1, "only the unpaid request reached the seller");
  } finally {
    seller.server.close();
  }
});

// --- proposal payee registry ---

test("unregistered payee is refused with a logged lookup", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  const o = await processProposal(agent, prop("R-1", "0.0.5002"), null);
  assert.equal(o.decision, "REFUSED");
  assert.equal(o.reason, "Recipient 0.0.5002 is not in the council payee registry.");
  const e = (await log(agent)).at(-1)!;
  assert.equal(e.event, "REFUSED_UNREGISTERED_PAYEE");
  assert.match(e.detail, /unregistered/);
  assert.equal(e.meta?.payeeRegistry, "unregistered");
});

test("registered payee signs and the lookup result is in the entry", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  const o = await processProposal(agent, prop("R-2"), null);
  assert.equal(o.decision, "SIGNED");
  const e = (await log(agent)).at(-1)!;
  assert.equal(e.meta?.payeeRegistry, "registered");
  assert.match(e.detail, /Payee registry: registered/);
});

test("an expired or not-yet-valid registry entry is refused", async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const expired = makeAgent({ payees: registry({ account: REGISTERED, label: "venue", validUntil: past }) });
  const o = await processProposal(expired, prop("R-3"), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /not in the council payee registry \(its entry expired/);
  assert.equal((await log(expired)).at(-1)!.meta?.payeeRegistry, "expired");
  const early = makeAgent({ payees: registry({ account: REGISTERED, label: "venue", validFrom: future }) });
  const o2 = await processProposal(early, prop("R-4"), null);
  assert.equal(o2.decision, "REFUSED");
  assert.equal((await log(early)).at(-1)!.meta?.payeeRegistry, "not-yet-valid");
});

test("a mismatch still refuses as a mismatch, and runs before the registry", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  const p = prop("R-5");
  p.transfer.payee = "0.0.9999";
  const o = await processProposal(agent, p, null);
  assert.equal((await log(agent)).at(-1)!.event, "REFUSED_MISMATCH");
  assert.equal(o.checkMatches, false);
});

test("an empty registry that is not required leaves the old behaviour", async () => {
  const agent = makeAgent({ payees: new PayeeRegistry([], { source: "empty" }) });
  const o = await processProposal(agent, prop("R-6", "0.0.424242"), null);
  assert.equal(o.decision, "SIGNED");
  assert.equal((await log(agent)).at(-1)!.meta?.payeeRegistry, "not-enforced");
  // No registry object at all behaves the same.
  assert.equal((await processProposal(makeAgent(), prop("R-7", "0.0.424242"), null)).decision, "SIGNED");
});

test("REQUIRE_REGISTERED_PAYEE=true enforces even an empty registry", async () => {
  const reg = loadPayeeRegistry({ REQUIRE_REGISTERED_PAYEE: "true" });
  assert.equal(reg.enforce, true);
  const o = await processProposal(makeAgent({ payees: reg }), prop("R-8"), null);
  assert.equal(o.decision, "REFUSED");
});

test("registry sits before the World gate: an unregistered large payee refuses without needing World ID", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  const o = await processProposal(agent, prop("R-9", "0.0.5002", 80_000_000), mockedWorldCheck("R-9", "approved"));
  assert.equal(o.decision, "REFUSED");
  assert.equal(o.worldGateReason, null);
  assert.equal(o.usedWorldApproval, false);
});

test("registry loads from env (JSON or comma list); the demo list only as a fallback", () => {
  const csv = loadPayeeRegistry({ PAYEE_REGISTRY: "0.0.1, 0.0.2" });
  assert.deepEqual(csv.entries.map((e) => e.account), ["0.0.1", "0.0.2"]);
  assert.equal(csv.source, "env");
  const json = loadPayeeRegistry({ PAYEE_REGISTRY: JSON.stringify([{ account: "0.0.3", label: "x", validUntil: "2099-01-01T00:00:00Z" }]) });
  assert.equal(json.lookup("0.0.3").status, "registered");
  assert.throws(() => loadPayeeRegistry({ PAYEE_REGISTRY: "alice" }));
  assert.equal(loadPayeeRegistry({}, DEMO_PAYEES).source, "demo registry");
  assert.equal(loadPayeeRegistry({}).source, "empty");
  assert.equal(loadPayeeRegistry({ PAYEE_REGISTRY: "0.0.9" }, DEMO_PAYEES).source, "env");
});

// --- 0G fails closed ---

async function withFailing0G<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("0G key set but the call fails: the agent refuses and logs REFUSED_NO_VERDICT", async () => {
  await withFailing0G(async () => {
    const agent = makeAgent({ zeroG: loadZeroGConfig({ ZERO_G_API_KEY: "sk-test" }) });
    const o = await processProposal(agent, prop("Z-1"), null);
    assert.equal(o.decision, "REFUSED");
    assert.equal(o.reason, "0G verdict unavailable, failing closed (network down)");
    assert.equal(o.zeroGSource, "unavailable");
    assert.ok(o.paidTxId, "the check was paid; the signature is what is withheld");
    const e = (await log(agent)).at(-1)!;
    assert.equal(e.event, "REFUSED_NO_VERDICT");
    assert.equal(e.meta?.zeroGRequestId, null);
  });
});

test("ALLOW_NO_0G overrides the refusal and says so in the log", async () => {
  await withFailing0G(async () => {
    const agent = makeAgent({ zeroG: loadZeroGConfig({ ZERO_G_API_KEY: "sk-test" }), allowNo0G: true });
    const o = await processProposal(agent, prop("Z-2"), null);
    assert.equal(o.decision, "SIGNED");
    assert.match((await log(agent)).at(-1)!.detail, /ALLOW_NO_0G is on/);
  });
});

test("simulated mode with no key keeps its labelled verdict; a required verdict refuses", async () => {
  const open = await processProposal(makeAgent(), prop("Z-3"), null);
  assert.equal(open.decision, "SIGNED");
  assert.equal(open.zeroGSource, "simulated");
  assert.match(open.zeroGVerdictText, /^\[SIMULATED 0G verdict\]/);
  const strict = makeAgent({ requireVerdict: true });
  const o = await processProposal(strict, prop("Z-4"), null);
  assert.equal(o.decision, "REFUSED");
  assert.match(o.reason, /failing closed: no ZERO_G_API_KEY/);
  assert.equal((await log(strict)).at(-1)!.event, "REFUSED_NO_VERDICT");
  assert.equal((await processProposal(makeAgent({ requireVerdict: true, allowNo0G: true }), prop("Z-5"), null)).decision, "SIGNED");
});

test("real Hedera mode with no 0G key refuses unless overridden (pure rule)", () => {
  const real = new HederaClient({ network: "testnet", accountId: "0.0.5", privateKey: "k", topicId: "", treasuryAccountId: "0.0.5" }, "real");
  const sim = { text: "[SIMULATED 0G verdict] x", requestId: null, model: "m", source: "simulated" as const };
  const live = { text: "ok", requestId: "r-1", model: "m", source: "0g" as const };
  const down = { text: "[0G verdict unavailable: boom] x", requestId: null, model: "m", source: "unavailable" as const };
  assert.match(verdictProblem({ hedera: real }, sim) ?? "", /failing closed: no ZERO_G_API_KEY/);
  assert.equal(verdictProblem({ hedera: real, allowNo0G: true }, sim), null);
  assert.equal(verdictProblem({ hedera: real }, live), null);
  assert.match(verdictProblem({ hedera: simHedera() }, down) ?? "", /^0G verdict unavailable, failing closed/);
  assert.equal(verdictProblem({ hedera: simHedera() }, sim), null);
  assert.equal(verdictProblem({ hedera: simHedera(), allowNo0G: true }, down), null);
});

test("buildAgent: real mode requires a verdict, simulated mode does not, ALLOW_NO_0G is read", () => {
  const sim = buildAgent({}, 0);
  assert.equal(sim.requireVerdict, false);
  assert.equal(sim.allowNo0G, false);
  assert.equal(sim.payees.source, "demo registry");
  const real = buildAgent({ HEDERA_ACCOUNT_ID: "0.0.5", HEDERA_PRIVATE_KEY: "ab".repeat(32), ALLOW_NO_0G: "true" }, 0);
  assert.equal(real.requireVerdict, true);
  assert.equal(real.allowNo0G, true);
  assert.equal(real.payees.enforce, false, "real mode has no demo registry");
});

// --- anchoring ---

test("every decision entry carries anchors that match the proposal and the verdict", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  const p = prop("M-1");
  const o = await processProposal(agent, p, null);
  const e = (await log(agent))[0]!;
  const proposalHash = sha256(proposalFingerprint(o.proposal));
  assert.equal(e.meta?.proposalHash, proposalHash);
  assert.equal(e.meta?.verdictHash, sha256(o.zeroGVerdictText + proposalHash));
  assert.equal(e.meta?.zeroGModel, null, "a simulated verdict is not attributed to a 0G model");
  assert.equal(e.meta?.payeeRegistry, "registered");
  // A refusal carries them too.
  await processProposal(agent, prop("M-2", "0.0.5002"), null);
  const refused = (await log(agent))[1]!;
  assert.ok(refused.meta?.verdictHash && refused.meta.proposalHash);
});

test("a live 0G verdict is anchored with its request id and model", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ x_0g_trace: { request_id: "req-123" }, choices: [{ message: { content: "Looks right." } }] }), { status: 200 })) as typeof fetch;
  try {
    const agent = makeAgent({ zeroG: loadZeroGConfig({ ZERO_G_API_KEY: "sk-test" }) });
    const o = await processProposal(agent, prop("M-3"), null);
    assert.equal(o.decision, "SIGNED");
    const e = (await log(agent))[0]!;
    assert.equal(e.meta?.zeroGRequestId, "req-123");
    assert.equal(e.meta?.zeroGModel, "0gm-1.0-35b-a3b");
    assert.equal(e.meta?.verdictHash, sha256("Looks right." + e.meta?.proposalHash));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain with meta verifies, tampering with meta is detected, and the browser verifier agrees", async () => {
  const agent = makeAgent({ payees: registry({ account: REGISTERED, label: "venue" }) });
  await processProposal(agent, prop("V-1"), null);
  await processProposal(agent, prop("V-2", "0.0.5002"), null);
  await processProposal(agent, prop("V-3"), null);
  const entries = await log(agent);
  assert.ok(entries.every((e) => e.meta));
  const node = verifyChain(entries);
  assert.equal(node.ok, true);
  assert.equal(node.checked, 3);
  const browser = (await import(pathToFileURL(join(process.cwd(), "public/assets/chain-verify.js")).href)) as {
    verifyChainAsync(m: unknown[]): Promise<{ ok: boolean; head: { seq: number; hash: string } | null }>;
  };
  const b = await browser.verifyChainAsync(entries);
  assert.equal(b.ok, true);
  assert.equal(b.head?.hash, node.head?.hash);
  const tampered = entries.map((e, i) => (i === 1 ? { ...e, meta: { ...e.meta, payeeRegistry: "registered" } } : e));
  assert.equal(verifyChain(tampered).ok, false);
  assert.equal((await browser.verifyChainAsync(tampered)).ok, false);
});

test("entries without meta from older logs still verify", () => {
  const a = sealEntry(EMPTY_HEAD, { proposalId: "O-1", event: "SIGNED", detail: "d", at: "t", policy: "p" });
  assert.equal("meta" in a, false);
  assert.equal(verifyChain([a]).ok, true);
});

test("a worst-case entry stays under the HCS message limit", () => {
  const meta = {
    zeroGRequestId: "r".repeat(80),
    zeroGModel: "m".repeat(48),
    verdictHash: "f".repeat(64),
    proposalHash: "f".repeat(64),
    payeeRegistry: "not-yet-valid",
  };
  for (const detail of ["x".repeat(400), "\u20ac".repeat(400), "\u{1F600}".repeat(200)]) {
    const e = sealEntry({ seq: 123456, hash: "f".repeat(64) }, { proposalId: "P".repeat(64), event: "REFUSED_UNREGISTERED_PAYEE", detail, at: "2026-11-06T00:00:00.000Z", policy: "f".repeat(64), meta });
    const bytes = Buffer.byteLength(JSON.stringify(e));
    assert.ok(bytes < MAX_ENTRY_BYTES + 1 && bytes < 1024, `entry is ${bytes} bytes`);
  }
  // A typical decision keeps all of its detail.
  const typical = sealEntry(EMPTY_HEAD, { proposalId: "P-001", event: "SIGNED", detail: "x".repeat(150), at: "t", policy: "f".repeat(64), meta });
  assert.equal(typical.detail.length, 150);
});

// --- server wiring ---

test("simulated server: demo registry covers the demo payees, is labelled, and refuses others", async () => {
  const app = await createApp({ statePath: null, env: {} });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
  try {
    const payees = await get("/payees");
    assert.equal(payees.source, "demo registry");
    assert.equal(payees.enforce, true);
    for (const a of ["0.0.1001", "0.0.1002", "0.0.1003", "0.0.1004", "0.0.6666"]) assert.ok(payees.payees.some((p: any) => p.account === a));
    assert.match((await get("/health")).payeeRegistry, /^demo registry/);
    const pol = await get("/policy");
    assert.equal(pol.policy.payees.source, "demo registry");
    assert.ok(pol.policy.rules.some((r: string) => /Fail closed/.test(r)));
    const post = (id: string, payee: string) =>
      fetch(base + "/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposal: prop(id, payee) }) }).then((r) => r.json() as Promise<any>);
    assert.equal((await post("W-1", "0.0.1001")).decision, "SIGNED");
    const other = await post("W-2", "0.0.424242");
    assert.equal(other.decision, "REFUSED");
    assert.match(other.reason, /not in the council payee registry/);
  } finally {
    server.close();
  }
});

test("the policy hash commits to the payee registry and the 0G rule", async () => {
  const hashFor = async (env: NodeJS.ProcessEnv) => {
    const app = await createApp({ statePath: null, env });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      return ((await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/policy`)).json()) as { hash: string }).hash;
    } finally {
      server.close();
    }
  };
  const base = await hashFor({});
  assert.notEqual(base, await hashFor({ PAYEE_REGISTRY: "0.0.1001" }));
  assert.notEqual(base, await hashFor({ ALLOW_NO_0G: "true" }));
});
