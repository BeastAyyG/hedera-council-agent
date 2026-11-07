// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// The replayable audit must pass on an honest decision and fail on the
// right line when one character of the stored receipt is changed.
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { canonical, sha256 } from "../src/auditlog.js";
import { createApp } from "../src/server.js";
import type { Proposal } from "../src/proposal.js";
import { verifyBundle, summarize, type CheckResult, type EvidenceBundle, type PublishedPolicy } from "../src/verify.js";

const proposal = (id: string, amount: number): Proposal => ({
  id,
  description: { payee: "0.0.6666", amountTinybars: amount, token: "HBAR", purpose: "supplies" },
  transfer: { payee: "0.0.6666", amountTinybars: amount, token: "HBAR" },
  createdAt: new Date().toISOString(),
});

async function fixture(fn: (f: { bundle: EvidenceBundle; policy: PublishedPolicy; audit: any[] }) => void) {
  // The fixture runs the demo fallback explicitly: no credentials, DEMO_MODE=1.
  const app = await createApp({ statePath: null, env: { DEMO_MODE: "1" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
  try {
    for (const p of [proposal("P-V1", 10_000_000), proposal("P-V2", 20_000_000)]) {
      const r = await fetch(base + "/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposal: p }) });
      assert.equal(r.status, 200);
    }
    const bundle = await get("/proposals/P-V1/evidence");
    const policy = await get("/policy");
    const audit = (await get("/audit")).entries;
    fn({ bundle, policy, audit });
  } finally {
    server.close();
  }
}

const opts = { auditSource: "server" } as const;
const failing = (rs: CheckResult[]) => rs.filter((r) => r.status === "FAIL").map((r) => r.name);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// Change one character of a string.
const flip = (s: string) => (s[0] === "a" ? "b" : "a") + s.slice(1);
// A tamperer who also recomputes the digest, so only the edited field is wrong.
const redigest = (b: any) => {
  const { digest: _d, digestOf: _o, ...rest } = b;
  b.digest = sha256(canonical(rest));
  return b as EvidenceBundle;
};

test("a good proposal verifies with no FAIL, and simulated parts are warnings", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const rs = verifyBundle(bundle, policy, audit, opts);
    assert.deepEqual(failing(rs), []);
    assert.equal(summarize(rs).fail, 0);
    const by = (n: string) => rs.find((r) => r.name === n)!;
    for (const n of ["evidence digest", "proposal hash", "audit chain", "audit entry", "policy hash"]) assert.equal(by(n).status, "PASS", n);
    assert.equal(by("audit source").status, "WARN");
    assert.match(by("audit source").detail, /SIMULATED: no mirror node/);
    assert.equal(by("0G verdict").status, "WARN");
    assert.match(by("0G verdict").detail, /SIMULATED \(not a 0G verdict\)/);
    assert.equal(by("payment").status, "WARN");
    assert.match(by("payment").detail, /SIM id/);
    assert.equal(by("schedule").status, "WARN");
  });
});

test("tampered reason or amount fails the digest line", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const a = clone(bundle);
    a.reason = flip(String(a.reason));
    assert.deepEqual(failing(verifyBundle(a, policy, audit, opts)), ["evidence digest"]);
    const b = clone(bundle);
    b.proposal.transfer.amountTinybars += 1;
    assert.ok(failing(verifyBundle(b, policy, audit, opts)).includes("evidence digest"));
  });
});

test("one changed character in an audit entry fails the chain line", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const tampered = clone(audit);
    const e = tampered.find((x: any) => x.seq === bundle.audit.seq);
    e.detail = flip(e.detail);
    assert.deepEqual(failing(verifyBundle(bundle, policy, tampered, opts)), ["audit chain"]);
  });
});

test("a different entry hash in the bundle fails the audit entry line", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const b = clone(bundle) as any;
    b.audit.entryHash = flip(b.audit.entryHash);
    assert.deepEqual(failing(verifyBundle(redigest(b), policy, audit, opts)), ["audit entry"]);
  });
});

test("a policy hash mismatch fails the policy line", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const b = clone(bundle) as any;
    b.policyHash = flip(b.policyHash);
    assert.deepEqual(failing(verifyBundle(redigest(b), policy, audit, opts)), ["policy hash"]);
    const p = clone(policy);
    p.hash = flip(p.hash);
    assert.deepEqual(failing(verifyBundle(bundle, p, audit, opts)), ["policy hash"]);
  });
});

test("a partial log (last entries only) still checks, with a warning", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const rs = verifyBundle(bundle, policy, audit.slice(1), opts);
    assert.equal(rs.find((r) => r.name === "audit chain")!.status, "WARN");
  });
});

test("real-mode rules: SIM ids fail, 0G needs a request id, unavailable fails", async () => {
  await fixture(({ bundle, policy, audit }) => {
    const b = clone(bundle) as any;
    b.mode = "real";
    b.zeroG = { source: "0g", requestId: null };
    b.zeroG.source = "0g";
    const rs = verifyBundle(redigest(b), policy, audit, { auditSource: "mirror" });
    assert.deepEqual(failing(rs).sort(), ["0G verdict", "payment", "schedule"]);
    b.zeroG = { source: "unavailable", requestId: null };
    assert.ok(failing(verifyBundle(redigest(b), policy, audit, { auditSource: "mirror" })).includes("0G verdict"));
    b.zeroG = { source: "0g", requestId: "req-1" };
    b.payment.id = "0.0.5-1700000000-1";
    b.schedule.id = "0.0.777";
    const ok = verifyBundle(redigest(b), policy, audit, { auditSource: "mirror" });
    for (const n of ["0G verdict", "payment", "schedule", "audit source"]) assert.equal(ok.find((r) => r.name === n)!.status, "PASS", n);
  });
});
