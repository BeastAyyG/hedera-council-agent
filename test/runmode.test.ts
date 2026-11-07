// Fresh tests, written 2026-11-07 for ETHGlobal Mumbai.
// Run mode: real is primary when credentials are set, demo only as an
// explicit DEMO_MODE=1 fallback, and setup-required fails closed when
// neither is true. No real credentials anywhere here: the fake key below
// is a placeholder that never reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, buildAgent } from "../src/server.js";
import { demoMode, hasHederaCredentials, healthMode, missingSetup, resolveRunMode, CREDENTIALS } from "../src/runmode.js";

const FAKE_HEDERA = {
  HEDERA_ACCOUNT_ID: "0.0.1234",
  HEDERA_PRIVATE_KEY: "0x" + "22".repeat(32),
};

test("resolveRunMode: setup by default, demo only when asked, real when keyed", () => {
  assert.equal(resolveRunMode({}), "setup");
  assert.equal(resolveRunMode({ DEMO_MODE: "0" }), "setup");
  assert.equal(resolveRunMode({ DEMO_MODE: "1" }), "demo");
  assert.equal(resolveRunMode({ ...FAKE_HEDERA }), "real");
  assert.equal(resolveRunMode({ ...FAKE_HEDERA, DEMO_MODE: "1" }), "demo");
  assert.equal(resolveRunMode({ HEDERA_ACCOUNT_ID: "0.0.1234" }), "setup");
  assert.equal(demoMode({ DEMO_MODE: "1" }), true);
  assert.equal(demoMode({}), false);
  assert.equal(hasHederaCredentials({ ...FAKE_HEDERA }), true);
  assert.equal(hasHederaCredentials({ HEDERA_ACCOUNT_ID: "0.0.1234" }), false);
  assert.equal(healthMode("real"), "real");
  assert.equal(healthMode("demo"), "demo");
  assert.equal(healthMode("setup"), "setup-required");
});

test("missingSetup names every missing credential and where to get it", () => {
  assert.equal(missingSetup({}).length, 6);
  assert.deepEqual(
    missingSetup({}).map((m) => m.name),
    CREDENTIALS.map((c) => c.name),
  );
  for (const m of missingSetup({})) assert.ok(m.where.length > 10, `${m.name} says where to get it`);
  assert.deepEqual(
    missingSetup({ ...FAKE_HEDERA }).map((m) => m.name),
    ["ZERO_G_API_KEY", "WORLD_RP_ID", "WORLD_APP_ID", "WORLD_SIGNING_KEY"],
  );
  assert.deepEqual(missingSetup({ ...FAKE_HEDERA, ZERO_G_API_KEY: "sk-test", WORLD_RP_ID: "r", WORLD_APP_ID: "a", WORLD_SIGNING_KEY: "0x11" }), []);
  assert.equal(CREDENTIALS.find((c) => c.name === "HEDERA_PRIVATE_KEY")?.secret, true);
  assert.equal(CREDENTIALS.find((c) => c.name === "HEDERA_ACCOUNT_ID")?.secret, false);
});

test("buildAgent carries the run mode, and demo forces simulated even when keyed", () => {
  const setup = buildAgent({});
  assert.equal(setup.runMode, "setup");
  assert.equal(setup.mode, "simulated");
  const demo = buildAgent({ DEMO_MODE: "1" });
  assert.equal(demo.runMode, "demo");
  assert.equal(demo.mode, "simulated");
  const keyed = buildAgent({ ...FAKE_HEDERA });
  assert.equal(keyed.runMode, "real");
  assert.equal(keyed.mode, "real");
  const keyedDemo = buildAgent({ ...FAKE_HEDERA, DEMO_MODE: "1" });
  assert.equal(keyedDemo.runMode, "demo");
  assert.equal(keyedDemo.mode, "simulated");
});

async function withServer(env: NodeJS.ProcessEnv, fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const app = await createApp({ statePath: null, env });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

const proposal = {
  id: "P-SETUP-1",
  description: { payee: "0.0.1001", amountTinybars: 10_000_000, token: "HBAR", purpose: "Pay the venue deposit" },
  transfer: { payee: "0.0.1001", amountTinybars: 10_000_000, token: "HBAR" },
  createdAt: new Date().toISOString(),
};

test("setup mode: /health and /setup name the missing credentials, writes fail closed with 503, reads still work", async () => {
  await withServer({}, async (call) => {
    const health = await call("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.mode, "setup-required");
    assert.equal(health.body.runMode, "setup");
    assert.equal(health.body.missingCredentials.length, 6);
    assert.match(health.body.note, /SETUP REQUIRED/);
    const setup = await call("GET", "/setup");
    assert.equal(setup.body.ready, false);
    assert.equal(setup.body.missing.length, 6);
    assert.equal(setup.body.runbook, "docs/REAL-MODE-RUNBOOK.md");
    for (const [method, path, body] of [
      ["POST", "/proposals", { proposal }],
      ["POST", "/check", proposal],
      ["POST", "/council/join", { mocked: true, nullifier: "n1" }],
      ["POST", "/mandate/draft", { text: "Pay 0.0.1001 up to 1 HBAR." }],
      ["POST", "/world/verify", { proposalId: "P-SETUP-1", mocked: true }],
    ] as const) {
      const r = await call(method, path, body);
      assert.equal(r.status, 503, `${method} ${path} fails closed`);
      assert.equal(r.body.setupRequired, true);
      assert.equal(r.body.missing.length, 6);
    }
    // Reads are not blocked: the server still answers.
    assert.equal((await call("GET", "/proposals")).status, 200);
    assert.equal((await call("GET", "/policy")).status, 200);
    assert.equal((await call("GET", "/audit")).status, 200);
  });
});

test("demo mode: /health says demo and the proposal flow still works, simulated", async () => {
  await withServer({ DEMO_MODE: "1" }, async (call) => {
    const health = await call("GET", "/health");
    assert.equal(health.body.mode, "demo");
    assert.equal(health.body.runMode, "demo");
    assert.equal(health.body.missingCredentials, undefined);
    const r = await call("POST", "/proposals", { proposal });
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, "SIGNED");
    assert.equal(r.body.mode, "simulated");
  });
});

test("demo beats credentials: a keyed server with DEMO_MODE=1 never takes a real payment", async () => {
  await withServer({ ...FAKE_HEDERA, DEMO_MODE: "1" }, async (call) => {
    const health = await call("GET", "/health");
    assert.equal(health.body.mode, "demo");
    // No payment header: the plain 402 shape, not the real middleware.
    const r = await call("POST", "/check", proposal);
    assert.equal(r.status, 402);
    assert.equal(r.body.x402Version, 1);
  });
});

test("real mode with an unreachable facilitator: /check fails closed with 503, never the plain 402", async () => {
  await withServer({ ...FAKE_HEDERA, X402_FACILITATOR_URL: "http://127.0.0.1:9" }, async (call) => {
    const health = await call("GET", "/health");
    assert.equal(health.body.mode, "real");
    assert.match(health.body.x402Seller, /unavailable/);
    const r = await call("POST", "/check", proposal);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /facilitator could not be reached/);
  });
});
