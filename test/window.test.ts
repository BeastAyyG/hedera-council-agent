// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// Challenge window with a re-check at execution, payee revocation, seat
// revocation (epoch), and API key auth. The clock is injected: no sleeps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { hashSignal } from "@worldcoin/idkit-core";
import { SpendingCap } from "../src/budget.js";
import { recheckAtExecution, type RecheckInput } from "../src/challenge.js";
import type { ChainPort } from "../src/chain.js";
import { executePending, processProposal } from "../src/council.js";
import { HederaClient } from "../src/hedera.js";
import { DEMO_PAYEES, loadPayeeRegistry, PayeeRegistry } from "../src/payee.js";
import { SimulatedCheckPayer, type CheckPayer } from "../src/payment.js";
import { buildPolicy } from "../src/policy.js";
import type { Proposal } from "../src/proposal.js";
import { createApp, type AppOptions } from "../src/server.js";
import { StateStore } from "../src/store.js";
import { voteSignal } from "../src/mandate.js";
import { loadZeroGConfig } from "../src/zeroG.js";
import { mockedWorldCheck, verifiedWorldCheck } from "../src/world.js";
import { verifyBundle, type EvidenceBundle, type PublishedPolicy } from "../src/verify.js";
import type { OnChainSchedule } from "../src/mirror.js";

const prop = (id: string, amount = 10_000_000, payee = "0.0.1001"): Proposal => ({
  id,
  description: { payee, amountTinybars: amount, token: "HBAR", purpose: "window test" },
  transfer: { payee, amountTinybars: amount, token: "HBAR" },
  createdAt: new Date().toISOString(),
});

const T0 = new Date("2026-11-06T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function makeAgent(over: Record<string, unknown> = {}) {
  const hedera = new HederaClient({ network: "testnet", accountId: "", privateKey: "", topicId: "", treasuryAccountId: "", topicAdminKey: "" }, "simulated");
  return {
    hedera,
    budget: new SpendingCap(1_000_000),
    zeroG: loadZeroGConfig({}),
    largeThresholdTinybars: 50_000_000,
    payer: new SimulatedCheckPayer(hedera, 10_000) as CheckPayer,
    ...over,
  };
}

const baseRecheck = (over: Partial<RecheckInput> = {}): RecheckInput => ({
  proposal: prop("R-1"),
  payees: new PayeeRegistry([{ account: "0.0.1001", label: "x" }], { source: "env" }),
  largeThresholdTinybars: 50_000_000,
  approval: null,
  challengeUntil: at(600).toISOString(),
  challenged: false,
  createdEpoch: 1,
  currentEpoch: 1,
  now: at(601),
  ...over,
});

// ---- the pure re-check ----

test("recheck: waits for the window, with seconds remaining, using the injected clock", () => {
  const early = recheckAtExecution(baseRecheck({ now: at(100) }));
  assert.equal(early.status, "too-early");
  assert.equal(early.status === "too-early" && early.secondsRemaining, 500);
  assert.equal(recheckAtExecution(baseRecheck({ now: at(600) })).status, "ok");
});

test("recheck: a challenged proposal never executes, even after the window", () => {
  const r = recheckAtExecution(baseRecheck({ challenged: true, challengeReason: "wrong vendor", now: at(9999) }));
  assert.equal(r.status, "challenged");
  assert.match(r.status === "challenged" ? r.reason : "", /wrong vendor/);
});

test("recheck: aborts on a payee revoked in the window, an epoch change, a changed transfer", () => {
  const payees = new PayeeRegistry([{ account: "0.0.1001", label: "x" }], { source: "env" });
  payees.revoke("0.0.1001", at(300));
  const revoked = recheckAtExecution(baseRecheck({ payees }));
  assert.deepEqual(revoked, { status: "aborted", reason: "payee revoked" });
  assert.deepEqual(recheckAtExecution(baseRecheck({ currentEpoch: 2 })), { status: "aborted", reason: "seat revoked / epoch changed" });
  const bad = { ...prop("R-1"), transfer: { payee: "0.0.9999", amountTinybars: 10_000_000, token: "HBAR" as const } };
  const mismatch = recheckAtExecution(baseRecheck({ proposal: bad }));
  assert.equal(mismatch.status, "aborted");
  assert.match(mismatch.status === "aborted" ? mismatch.reason : "", /no longer matches/);
});

test("recheck: a large proposal needs an approval that is still unexpired", () => {
  const large = prop("R-L", 80_000_000);
  const registry = new PayeeRegistry([{ account: "0.0.1001", label: "x" }], { source: "env" });
  const approval = verifiedWorldCheck("R-L", T0); // valid 5 minutes
  const base = { proposal: large, payees: registry, challengeUntil: at(120).toISOString() };
  assert.equal(recheckAtExecution(baseRecheck({ ...base, approval, now: at(121) })).status, "ok");
  const expired = recheckAtExecution(baseRecheck({ ...base, approval, now: at(301) }));
  assert.deepEqual(expired, { status: "aborted", reason: "World ID approval expired during the challenge window" });
  assert.equal(recheckAtExecution(baseRecheck({ ...base, approval: null, now: at(121) })).status, "aborted");
  const other = recheckAtExecution(baseRecheck({ ...base, approval: { ...approval, proposalId: "OTHER" }, now: at(121) }));
  assert.equal(other.status, "aborted");
});

// ---- payee revocation ----

test("payee revoke: status turns revoked, the shared demo list is untouched, a file registry is rewritten", () => {
  const r = new PayeeRegistry(DEMO_PAYEES, { source: "demo registry" });
  assert.equal(r.revoke("0.0.1001", at(1)), 1);
  assert.equal(r.revoke("0.0.1001", at(2)), 0);
  assert.equal(r.revoke("0.0.4242", at(2)), 0);
  assert.equal(r.lookup("0.0.1001", at(5)).status, "revoked");
  assert.equal(r.lookup("0.0.1001", at(0)).status, "registered");
  assert.equal(DEMO_PAYEES[0]!.revokedAt, undefined);
  assert.equal(new PayeeRegistry(DEMO_PAYEES, { source: "demo registry" }).lookup("0.0.1001").status, "registered");

  const file = join(mkdtempSync(join(tmpdir(), "payees-")), "payees.json");
  writeFileSync(file, JSON.stringify([{ account: "0.0.1001", label: "venue" }, "0.0.1002"]));
  const fr = loadPayeeRegistry({ PAYEE_REGISTRY_FILE: file });
  fr.revoke("0.0.1001", at(1));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved[0].revokedAt, at(1).toISOString());
  assert.equal(saved[1].revokedAt, undefined);
  assert.equal(loadPayeeRegistry({ PAYEE_REGISTRY_FILE: file }).lookup("0.0.1001").status, "revoked");
});

// ---- council: window on and off ----

test("window off (default): a passing proposal signs at once, as before", async () => {
  const o = await processProposal(makeAgent(), prop("W-0"), null);
  assert.equal(o.decision, "SIGNED");
  assert.equal(o.challengeUntil, null);
});

test("window on: a passing proposal is PENDING_CHALLENGE and logs PROPOSAL_CREATED; it is not signed", async () => {
  const agent = makeAgent({ challengeWindowSeconds: 600, now: () => T0 });
  const o = await processProposal(agent, prop("W-1"), null);
  assert.equal(o.decision, "PENDING_CHALLENGE");
  assert.equal(o.challengeUntil, at(600).toISOString());
  assert.equal(o.scheduledTxId, null);
  const log = (await agent.hedera.readAuditLog()).messages as Array<{ event: string; detail: string }>;
  assert.equal(log.at(-1)!.event, "PROPOSAL_CREATED");
  assert.equal(log.at(-1)!.detail, `PROPOSAL W-1 CREATED, challenge until ${at(600).toISOString()}`);
  // A refusal inside the window setup is still a refusal, not pending.
  const bad = await processProposal(agent, prop("W-1b", 10_000_000, "0.0.1001"), null);
  assert.equal(bad.decision, "PENDING_CHALLENGE");
  const mismatch = await processProposal(agent, { ...prop("W-1c"), transfer: { payee: "0.0.9999", amountTinybars: 10_000_000, token: "HBAR" } }, null);
  assert.equal(mismatch.decision, "REFUSED");
});

test("window on: a large proposal still needs its World ID approval to be pending, and the approval is not spent", async () => {
  const agent = makeAgent({ challengeWindowSeconds: 120 });
  assert.equal((await processProposal(agent, prop("W-L", 80_000_000), null)).decision, "REFUSED");
  const o = await processProposal(agent, prop("W-L2", 80_000_000), mockedWorldCheck("W-L2", "approved"));
  assert.equal(o.decision, "PENDING_CHALLENGE");
  assert.equal(o.usedWorldApproval, false);
});

test("execute: signs after the window, aborts with ABORTED_AT_EXECUTION when the payee was revoked", async () => {
  let clock = T0;
  const payees = new PayeeRegistry([{ account: "0.0.1001", label: "x" }], { source: "env" });
  const agent = makeAgent({ challengeWindowSeconds: 600, now: () => clock, payees });
  const pend = async (id: string) => {
    const o = await processProposal(agent, prop(id), null);
    return { outcome: o, challengeUntil: o.challengeUntil!, challenged: false, createdEpoch: 1 };
  };
  const ok = await pend("X-1");
  assert.equal((await executePending(agent, ok, { currentEpoch: 1, approval: null })).kind, "too-early");
  clock = at(601);
  const signed = await executePending(agent, ok, { currentEpoch: 1, approval: null });
  assert.equal(signed.kind === "done" && signed.outcome.decision, "SIGNED");
  assert.match(signed.kind === "done" ? (signed.outcome.scheduledTxId ?? "") : "", /^SIM-SCHED-/);

  clock = T0;
  const doomed = await pend("X-2");
  payees.revoke("0.0.1001", at(300));
  clock = at(601);
  const r = await executePending(agent, doomed, { currentEpoch: 1, approval: null });
  assert.equal(r.kind, "done");
  const o = r.kind === "done" ? r.outcome : null;
  assert.equal(o?.decision, "REFUSED");
  assert.equal(o?.reason, "re-checked at execution: payee revoked, ABORTED");
  const log = (await agent.hedera.readAuditLog()).messages as Array<{ event: string; detail: string }>;
  assert.equal(log.at(-1)!.event, "ABORTED_AT_EXECUTION");
  assert.equal(log.at(-1)!.detail, "re-checked at execution: payee revoked, ABORTED");
});

test("execute: a large proposal whose approval expired inside the window is refused", async () => {
  let clock = T0;
  const agent = makeAgent({ challengeWindowSeconds: 120, now: () => clock });
  const approval = verifiedWorldCheck("X-L", T0);
  const o = await processProposal(agent, prop("X-L", 80_000_000), approval);
  assert.equal(o.decision, "PENDING_CHALLENGE");
  clock = at(400);
  const r = await executePending(agent, { outcome: o, challengeUntil: o.challengeUntil!, challenged: false, createdEpoch: 1 }, { currentEpoch: 1, approval });
  assert.equal(r.kind === "done" && r.outcome.decision, "REFUSED");
  assert.match(r.kind === "done" ? r.outcome.reason : "", /World ID approval expired during the challenge window, ABORTED/);
});

test("execute (real-mode path, fake chain): a schedule deleted in the window aborts; a live one is co-signed", async () => {
  let clock = T0;
  let deleted = false;
  const signed: string[] = [];
  const sched = (): OnChainSchedule => ({
    scheduleId: "0.0.7777", memo: "", creator: "0.0.6000", payer: "0.0.6000", executed: false, deleted, signedBy: 1,
    hbarTransfers: [], transfer: { from: "0.0.5000", payee: "0.0.1001", amountTinybars: 10_000_000, token: "HBAR" }, problem: null,
  });
  const chain: ChainPort = { resolve: async () => sched(), sign: async (id) => (signed.push(id), { scheduleId: id, action: "signed" }) };
  const agent = makeAgent({ chain, challengeWindowSeconds: 60, now: () => clock });
  agent.hedera.config.treasuryAccountId = "0.0.5000";
  const o = await processProposal(agent, prop("C-1"), null);
  assert.equal(o.decision, "PENDING_CHALLENGE");
  assert.equal(o.scheduledTxId, "0.0.7777");
  assert.deepEqual(signed, []);
  clock = at(61);
  const ok = await executePending(agent, { outcome: o, challengeUntil: o.challengeUntil!, challenged: false, createdEpoch: 1 }, { currentEpoch: 1, approval: null });
  assert.equal(ok.kind === "done" && ok.outcome.decision, "SIGNED");
  assert.deepEqual(signed, ["0.0.7777"]);
  deleted = true;
  const gone = await executePending(agent, { outcome: o, challengeUntil: o.challengeUntil!, challenged: false, createdEpoch: 1 }, { currentEpoch: 1, approval: null });
  assert.match(gone.kind === "done" ? gone.outcome.reason : "", /schedule 0.0.7777 cannot be signed: The schedule was deleted\., ABORTED/);
  assert.equal(signed.length, 1);
});

// ---- the server ----

type Call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
async function withServer(opts: AppOptions, fn: (call: Call, base: string) => Promise<void>) {
  // Tests run the demo fallback explicitly: no credentials, DEMO_MODE=1.
  // The setup-required gate is covered in test/runmode.test.ts.
  const app = await createApp({ statePath: null, ...opts, env: { DEMO_MODE: "1", ...(opts.env ?? {}) } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call, base);
  } finally {
    server.close();
  }
}
const sprop = (id: string, amount = 10_000_000, payee = "0.0.6666") => prop(id, amount, payee);
const WIN = { CHALLENGE_WINDOW_SECONDS: "600" };

test("server: window enforced with 425 before the time, executes after, approval of a routine proposal not needed", async () => {
  let clock = T0;
  await withServer({ env: WIN, now: () => clock }, async (call) => {
    const s = await call("POST", "/proposals", { proposal: sprop("S-1") });
    assert.equal(s.body.decision, "PENDING_CHALLENGE");
    assert.equal(s.body.challengeUntil, at(600).toISOString());
    assert.equal((await call("GET", "/proposals")).body.proposals[0].challengeUntil, at(600).toISOString());
    // Resubmitting inside the window does not process (or pay) again.
    const again = await call("POST", "/proposals", { proposal: sprop("S-1") });
    assert.equal(again.body.paidTxId, s.body.paidTxId);
    assert.match(again.body.note, /Already in its challenge window/);
    clock = at(100);
    const early = await call("POST", "/proposals/S-1/execute");
    assert.equal(early.status, 425);
    assert.equal(early.body.secondsRemaining, 500);
    clock = at(600);
    const done = await call("POST", "/proposals/S-1/execute");
    assert.equal(done.status, 200);
    assert.equal(done.body.decision, "SIGNED");
    assert.equal((await call("POST", "/proposals/S-1/execute")).status, 409);
    assert.equal((await call("GET", "/proposals/S-1")).body.challenge, null);
    assert.equal((await call("POST", "/proposals/NOPE/execute")).status, 404);
  });
});

test("server: a challenge blocks execution until it is resumed", async () => {
  let clock = T0;
  await withServer({ env: WIN, now: () => clock }, async (call) => {
    await call("POST", "/proposals", { proposal: sprop("S-2") });
    assert.equal((await call("POST", "/proposals/S-2/challenge", {})).status, 400);
    const c = await call("POST", "/proposals/S-2/challenge", { reason: "payee looks wrong" });
    assert.equal(c.body.state, "challenged");
    assert.equal((await call("POST", "/proposals/S-2/challenge", { reason: "again" })).status, 409);
    assert.equal((await call("GET", "/proposals/S-2")).body.challenge.challenged, true);
    clock = at(700);
    const blocked = await call("POST", "/proposals/S-2/execute");
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /payee looks wrong/);
    assert.equal((await call("POST", "/proposals/S-2/challenge", { resume: true })).body.state, "pending");
    assert.equal((await call("POST", "/proposals/S-2/challenge", { resume: true })).status, 409);
    assert.equal((await call("POST", "/proposals/S-2/execute")).body.decision, "SIGNED");
    const events = (await call("GET", "/audit")).body.entries.map((e: any) => e.event);
    assert.deepEqual(events.filter((e: string) => e !== "SIGNED"), ["PROPOSAL_CREATED", "CHALLENGED", "CHALLENGE_RESOLVED"]);
    assert.equal((await call("POST", "/proposals/S-2/challenge", { reason: "late" })).status, 409);
  });
});

test("server: revoking a payee in the window aborts execution; /payees shows the revoked entry", async () => {
  let clock = T0;
  await withServer({ env: WIN, now: () => clock }, async (call) => {
    await call("POST", "/proposals", { proposal: sprop("S-3") });
    const rv = await call("POST", "/payees/0.0.6666/revoke");
    assert.equal(rv.status, 200);
    assert.equal((await call("POST", "/payees/0.0.6666/revoke")).status, 404);
    assert.ok((await call("GET", "/payees")).body.payees.find((p: any) => p.account === "0.0.6666").revokedAt);
    clock = at(601);
    const r = await call("POST", "/proposals/S-3/execute");
    assert.equal(r.body.decision, "REFUSED");
    assert.equal(r.body.reason, "re-checked at execution: payee revoked, ABORTED");
    const events = (await call("GET", "/audit")).body.entries.map((e: any) => e.event);
    assert.deepEqual(events.slice(-2), ["PAYEE_REVOKED", "ABORTED_AT_EXECUTION"]);
    // A new proposal to a revoked payee is refused outright.
    const fresh = await call("POST", "/proposals", { proposal: sprop("S-3b") });
    assert.equal(fresh.body.decision, "REFUSED");
  });
});

test("server: a large proposal executes on a fresh approval and refuses on an expired one", async () => {
  let clock = new Date();
  await withServer({ env: { CHALLENGE_WINDOW_SECONDS: "60" }, now: () => clock }, async (call) => {
    await call("POST", "/proposals", { proposal: sprop("S-4", 80_000_000) });
    await call("POST", "/world/verify", { proposalId: "S-4", mocked: true });
    const p = await call("POST", "/proposals", { proposal: sprop("S-4", 80_000_000) });
    assert.equal(p.body.decision, "PENDING_CHALLENGE");
    assert.ok((await call("GET", "/proposals/S-4")).body.approval, "approval is still held, not spent");
    clock = new Date(Date.now() + 90_000);
    assert.equal((await call("POST", "/proposals/S-4/execute")).body.decision, "SIGNED");
    assert.equal((await call("GET", "/proposals/S-4")).body.approval, null);

    clock = new Date();
    await call("POST", "/proposals", { proposal: sprop("S-5", 80_000_000) });
    await call("POST", "/world/verify", { proposalId: "S-5", mocked: true });
    await call("POST", "/proposals", { proposal: sprop("S-5", 80_000_000) });
    clock = new Date(Date.now() + 400_000);
    const r = await call("POST", "/proposals/S-5/execute");
    assert.match(r.body.reason, /World ID approval expired during the challenge window, ABORTED/);
  });
});

test("server: evidence and verify still pass for PENDING_CHALLENGE", async () => {
  await withServer({ env: WIN }, async (call) => {
    await call("POST", "/proposals", { proposal: sprop("S-6") });
    const bundle: EvidenceBundle = (await call("GET", "/proposals/S-6/evidence")).body;
    const policy: PublishedPolicy = (await call("GET", "/policy")).body;
    const audit = (await call("GET", "/audit")).body.entries;
    assert.equal(bundle.decision, "PENDING_CHALLENGE");
    const rs = verifyBundle(bundle, policy, audit, { auditSource: "server" });
    assert.deepEqual(rs.filter((r) => r.status === "FAIL"), []);
    assert.equal(rs.find((r) => r.name === "challenge window")?.status, "PASS");
  });
});

test("policy: the hash commits to the window and to auth being on; /health and /policy say which", async () => {
  const get = async (env: Record<string, string>) => {
    let out: any;
    await withServer({ env }, async (call) => {
      out = { policy: (await call("GET", "/policy")).body, health: (await call("GET", "/health")).body };
    });
    return out;
  };
  const off = await get({});
  const win = await get(WIN);
  const key = await get({ COUNCIL_API_KEY: "k-secret-123" });
  assert.notEqual(off.policy.hash, win.policy.hash);
  assert.notEqual(off.policy.hash, key.policy.hash);
  assert.equal(win.policy.policy.challenge.windowSeconds, 600);
  assert.equal(win.policy.policy.challenge.recheckAtExecution, true);
  assert.equal(off.policy.auth, "open (demo)");
  assert.equal(off.health.auth, "open (demo)");
  assert.deepEqual(key.policy.policy.auth, { enabled: true });
  assert.notEqual(key.health.auth, "open (demo)");
  assert.match(win.health.challengeWindow, /600s/);
  assert.equal(JSON.stringify(key).includes("k-secret-123"), false);
  const base = { network: "testnet", mode: "simulated" as const, treasury: "s", signers: { agent: "a", proposer: null, threshold: "s" }, largeThresholdTinybars: 1,
    check: { via: "simulated" as const, priceUsdc: "0.01", spendCapUsdc: "0.1", decidedBy: "d" }, payees: { count: 0, enforce: false, source: "empty" },
    verdict: { zeroG: "n", requireVerdict: false, allowNo0G: false }, worldGate: { requiredForLarge: true, environment: "production", approvalTtlMinutes: 5, singleUse: true },
    transferSource: "request" as const };
  assert.notEqual(buildPolicy(base).hash, buildPolicy({ ...base, challenge: { windowSeconds: 60, recheckAtExecution: true } }).hash);
});

// ---- API key ----

test("auth: state-changing routes need the key when COUNCIL_API_KEY is set; the key is never echoed", async () => {
  const KEY = "k-secret-123";
  await withServer({ env: { COUNCIL_API_KEY: KEY, ...WIN } }, async (call) => {
    const body = { proposal: sprop("A-1") };
    const denied = await call("POST", "/proposals", body);
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "Unauthorized" });
    assert.equal((await call("POST", "/proposals", body, { Authorization: "Bearer wrong-key" })).status, 401);
    assert.equal((await call("POST", "/proposals", body, { Authorization: `Bearer ${KEY}x` })).status, 401);
    assert.equal((await call("POST", "/proposals", body, { "x-api-key": "k" })).status, 401);
    assert.equal((await call("POST", "/proposals", body, { Authorization: `Bearer ${KEY}` })).status, 200);
    assert.equal((await call("POST", "/proposals", { proposal: sprop("A-2") }, { "x-api-key": KEY })).status, 200);
    for (const [path, b] of [["/proposals/A-1/execute", {}], ["/proposals/A-1/challenge", { reason: "x" }], ["/payees/0.0.6666/revoke", {}], ["/council/revoke", { mocked: true }]] as const) {
      assert.equal((await call("POST", path, b)).status, 401, path);
    }
    assert.equal((await call("POST", "/proposals/A-1/challenge", { reason: "x" }, { "x-api-key": KEY })).status, 200);
    // Read routes and the routes with their own protection stay open.
    assert.equal((await call("GET", "/proposals")).status, 200);
    assert.equal((await call("POST", "/check", sprop("A-3"))).status, 402);
    assert.equal((await call("POST", "/council/join", { mocked: true, nullifier: "a" })).status, 200);
    for (const path of ["/health", "/policy", "/proposals", "/payees", "/audit", "/proposals/A-1", "/proposals/A-1/evidence"]) {
      assert.equal(JSON.stringify((await call("GET", path)).body).includes(KEY), false, path);
    }
  });
});

test("auth: with no key set the routes are open", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.equal((await call("POST", "/proposals", { proposal: sprop("A-4") })).status, 200);
  });
});

// ---- seat revocation ----

const joinSeat = (call: Call, n: string) => call("POST", "/council/join", { mocked: true, nullifier: n });
const inviteAs = async (call: Call, by: string) => {
  const r = await call("POST", "/council/invites", { mocked: true, byNullifier: `mock:${by}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.code as string;
};
const joinWithInvite = async (call: Call, n: string, by: string) =>
  call("POST", "/council/join", { mocked: true, nullifier: n, invite: await inviteAs(call, by) });

test("revoke: a seat holder revokes; epoch 1 -> 2, pending proposals cancelled, one REVOKED entry, rejoin blocked", async () => {
  await withServer({ env: WIN }, async (call) => {
    await joinSeat(call, "a");
    assert.equal((await joinWithInvite(call, "b", "a")).status, 200);
    assert.deepEqual((await call("GET", "/council/epoch")).body, { epoch: 1, revokedSeats: 0 });
    await call("POST", "/proposals", { proposal: sprop("V-1") });
    await call("POST", "/proposals", { proposal: sprop("V-2", 20_000_000) });
    await call("POST", "/proposals/V-2/challenge", { reason: "hold" });
    // Removing another seat opens a vote among the other seats; nothing happens until it passes.
    const open = await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:2" });
    assert.equal(open.status, 202);
    assert.deepEqual([open.body.voteOpened, open.body.subject, open.body.vote.eligible, open.body.vote.needed], [true, "R-1", ["council-seat:1"], 1]);
    assert.deepEqual((await call("GET", "/council/epoch")).body, { epoch: 1, revokedSeats: 0 });
    const cast = await call("POST", "/council/revocations/R-1/vote", { choice: "yes", mocked: true, byNullifier: "mock:a" });
    assert.equal(cast.status, 200);
    assert.equal(cast.body.removed, true);
    const r = cast.body.revocation;
    assert.equal(r.epoch, 2);
    assert.deepEqual(r.cancelledProposals.sort(), ["V-1", "V-2"]);
    assert.equal(r.detail, "epoch 1 -> 2, seat council-seat:2 revoked, 2 pending proposals cancelled, removed by council vote R-1 (1 of 1)");
    assert.deepEqual((await call("GET", "/council/epoch")).body, { epoch: 2, revokedSeats: 1 });
    const events = (await call("GET", "/audit")).body.entries.filter((e: any) => e.event === "REVOKED");
    assert.equal(events.length, 1);
    assert.equal(events[0].detail, r.detail);
    // Cancelled: not executable, shown as CANCELLED, approval gone.
    const ex = await call("POST", "/proposals/V-1/execute");
    assert.equal(ex.status, 409);
    const list = (await call("GET", "/proposals")).body.proposals;
    assert.deepEqual(list.map((p: any) => p.decision), ["CANCELLED", "CANCELLED"]);
    // The revoked person cannot rejoin; the seat id is not reused.
    const back = await joinSeat(call, "b");
    assert.equal(back.status, 403);
    assert.equal(back.body.error, "This seat was revoked");
    // Joining now needs an invite from a current seat holder.
    assert.equal((await joinSeat(call, "c")).status, 403);
    assert.equal((await joinWithInvite(call, "c", "a")).body.seat, "council-seat:3");
    assert.equal((await call("GET", "/council/seats")).body.count, 2);
    // Evidence for a cancelled proposal names the revocation and verifies.
    const bundle: EvidenceBundle = (await call("GET", "/proposals/V-1/evidence")).body;
    assert.equal(bundle.decision, "CANCELLED");
    const rs = verifyBundle(bundle, (await call("GET", "/policy")).body, (await call("GET", "/audit")).body.entries, { auditSource: "server" });
    assert.deepEqual(rs.filter((x) => x.status === "FAIL"), []);
    assert.equal(rs.find((x) => x.name === "cancellation")?.status, "PASS");
    // A new proposal after the revoke gets a fresh window in the new epoch.
    await call("POST", "/proposals", { proposal: sprop("V-3") });
    assert.equal((await call("GET", "/proposals/V-3")).body.challenge.epoch, 2);
  });
});

test("revoke: self-revoke works; a non-holder and an unknown seat are refused", async () => {
  await withServer({ env: {} }, async (call) => {
    await joinSeat(call, "a");
    const stranger = await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:zzz", seat: "council-seat:1" });
    assert.equal(stranger.status, 403);
    assert.equal((await call("POST", "/council/revoke", { mocked: true, seat: "council-seat:1" })).status, 403);
    assert.equal((await call("POST", "/council/revoke", { mocked: true, byNullifier: "a", seat: "council-seat:1" })).status, 403);
    assert.equal((await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:9" })).status, 404);
    assert.equal((await call("GET", "/council/epoch")).body.epoch, 1);
    const self = await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", nullifier: "mock:a" });
    assert.equal(self.status, 200);
    assert.equal(self.body.by, "self");
    assert.equal((await call("GET", "/council/seats")).body.count, 0);
  });
});

test("revoke: mocked is refused when World is configured, and a real proof must come from a seat holder", async () => {
  const WORLD = { WORLD_RP_ID: "rp_test", WORLD_APP_ID: "app_test", WORLD_SIGNING_KEY: "0x" + "11".repeat(32) };
  const world = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ success: true, action: b.action, environment: b.environment, results: [{ identifier: "proof_of_human", success: true, nullifier: b.responses[0].nullifier }] }), { status: 200 });
  }) as typeof fetch;
  // World derives one nullifier per (person, app, action), so "0x1" under join-council is the same person throughout.
  const proof = (action: string, nullifier: string, signal: string) => ({
    protocol_version: "4.0", nonce: "0x1", action, environment: "production",
    responses: [{ identifier: "proof_of_human", issuer_schema_id: 1, nullifier, expires_at_min: 1, signal_hash: hashSignal(signal), proof: ["1", "2", "3", "4", "5"] }],
  });
  await withServer({ env: WORLD, worldFetch: world }, async (call) => {
    assert.equal((await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:1" })).status, 403);
    assert.equal((await call("POST", "/council/join", { idkitResult: proof("join-council", "0x1", "council-join") })).body.joined, true);
    // Later seats join with an invite from a current seat holder, proven under the join action.
    const inv = await call("POST", "/council/invites", { seat: "council-seat:1", idkitResult: proof("join-council", "0x1", "council-invite:council-seat:1") });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal((await call("POST", "/council/join", { idkitResult: proof("join-council", "0x2", "council-join"), invite: inv.body.code })).body.joined, true);
    // A join proof cannot be replayed as a revocation, and a revocation names its seat.
    const replayedJoin = await call("POST", "/council/revoke", { idkitResult: proof("join-council", "0x1", "council-join"), seat: "council-seat:2" });
    assert.equal(replayedJoin.status, 403);
    assert.match(replayedJoin.body.error, /signal mismatch/);
    const otherSeat = await call("POST", "/council/revoke", { idkitResult: proof("join-council", "0x1", "council-revoke:council-seat:1"), seat: "council-seat:2" });
    assert.equal(otherSeat.status, 403);
    const wrongAction = await call("POST", "/council/revoke", { idkitResult: proof("revoke-seat", "0x1", "council-revoke:council-seat:2"), seat: "council-seat:2" });
    assert.equal(wrongAction.status, 403);
    const stranger = await call("POST", "/council/revoke", { idkitResult: proof("join-council", "0x9", "council-revoke:council-seat:2"), seat: "council-seat:2" });
    assert.equal(stranger.status, 403);
    assert.match(stranger.body.error, /seat holder/);
    assert.equal((await call("POST", "/council/revoke", { idkitResult: proof("join-council", "0x1", "council-revoke:council-seat:9"), seat: "council-seat:9" })).status, 404);
    // The rp-context for revocation is server-chosen: the join action, a signal naming the seat.
    const ctx = (await call("POST", "/world/rp-context", { revoke: true, seat: "council-seat:2" })).body;
    assert.deepEqual([ctx.action, ctx.signal], ["join-council", "council-revoke:council-seat:2"]);
    assert.equal((await call("POST", "/world/rp-context", { revoke: true })).status, 404);
    assert.equal((await call("POST", "/world/rp-context", { join: true })).body.signal, "council-join");
    // Seat 1's holder revokes seat 2 with the same nullifier they joined with.
    // Removing another seat opens a vote; the only other seat decides it.
    const open = await call("POST", "/council/revoke", { idkitResult: proof("join-council", "0x1", "council-revoke:council-seat:2"), seat: "council-seat:2" });
    assert.equal(open.status, 202);
    assert.deepEqual([open.body.voteOpened, open.body.subject, open.body.vote.eligible, open.body.vote.needed], [true, "R-1", ["council-seat:1"], 1]);
    const cast = await call("POST", "/council/revocations/R-1/vote", { choice: "yes", idkitResult: proof("join-council", "0x1", voteSignal("R-1", "revoke:council-seat:2:1", "yes")) });
    assert.equal(cast.status, 200);
    assert.equal(cast.body.removed, true);
    const ok = cast.body.revocation;
    assert.equal(ok.by, "council vote R-1");
    assert.equal((await call("POST", "/council/join", { idkitResult: proof("join-council", "0x2", "council-join") })).body.error, "This seat was revoked");
  });
});

test("revoke: pending schedules are deleted through the chain port (fake chain; real ScheduleDelete not run)", async () => {
  const deleted: string[] = [];
  const sched: OnChainSchedule = {
    scheduleId: "0.0.7777", memo: "", creator: "0.0.6000", payer: "0.0.6000", executed: false, deleted: false, signedBy: 1,
    hbarTransfers: [], transfer: { from: "0.0.5000", payee: "0.0.6666", amountTinybars: 10_000_000, token: "HBAR" }, problem: null,
  };
  const chain: ChainPort = {
    resolve: async () => sched,
    sign: async (id) => ({ scheduleId: id, action: "signed" }),
    cancel: async (id) => {
      if (id === "0.0.7777" && deleted.includes(id)) throw new Error("already gone");
      deleted.push(id);
    },
  };
  await withServer({ env: WIN, chain }, async (call) => {
    await joinSeat(call, "a");
    const p = await call("POST", "/proposals", { proposal: sprop("D-1") });
    assert.equal(p.body.scheduledTxId, "0.0.7777");
    const r = await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:1" });
    assert.deepEqual(deleted, ["0.0.7777"]);
    assert.equal(r.body.cancelledProposals[0], "D-1");
  });
});

test("store: epoch and revoked seats survive a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "state-")), "state.json");
  const a = new StateStore(file);
  const s = a.addSeat("n1", "world")!;
  a.addSeat("n2", "world");
  assert.equal(a.revokeSeat(s.seat)?.toEpoch, 2);
  const b = new StateStore(file);
  assert.equal(b.epoch(), 2);
  assert.equal(b.isRevoked("n1"), true);
  assert.equal(b.addSeat("n1", "world"), null);
  assert.equal(b.addSeat("n3", "world")?.seat, "council-seat:3");
  // An old state file without the new fields loads with epoch 1.
  writeFileSync(file, JSON.stringify({ seats: [], usedApprovals: [] }));
  assert.equal(new StateStore(file).epoch(), 1);
});

test("revoke during an in-flight execution: the execution's real outcome stands, it is not overwritten as CANCELLED", async () => {
  let clock = T0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let signing!: () => void;
  const signingStarted = new Promise<void>((r) => (signing = r));
  const deleted: string[] = [];
  const sched: OnChainSchedule = {
    scheduleId: "0.0.7777", memo: "", creator: "0.0.6000", payer: "0.0.6000", executed: false, deleted: false, signedBy: 1,
    hbarTransfers: [], transfer: { from: "0.0.5000", payee: "0.0.6666", amountTinybars: 10_000_000, token: "HBAR" }, problem: null,
  };
  const chain: ChainPort = {
    resolve: async () => sched,
    sign: async (id) => { signing(); await gate; return { scheduleId: id, action: "signed" }; },
    cancel: async (id) => { deleted.push(id); },
  };
  await withServer({ env: WIN, chain, now: () => clock }, async (call) => {
    await joinSeat(call, "a");
    assert.equal((await call("POST", "/proposals", { proposal: sprop("F-1") })).body.decision, "PENDING_CHALLENGE");
    clock = at(601);
    const executing = call("POST", "/proposals/F-1/execute");
    await signingStarted;
    const revoking = call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:1" });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ex, rv] = await Promise.all([executing, revoking]);
    assert.equal(ex.body.decision, "SIGNED");
    assert.equal(rv.status, 200);
    assert.deepEqual(rv.body.cancelledProposals, []);
    assert.deepEqual(rv.body.settledBeforeRevocation, [{ id: "F-1", decision: "SIGNED" }]);
    assert.deepEqual(deleted, []);
    const list = (await call("GET", "/proposals")).body.proposals;
    assert.equal(list.find((p: any) => p.id === "F-1").decision, "SIGNED");
  });
});
