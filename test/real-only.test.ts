// Fresh tests, written 2026-11-07 for ETHGlobal Mumbai.
// The demo kill-switch: REAL_ONLY=1 hides the demo and fails closed with a
// setup-required message; default mode (REAL_ONLY unset) is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../src/server.js";
import { isRealOnly, missingSetup, SETUP_ITEMS } from "../src/realOnly.js";
import type { Proposal } from "../src/proposal.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function withServer(opts: AppOptions, fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const app = await createApp({ statePath: null, ...opts });
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

const proposal = (id: string): Proposal => ({
  id,
  description: { payee: "0.0.1001", amountTinybars: 10_000_000, token: "HBAR", purpose: "Pay the venue deposit" },
  transfer: { payee: "0.0.1001", amountTinybars: 10_000_000, token: "HBAR" },
  createdAt: new Date().toISOString(),
});

const ALL_CREDS = {
  HEDERA_ACCOUNT_ID: "0.0.5",
  HEDERA_PRIVATE_KEY: "ab".repeat(32),
  ZERO_G_API_KEY: "sk-test",
  WORLD_RP_ID: "rp_test",
  WORLD_APP_ID: "app_test",
  WORLD_SIGNING_KEY: "0x" + "11".repeat(32),
};

test("realOnly: the flag is off unless REAL_ONLY=1, and the missing list names all six credentials", () => {
  assert.equal(isRealOnly({}), false);
  assert.equal(isRealOnly({ REAL_ONLY: "0" }), false);
  assert.equal(isRealOnly({ REAL_ONLY: "1" }), true);
  assert.deepEqual(missingSetup({}).map((m) => m.key), SETUP_ITEMS.map((m) => m.key));
  assert.deepEqual(missingSetup({ ...ALL_CREDS }), []);
  assert.deepEqual(missingSetup({ REAL_ONLY: "1", HEDERA_ACCOUNT_ID: "0.0.5" }).map((m) => m.key), [
    "HEDERA_PRIVATE_KEY",
    "ZERO_G_API_KEY",
    "WORLD_RP_ID",
    "WORLD_APP_ID",
    "WORLD_SIGNING_KEY",
  ]);
});

test("REAL_ONLY=1: /health reports the switch and every missing credential with where to get it", async () => {
  await withServer({ env: { REAL_ONLY: "1" } }, async (call) => {
    const h = (await call("GET", "/health")).body;
    assert.equal(h.realOnly, true);
    assert.deepEqual(h.setupRequired.missing.map((m: { key: string }) => m.key), SETUP_ITEMS.map((m) => m.key));
    for (const m of h.setupRequired.missing) assert.match(m.where, /portal\.hedera\.com|pc\.0g\.ai|developer\.world\.org/);
    assert.match(h.note, /REAL-ONLY mode: setup required/);
    assert.match(h.world, /real-only mode: mocked approvals disabled/);
    assert.match(h.zeroG, /real-only mode: no simulated verdict/);
  });
});

test("REAL_ONLY=1: mocked World paths are refused with a real-only reason", async () => {
  await withServer({ env: { REAL_ONLY: "1" } }, async (call) => {
    const cfg = (await call("GET", "/world/config")).body;
    assert.equal(cfg.mockedAllowed, false);
    assert.equal(cfg.realOnly, true);
    assert.equal(cfg.setupRequired, true);
    const v = await call("POST", "/world/verify", { proposalId: "P-1", mocked: true });
    assert.equal(v.status, 404); // unknown proposal is checked before the mocked path
    const j = await call("POST", "/council/join", { mocked: true, nullifier: "n-1" });
    assert.equal(j.status, 403);
    assert.match(j.body.error, /REAL_ONLY=1/);
    const i = await call("POST", "/council/invites", { mocked: true, byNullifier: "n-1" });
    assert.equal(i.status, 403);
    assert.match(i.body.error, /REAL_ONLY=1/);
  });
});

test("REAL_ONLY=1: state-changing routes fail closed with 503 setup-required, no fake data", async () => {
  await withServer({ env: { REAL_ONLY: "1" } }, async (call) => {
    const p = await call("POST", "/proposals", { proposal: proposal("P-R1") });
    assert.equal(p.status, 503);
    assert.equal(p.body.setupRequired, true);
    assert.ok(p.body.missing.some((m: { key: string }) => m.key === "HEDERA_ACCOUNT_ID"));
    assert.ok(p.body.missing.some((m: { key: string }) => m.key === "HEDERA_PRIVATE_KEY"));
    const c = await call("POST", "/check", proposal("P-R2"));
    assert.equal(c.status, 503);
    assert.equal(c.body.setupRequired, true);
    const m = await call("POST", "/mandate/draft", { text: "Pay 0.0.1001 up to 50 HBAR each, at most 100 HBAR a month. Anything else goes to the council." });
    assert.equal(m.status, 503);
    assert.equal(m.body.setupRequired, true);
    assert.ok(m.body.missing.some((x: { key: string }) => x.key === "ZERO_G_API_KEY"));
  });
});

test("REAL_ONLY=1: the demo payee registry is gone", async () => {
  await withServer({ env: { REAL_ONLY: "1" } }, async (call) => {
    const h = (await call("GET", "/health")).body;
    assert.doesNotMatch(h.payeeRegistry, /^demo registry/);
    const pol = (await call("GET", "/policy")).body;
    assert.notEqual(pol.policy.payees.source, "demo registry");
  });
});

test("REAL_ONLY=1 with all credentials: the guards pass and nothing is mocked", async () => {
  // X402_FACILITATOR_URL points at a closed port so the x402 initialize
  // fails fast instead of reaching the network; the server falls back to
  // the plain 402 shape, as it does whenever the facilitator is down.
  await withServer({ env: { REAL_ONLY: "1", X402_FACILITATOR_URL: "http://127.0.0.1:9", ...ALL_CREDS } }, async (call) => {
    const h = (await call("GET", "/health")).body;
    assert.equal(h.realOnly, true);
    assert.equal(h.setupRequired, null);
    assert.match(h.note, /all credentials configured/);
    const cfg = (await call("GET", "/world/config")).body;
    assert.equal(cfg.mockedAllowed, false);
    assert.equal(cfg.setupRequired, false);
    const j = await call("POST", "/council/join", { mocked: true, nullifier: "n-1" });
    assert.equal(j.status, 403);
    assert.match(j.body.error, /REAL_ONLY=1/);
  });
});

test("demo mode (DEMO_MODE=1) is unchanged: demo identities work and the demo registry is labelled", async () => {
  // The labelled demo fallback is explicit now: no credentials and no
  // DEMO_MODE means setup-required, not demo. This test runs the demo
  // fallback the way the server actually takes it.
  await withServer({ env: { DEMO_MODE: "1" } }, async (call) => {
    const h = (await call("GET", "/health")).body;
    assert.equal(h.realOnly, false);
    assert.equal(h.setupRequired, null);
    assert.match(h.payeeRegistry, /^demo registry/);
    const j = await call("POST", "/council/join", { mocked: true, nullifier: "n-1" });
    assert.equal(j.status, 200);
    assert.equal(j.body.joined, true);
    const p = await call("POST", "/proposals", { proposal: proposal("P-D1") });
    assert.equal(p.status, 200);
    assert.equal(p.body.decision, "SIGNED");
  });
});

test("the demo UI is gated: simulated-log button, approve label, judge mode, setup banner hook", () => {
  const verify = readFileSync(`${ROOT}public/verify.html`, "utf8");
  assert.match(verify, /id="demo"[^>]*data-demo-only/, "simulated-log button is marked demo-only");
  assert.match(verify, /health\.mode === "simulated" && !health\.realOnly/, "simulated-log button stays hidden under REAL_ONLY");
  assert.match(verify, /real-only\.js/, "verify page loads the real-only hook");
  const hook = readFileSync(`${ROOT}public/assets/real-only.js`, "utf8");
  assert.match(hook, /setup-required/, "hook renders the setup banner");
  assert.match(hook, /data-demo-only/, "hook hides demo-only elements");
  const consoleHtml = readFileSync(`${ROOT}public/console.html`, "utf8");
  assert.match(consoleHtml, /!world\.mockedAllowed \? "Approve with World ID" : "Approve \(MOCKED demo\)"/, "approve button never says MOCKED when mocking is off");
  assert.match(consoleHtml, /real-only\.js/, "console loads the real-only hook");
  const judge = readFileSync(`${ROOT}public/assets/judge.js`, "utf8");
  assert.match(judge, /Judge mode is disabled while REAL_ONLY=1/, "judge mode refuses to run under REAL_ONLY");
  for (const page of ["index.html", "mandate.html", "council.html", "member.html", "report.html", "audit.html", "audit-verify.html"]) {
    assert.match(readFileSync(`${ROOT}public/${page}`, "utf8"), /real-only\.js/, `${page} loads the real-only hook`);
  }
});

test("the demo rehearsal refuses to run under REAL_ONLY=1", () => {
  const run = spawnSync(process.execPath, ["--import", "./dist/src/env.js", "dist/src/demo.js"], {
    cwd: ROOT,
    env: { ...process.env, REAL_ONLY: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /REAL_ONLY=1: the demo rehearsal is disabled/);
});
