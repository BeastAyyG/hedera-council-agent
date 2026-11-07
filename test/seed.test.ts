// Fresh tests, written 2026-11-07 for ETHGlobal Mumbai (PR #12).
// Demo-data seed: the judged story at startup (World ID payment, adopted
// standing instruction, inside payment, refused mismatch, voted-through
// outside payment), its idempotency, and its demo-only gate.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../src/server.js";

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withSeededServer(opts: AppOptions, fn: (call: Call) => Promise<void>) {
  const app = await createApp({ statePath: null, ...opts, env: { DEMO_MODE: "1", ...(opts.env ?? {}) } });
  const seed = await app.seedDemoState();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
  return seed;
}

test("seed: demo state is consistent across mandate, proposals, seats and audit", async () => {
  const seed = await withSeededServer({}, async (call) => {
    const mandate = await call("GET", "/mandate");
    assert.equal(mandate.body.active?.id, "M-1");
    assert.equal(mandate.body.active?.status, "adopted");
    assert.ok(mandate.body.active?.rulesHash);

    const proposals = await call("GET", "/proposals");
    const byId = new Map((proposals.body.proposals as Array<{ id: string; decision: string }>).map((p) => [p.id, p.decision]));
    assert.equal(byId.size, 4);
    assert.equal(byId.get("P-101"), "SIGNED");
    assert.equal(byId.get("P-102"), "REFUSED");
    assert.equal(byId.get("P-103"), "SIGNED");
    assert.equal(byId.get("P-104"), "SIGNED");

    // P-104 was signed on a World ID approval; P-101 inside the mandate
    // needed none; P-103 came back from a council vote with no second fee.
    const p104 = await call("GET", "/proposals/P-104");
    assert.equal(p104.body.lastOutcome.usedWorldApproval, true);
    const p101 = await call("GET", "/proposals/P-101");
    assert.equal(p101.body.lastOutcome.mandate?.within, true);
    assert.equal(p101.body.lastOutcome.usedWorldApproval, false);
    const p102 = await call("GET", "/proposals/P-102");
    assert.equal(p102.body.lastOutcome.checkMatches, false);
    assert.ok(p102.body.lastOutcome.paidTxId);
    const p103 = await call("GET", "/proposals/P-103");
    assert.equal(p103.body.lastOutcome.vote?.status, "passed");
    assert.equal(p103.body.lastOutcome.vote?.ballots?.length, 2);
    assert.ok(p103.body.lastOutcome.paidTxId);

    const seats = await call("GET", "/council/seats");
    assert.equal(seats.body.count, 3);

    const verify = await call("GET", "/audit/verify");
    assert.equal(verify.body.ok, true);
    assert.ok(verify.body.checked > 0);
    const audit = await call("GET", "/audit");
    assert.ok((audit.body.entries as unknown[]).length > 0);
  });
  assert.deepEqual(seed, {
    seeded: true,
    mandate: "M-1",
    seats: 3,
    proposals: [
      { id: "P-104", decision: "SIGNED" },
      { id: "P-101", decision: "SIGNED" },
      { id: "P-102", decision: "REFUSED" },
      { id: "P-103", decision: "SIGNED" },
    ],
  });
});

test("seed: a second call changes nothing", async () => {
  const app = await createApp({ statePath: null, env: { DEMO_MODE: "1" } });
  const first = await app.seedDemoState();
  assert.equal(first.seeded, true);
  const second = await app.seedDemoState();
  assert.deepEqual(second, { seeded: false, reason: "already seeded" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const proposals = await (await fetch(`${base}/proposals`)).json();
    assert.equal(proposals.proposals.length, 4);
    const mandate = await (await fetch(`${base}/mandate`)).json();
    assert.equal(mandate.drafts.length, 1);
    assert.equal(mandate.active?.id, "M-1");
  } finally {
    server.close();
  }
});

test("seed: gate, setup mode (no DEMO_MODE) seeds nothing", async () => {
  const app = await createApp({ statePath: null, env: {} });
  const seed = await app.seedDemoState();
  assert.equal(seed.seeded, false);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const proposals = await (await fetch(`${base}/proposals`)).json();
    assert.deepEqual(proposals.proposals, []);
  } finally {
    server.close();
  }
});

test("seed: gate, REAL_ONLY=1 seeds nothing even in demo mode", async () => {
  const app = await createApp({ statePath: null, env: { DEMO_MODE: "1", REAL_ONLY: "1" } });
  const seed = await app.seedDemoState();
  assert.deepEqual(seed, { seeded: false, reason: "REAL_ONLY=1" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const proposals = await (await fetch(`${base}/proposals`)).json();
    assert.deepEqual(proposals.proposals, []);
  } finally {
    server.close();
  }
});
