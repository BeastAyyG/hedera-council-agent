// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// HTTP-level tests: the World ID gate and council seats must hold up
// against a client calling the API directly, not just in unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../src/server.js";
import type { Proposal } from "../src/proposal.js";
import { hashSignal } from "@worldcoin/idkit-core";

async function withServer(opts: AppOptions, fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  // Tests run the demo fallback explicitly: no credentials, DEMO_MODE=1.
  // The setup-required gate is covered in test/runmode.test.ts.
  const app = await createApp({ statePath: null, ...opts, env: { DEMO_MODE: "1", ...(opts.env ?? {}) } });
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

const large = (id: string, amount = 80_000_000): Proposal => ({
  id,
  description: { payee: "0.0.6666", amountTinybars: amount, token: "HBAR", purpose: "large payment" },
  transfer: { payee: "0.0.6666", amountTinybars: amount, token: "HBAR" },
  createdAt: new Date().toISOString(),
});

const WORLD_ENV = {
  WORLD_RP_ID: "rp_test",
  WORLD_APP_ID: "app_test",
  WORLD_SIGNING_KEY: "0x" + "11".repeat(32),
};

// Stand-in for developer.world.org: accepts any proof, records what it was sent.
function fakeWorld(sent: any[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return new Response(
      JSON.stringify({ success: true, action: body.action, environment: body.environment, results: [{ identifier: "proof_of_human", success: true, nullifier: body.responses[0].nullifier }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const idkitBase = (action: string, nullifier: string, extra: Record<string, unknown> = {}) => ({
  protocol_version: "4.0",
  nonce: "0x1",
  action,
  environment: "production",
  responses: [{ identifier: "proof_of_human", issuer_schema_id: 1, nullifier, expires_at_min: 1, proof: ["1", "2", "3", "4", "5"] }],
  ...extra,
});

const idkit = idkitBase;
const joinProof = (nullifier: string) => {
  const r = idkitBase("join-council", nullifier);
  (r.responses[0] as any).signal_hash = hashSignal("council-join");
  return r;
};

test("a client-supplied World ID check is ignored", async () => {
  await withServer({ env: {} }, async (call) => {
    const future = new Date(Date.now() + 300_000).toISOString();
    const r = await call("POST", "/proposals", {
      proposal: large("P-FORGE"),
      worldCheck: { proposalId: "P-FORGE", status: "approved", verifiedAt: future, expiresAt: future, source: "world", backendValidated: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, "REFUSED");
    assert.equal(r.body.approveUrl, "/console.html?proposal=P-FORGE");
  });
});

test("demo mode: mocked approval signs once, then is spent", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.equal((await call("POST", "/world/verify", { proposalId: "P-M", mocked: true })).status, 404);
    await call("POST", "/proposals", { proposal: large("P-M") });
    const v = await call("POST", "/world/verify", { proposalId: "P-M", mocked: true });
    assert.equal(v.body.source, "mocked");
    assert.equal((await call("POST", "/proposals", { proposal: large("P-M") })).body.decision, "SIGNED");
    assert.equal((await call("POST", "/proposals", { proposal: large("P-M") })).body.decision, "REFUSED");
  });
});

test("a proposal id cannot be resubmitted with a different transfer", async () => {
  await withServer({ env: {} }, async (call) => {
    await call("POST", "/proposals", { proposal: large("P-SWAP") });
    await call("POST", "/world/verify", { proposalId: "P-SWAP", mocked: true });
    const r = await call("POST", "/proposals", { proposal: large("P-SWAP", 900_000_000) });
    assert.equal(r.status, 409);
  });
});

test("malformed proposals are rejected with 400", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.equal((await call("POST", "/proposals", {})).status, 400);
    assert.equal((await call("POST", "/check", { id: "x" })).status, 400);
  });
});

test("unpaid check returns 402", async () => {
  await withServer({ env: {} }, async (call) => {
    const r = await call("POST", "/check", large("P-C"));
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "Payment Required");
  });
});

test("demo mode: one council seat per nullifier", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.equal((await call("POST", "/council/join", { mocked: true, nullifier: "n-1" })).body.joined, true);
    assert.equal((await call("POST", "/council/join", { mocked: true, nullifier: "n-1" })).status, 409);
    assert.equal((await call("GET", "/council/seats")).body.count, 1);
  });
});

test("World configured: mocked approvals and joins are refused", async () => {
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld([]) }, async (call) => {
    await call("POST", "/proposals", { proposal: large("P-W0") });
    assert.equal((await call("POST", "/world/verify", { proposalId: "P-W0", mocked: true })).status, 403);
    assert.equal((await call("POST", "/council/join", { mocked: true, nullifier: "n" })).status, 403);
  });
});

test("World configured: RP context is signed for a server-chosen action", async () => {
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld([]) }, async (call) => {
    assert.equal((await call("POST", "/world/rp-context", { proposalId: "P-NOPE" })).status, 404);
    await call("POST", "/proposals", { proposal: large("P-RP") });
    const r = await call("POST", "/world/rp-context", { proposalId: "P-RP" });
    assert.equal(r.body.action, "council-sign:P-RP");
    assert.equal(r.body.rpContext.rp_id, "rp_test");
    assert.match(r.body.rpContext.signature, /^0x[0-9a-f]+$/);
    assert.match(r.body.signal, /^council-proposal:[0-9a-f]{64}$/);
    assert.equal((await call("POST", "/world/rp-context", { proposalId: "P-RP" })).body.signal, r.body.signal);
  });
});

test("World configured: approval is bound to the exact proposal bytes (signal)", async () => {
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld([]) }, async (call) => {
    await call("POST", "/proposals", { proposal: large("P-SIG") });
    const { signal } = (await call("POST", "/world/rp-context", { proposalId: "P-SIG" })).body;
    const withSignal = (s: string | null, hex = "0x2a") => {
      const r = idkit("council-sign:P-SIG", hex);
      (r.responses[0] as any).signal_hash = s === null ? undefined : hashSignal(s);
      return r;
    };
    // Proof made for another proposal's content, or with no signal: refused, nothing consumed.
    const other = await call("POST", "/world/verify", { proposalId: "P-SIG", idkitResult: withSignal("council-proposal:" + "0".repeat(64)) });
    assert.equal(other.status, 403);
    assert.match(other.body.error, /signal/);
    assert.equal((await call("POST", "/world/verify", { proposalId: "P-SIG", idkitResult: withSignal(null) })).status, 403);
    assert.equal((await call("POST", "/proposals", { proposal: large("P-SIG") })).body.decision, "REFUSED");
    // The same person can still approve with a correct proof (uppercase hex accepted).
    const good = withSignal(signal);
    (good.responses[0] as any).signal_hash = "0x" + hashSignal(signal).slice(2).toUpperCase();
    const ok = await call("POST", "/world/verify", { proposalId: "P-SIG", idkitResult: good });
    assert.equal(ok.body.approved, true);
    assert.equal((await call("POST", "/proposals", { proposal: large("P-SIG") })).body.decision, "SIGNED");
  });
});

test("World configured: verified approval signs once, environment pinned, replay refused", async () => {
  const sent: any[] = [];
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld(sent) }, async (call) => {
    await call("POST", "/proposals", { proposal: large("P-W") });
    const { signal } = (await call("POST", "/world/rp-context", { proposalId: "P-W" })).body;
    const idkit = (action: string, nullifier: string, extra: Record<string, unknown> = {}) => {
      const r = idkitBase(action, nullifier, extra);
      (r.responses[0] as any).signal_hash = hashSignal(signal);
      return r;
    };
    const wrong = await call("POST", "/world/verify", { proposalId: "P-W", idkitResult: idkit("council-sign:OTHER", "0x2a") });
    assert.equal(wrong.status, 403);
    const ok = await call("POST", "/world/verify", { proposalId: "P-W", idkitResult: idkit("council-sign:P-W", "0x2a", { environment: "staging" }) });
    assert.equal(ok.body.approved, true);
    assert.equal(sent.at(-1).environment, "production");
    assert.equal((await call("POST", "/proposals", { proposal: large("P-W") })).body.decision, "SIGNED");
    // Same person, same action: decimal 42 == 0x2a.
    const replay = await call("POST", "/world/verify", { proposalId: "P-W", idkitResult: idkit("council-sign:P-W", "42") });
    assert.equal(replay.status, 409);
    assert.equal((await call("POST", "/proposals", { proposal: large("P-W") })).body.decision, "REFUSED");
  });
});

test("World configured: verified join, one seat per nullifier", async () => {
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld([]) }, async (call) => {
    const unsigned = await call("POST", "/council/join", { idkitResult: idkit("join-council", "0xabc") });
    assert.equal(unsigned.status, 403);
    assert.match(unsigned.body.error, /signal mismatch/);
    const first = await call("POST", "/council/join", { idkitResult: joinProof("0xabc") });
    assert.equal(first.body.joined, true);
    const again = await call("POST", "/council/join", { idkitResult: joinProof("0x0abc") });
    assert.equal(again.status, 409);
    const wrongAction = await call("POST", "/council/join", { idkitResult: idkit("council-sign:P-1", "0xdef") });
    assert.equal(wrongAction.status, 403);
  });
});

test("GET /proposals lists registered proposals for the UI", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.deepEqual((await call("GET", "/proposals")).body.proposals, []);
    await call("POST", "/proposals", { proposal: large("P-LIST") });
    const [p] = (await call("GET", "/proposals")).body.proposals;
    assert.equal(p.id, "P-LIST");
    assert.equal(p.large, true);
    assert.equal(p.decision, "REFUSED");
  });
});

test("a proposal naming only a scheduleId is validated and refused without Hedera access", async () => {
  await withServer({ env: {} }, async (call) => {
    const { transfer: _t, createdAt: _c, ...rest } = large("P-SCHED");
    const r = await call("POST", "/proposals", { proposal: { ...rest, scheduleId: "0.0.7777" } });
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, "REFUSED");
    assert.match(r.body.reason, /no Hedera access/);
    assert.equal((await call("POST", "/proposals", { proposal: { ...rest, id: "P-BAD", scheduleId: "nope" } })).status, 400);
  });
});

test("the UI pages and shared assets are served", async () => {
  const app = await createApp({ statePath: null, env: { DEMO_MODE: "1" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [path, needle] of [["/", "Atlas"], ["/report.html", "Report"], ["/console.html", "Console"], ["/audit.html", "Audit log"], ["/audit-verify.html", "Audit check"], ["/assets/theme.css", "--paper"], ["/assets/scene.js", "pixelIsland"], ["/vendor/idkit.js", "IDKit"]] as const) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      assert.ok((await r.text()).includes(needle), `${path} contains ${needle}`);
    }
  } finally {
    server.close();
  }
});

test("policy, audit verification and evidence bundles", async () => {
  await withServer({ env: {} }, async (call) => {
    const pol = await call("GET", "/policy");
    assert.match(pol.body.hash, /^[0-9a-f]{64}$/);
    assert.ok(pol.body.policy.rules.length >= 5);
    assert.equal((await call("GET", "/proposals/P-NONE/evidence")).status, 404);

    await call("POST", "/proposals", { proposal: large("P-EV", 10_000_000) });
    await call("POST", "/proposals", { proposal: large("P-EV2", 20_000_000) });
    const ev = await call("GET", "/proposals/P-EV/evidence");
    assert.equal(ev.status, 200);
    assert.equal(ev.body.decision, "SIGNED");
    assert.equal(ev.body.policyHash, pol.body.hash);
    assert.equal(ev.body.audit.seq, 1);
    assert.match(ev.body.digest, /^[0-9a-f]{64}$/);

    const v = await call("GET", "/audit/verify");
    assert.equal(v.body.ok, true);
    assert.equal(v.body.checked, 2);
    assert.equal(v.body.policyHash, pol.body.hash);
    const log = await call("GET", "/audit");
    assert.equal(log.body.entries.length, 2);
    assert.equal(log.body.entries[1].prev, log.body.entries[0].hash);
    assert.equal(log.body.entries[1].hash, (await call("GET", "/proposals/P-EV2/evidence")).body.audit.entryHash);
  });
});

test("/original-console redirects to the original console app", async () => {
  const app = await createApp({ statePath: null, env: { DEMO_MODE: "1", ORIGINAL_CONSOLE_URL: "http://example.test/council" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/original-console`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "http://example.test/council");
  } finally {
    server.close();
  }
});
