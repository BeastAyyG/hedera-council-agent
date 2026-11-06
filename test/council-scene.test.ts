import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = () => import(pathToFileURL(join(process.cwd(), "public/assets/council-scene.js")).href);
const proposal = {
  id: "P-TEST",
  description: { payee: "0.0.1001", amountTinybars: 20_000_000, token: "HBAR", purpose: "Venue" },
  transfer: { payee: "0.0.9999", amountTinybars: 90_000_000, token: "HBAR" },
};
const record = (decision: string | null, matches = true, large = false, extra = {}) => ({
  proposal, check: { matches, mismatches: matches ? [] : [{ field: "payee" }] }, large,
  lastOutcome: decision ? { decision, ...extra } : null,
});

test("mismatched previews never imply a recorded refusal", async () => {
  const { decisionModel } = await load();
  const model = decisionModel(record(null, false));
  assert.equal(model.decision, "UNSUBMITTED");
  assert.equal(model.pose, "idle");
  assert.equal(model.hasOutcome, false);
  assert.equal(model.stages[3].state, "wait");
});

test("only SIGNED puts a signature on the receipt", async () => {
  const { decisionModel } = await load();
  for (const [decision, pose, state] of [
    ["SIGNED", "signed", "pass"], ["REFUSED", "refused", "fail"],
    ["CANCELLED", "refused", "fail"], ["PENDING_CHALLENGE", "wait", "wait"],
  ]) {
    const model = decisionModel(record(decision));
    assert.equal(model.pose, pose, decision);
    assert.equal(model.stages[3].state, state, decision);
  }
});

test("failed field checks stop before the World ID gate", async () => {
  const { decisionModel } = await load();
  const model = decisionModel(record("REFUSED", false, true));
  assert.equal(model.stop, 1);
  assert.equal(model.stages[2].state, "skip");
  assert.equal(model.stages[2].note, "Not reached");
});

test("routine transfers skip World ID without pretending approval", async () => {
  const { decisionModel } = await load();
  const model = decisionModel(record("SIGNED"));
  assert.equal(model.stop, 3);
  assert.equal(model.stages[2].state, "skip");
  assert.equal(model.stages[2].note, "Not required");
});

test("challenge windows wait at the receipt after passing the gate", async () => {
  const { decisionModel } = await load();
  const model = decisionModel(record("PENDING_CHALLENGE", true, true));
  assert.equal(model.stop, 3);
  assert.equal(model.stages[2].state, "pass");
  assert.equal(model.stages[3].note, "Challenge window");
});

test("World ID refusal requires gate evidence, not any refusal", async () => {
  const { decisionModel } = await load();
  const blocked = decisionModel(record("REFUSED", true, true, { worldGateReason: "Approval expired" }));
  assert.equal(blocked.stop, 2);
  assert.equal(blocked.stages[2].state, "fail");
  const policy = decisionModel(record("REFUSED", true, true));
  assert.equal(policy.stop, 1);
  assert.notEqual(policy.stages[2].state, "fail");
});

test("empty records contain no passed stages", async () => {
  const { decisionModel } = await load();
  const model = decisionModel(null);
  assert.equal(model.decision, "EMPTY");
  assert.equal(model.hasOutcome, false);
  assert.ok(model.stages.every((stage: { state: string }) => stage.state !== "pass"));
});

test("coin comparison preserves tinybar precision and distinguishes payee mismatch", async () => {
  const { transferModel } = await load();
  const model = transferModel(proposal);
  assert.equal(model.amountMatch, false);
  assert.equal(model.payeeMatch, false);
  assert.equal(model.described.amount, "0.2 HBAR");
  assert.equal(model.actual.amount, "0.9 HBAR");
  assert.ok(model.described.coins < model.actual.coins);
  assert.equal(model.actual.coins, 12);
  const tiny = transferModel({ ...proposal,
    description: { ...proposal.description, amountTinybars: 1 },
    transfer: { ...proposal.transfer, amountTinybars: 2, payee: "0.0.1001" },
  });
  assert.equal(tiny.described.amount, "0.00000001 HBAR");
  assert.equal(tiny.actual.amount, "0.00000002 HBAR");
  assert.equal(tiny.payeeMatch, true);
});

test("maximum safe tinybar amounts keep their final decimal digit", async () => {
  const { transferModel } = await load();
  const model = transferModel({ ...proposal, description: { ...proposal.description, amountTinybars: Number.MAX_SAFE_INTEGER } });
  assert.equal(model.described.amount, "90,071,992.54740991 HBAR");
});

test("matching amounts do not hide a payee-only or token mismatch", async () => {
  const { transferModel } = await load();
  const model = transferModel({ ...proposal, transfer: { ...proposal.transfer, amountTinybars: 20_000_000 } });
  assert.equal(model.amountMatch, true);
  assert.equal(model.payeeMatch, false);
  assert.equal(model.described.coins, model.actual.coins);
  const token = transferModel({ ...proposal, transfer: { ...proposal.description, token: "OTHER" } });
  assert.equal(token.tokenMatch, false);
});
