// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// Standing instructions (mandates) and council votes: parser, strict rules,
// 0G compile (fail closed), evaluation, and the HTTP flow end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { hashSignal } from "@worldcoin/idkit-core";
import type { ChainPort } from "../src/chain.js";
import {
  castBallot,
  compileMandate,
  evaluateMandate,
  openTally,
  parseMandateText,
  summarize,
  validateRules,
  voteSignal,
  type MandateRules,
} from "../src/mandate.js";
import type { OnChainSchedule } from "../src/mirror.js";
import type { Proposal } from "../src/proposal.js";
import { createApp, type AppOptions } from "../src/server.js";
import { StateStore } from "../src/store.js";

const HBAR = 100_000_000;
const ZG = { apiKey: "sk-test", baseUrl: "https://zg.test/v1", model: "0gm-1.0-35b-a3b" };
const NOKEY = { ...ZG, apiKey: "" };
const EXAMPLE = "Pay registered vendors up to 50 HBAR each, at most 200 HBAR a month. Anything else goes to the council.";

const prop = (id: string, hbar: number, payee = "0.0.1001", purpose = "Pay the venue"): Proposal => ({
  id,
  description: { payee, amountTinybars: hbar * HBAR, token: "HBAR", purpose },
  transfer: { payee, amountTinybars: hbar * HBAR, token: "HBAR" },
  createdAt: new Date().toISOString(),
});

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withServer(opts: AppOptions, fn: (call: Call) => Promise<void>) {
  // Tests run the demo fallback explicitly: no credentials, DEMO_MODE=1.
  // The setup-required gate is covered in test/runmode.test.ts.
  const app = await createApp({ statePath: null, ...opts, env: { DEMO_MODE: "1", ...(opts.env ?? {}) } });
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
}

// The first seat founds the council; later seats join with an invite from a seat holder.
const invite = async (call: Call, by: string) => {
  const r = await call("POST", "/council/invites", { mocked: true, byNullifier: `mock:${by}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.code as string;
};
const joinAs = async (call: Call, n: string, by?: string) => call("POST", "/council/join", { mocked: true, nullifier: n, ...(by ? { invite: await invite(call, by) } : {}) });
const join3 = async (call: Call) => {
  for (const [n, by] of [["a"], ["b", "a"], ["c", "a"]]) assert.equal((await joinAs(call, n!, by)).status, 200);
};
const ballot = (call: Call, path: string, who: string, choice: "yes" | "no") => call("POST", path, { choice, mocked: true, byNullifier: `mock:${who}` });
const adopt = async (call: Call, text = EXAMPLE) => {
  const d = await call("POST", "/mandate/draft", { text });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  await ballot(call, `/mandate/${d.body.id}/vote`, "a", "yes");
  const r = await ballot(call, `/mandate/${d.body.id}/vote`, "b", "yes");
  assert.equal(r.body.mandate.status, "adopted");
  return r.body.mandate;
};
const events = async (call: Call) => (await call("GET", "/audit")).body.entries as Array<{ event: string; detail: string; proposalId: string; meta?: any }>;

// ---- parser ----

test("parser: the owner's example, and the explicit-payee example", () => {
  const a = parseMandateText(EXAMPLE);
  assert.deepEqual(a, { ok: true, rules: { maxPerPaymentTinybars: 50 * HBAR, monthlyCapTinybars: 200 * HBAR, payees: "registered", purposes: [], outsideMandate: "vote" } });
  const b = parseMandateText("Up to 10 HBAR per payment to 0.0.1001 or 0.0.1002 for venue, catering. Refuse anything else.");
  assert.deepEqual(b, { ok: true, rules: { maxPerPaymentTinybars: 10 * HBAR, monthlyCapTinybars: null, payees: ["0.0.1001", "0.0.1002"], purposes: ["venue", "catering"], outsideMandate: "refuse" } });
});

test("parser: per-payment and monthly phrasings, any payee, reject, decimals", () => {
  const r = (t: string) => {
    const p = parseMandateText(t);
    assert.ok(p.ok, t);
    return p.rules;
  };
  assert.equal(r("max 5 HBAR, 40 HBAR per month").maxPerPaymentTinybars, 5 * HBAR);
  assert.equal(r("max 5 HBAR, 40 HBAR per month").monthlyCapTinybars, 40 * HBAR);
  assert.equal(r("2.5 HBAR each, monthly cap of 30 HBAR").monthlyCapTinybars, 30 * HBAR);
  assert.equal(r("2.5 HBAR each, monthly cap of 30 HBAR").maxPerPaymentTinybars, 250_000_000);
  assert.equal(r("Any payee, up to 3 HBAR").payees, "any");
  assert.equal(r("Pay registered payees up to 3 HBAR. Reject anything else.").outsideMandate, "refuse");
  assert.deepEqual(r("Up to 3 HBAR for the venue and catering").purposes, ["venue", "catering"]);
  assert.deepEqual(parseMandateText("Pay the vendors whatever they ask"), { ok: false, error: "say how much one payment may be" });
  assert.deepEqual(parseMandateText("At most 200 HBAR a month"), { ok: false, error: "say how much one payment may be" });
});

test("summary lines are produced by code from the rules", () => {
  const p = parseMandateText(EXAMPLE);
  assert.ok(p.ok);
  assert.deepEqual(summarize(p.rules), [
    "One payment: at most 50 HBAR",
    "Per month: at most 200 HBAR",
    "Recipients: registered payees only",
    "Purposes: any",
    "Anything else: council vote",
  ]);
});

// ---- strict validation ----

test("validateRules: rejects unknown keys, missing keys and out-of-range values", () => {
  const good: MandateRules = { maxPerPaymentTinybars: 1, monthlyCapTinybars: null, payees: "any", purposes: [], outsideMandate: "vote" };
  assert.equal(validateRules(good).ok, true);
  const bad: unknown[] = [
    null,
    [],
    "x",
    { ...good, extra: 1 },
    { maxPerPaymentTinybars: 1, payees: "any", purposes: [], outsideMandate: "vote" },
    { ...good, maxPerPaymentTinybars: 0 },
    { ...good, maxPerPaymentTinybars: 1.5 },
    { ...good, maxPerPaymentTinybars: "5" },
    { ...good, monthlyCapTinybars: -1 },
    { ...good, payees: "everyone" },
    { ...good, payees: [] },
    { ...good, payees: ["alice"] },
    { ...good, purposes: "venue" },
    { ...good, purposes: [""] },
    { ...good, purposes: [3] },
    { ...good, outsideMandate: "sign" },
  ];
  for (const b of bad) assert.equal(validateRules(b).ok, false, JSON.stringify(b));
  const norm = validateRules({ ...good, purposes: [" Venue ", "venue"], payees: ["0.0.1", "0.0.1"] });
  assert.deepEqual(norm.ok && [norm.rules.purposes, norm.rules.payees], [["venue"], ["0.0.1"]]);
});

// ---- 0G compile ----

function fakeZeroG(content: string, seen: any[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init?.body)), headers: init?.headers });
    return new Response(JSON.stringify({ id: "chatcmpl-1", x_0g_trace: { request_id: "0g-req-42" }, choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;
}

test("compile: a keyed 0G call returns strict JSON rules and records the request id", async () => {
  const seen: any[] = [];
  const rules = { maxPerPaymentTinybars: 50 * HBAR, monthlyCapTinybars: 200 * HBAR, payees: "registered", purposes: [], outsideMandate: "vote" };
  const r = await compileMandate(EXAMPLE, ZG, fakeZeroG(JSON.stringify(rules), seen));
  assert.deepEqual(r, { ok: true, rules, source: "0g", requestId: "0g-req-42", model: ZG.model });
  assert.equal(seen[0].url, "https://zg.test/v1/chat/completions");
  assert.equal(seen[0].body.temperature, 0);
  assert.match(seen[0].body.messages[0].content, /JSON/);
  assert.match(seen[0].body.messages[0].content, /Pay registered vendors/);
  const fenced = await compileMandate(EXAMPLE, ZG, fakeZeroG("```json\n" + JSON.stringify(rules) + "\n```"));
  assert.equal(fenced.ok, true);
});

test("compile: invalid JSON, invalid rules or a 0G outage fail closed", async () => {
  const notJson = await compileMandate(EXAMPLE, ZG, fakeZeroG("Sure! Here are the rules: max 50 HBAR"));
  assert.deepEqual(notJson, { ok: false, error: "0G did not return valid JSON rules, failing closed", requestId: "0g-req-42" });
  const extra = await compileMandate(EXAMPLE, ZG, fakeZeroG(JSON.stringify({ maxPerPaymentTinybars: 1, monthlyCapTinybars: null, payees: "any", purposes: [], outsideMandate: "vote", signAnyway: true })));
  assert.equal(extra.ok, false);
  assert.match(!extra.ok ? extra.error : "", /invalid rules \(unknown field\(s\): signAnyway\), failing closed/);
  const down = await compileMandate(EXAMPLE, ZG, (async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
  assert.equal(down.ok, false);
  const sim = await compileMandate(EXAMPLE, NOKEY);
  assert.equal(sim.ok && sim.source, "simulated");
  assert.match(sim.ok ? sim.model : "", /SIMULATED/);
});

test("HTTP compile: 0G output that fails validation is 422, and no draft is created", async () => {
  await withServer({ env: { ZERO_G_API_KEY: "sk-test", ZERO_G_BASE_URL: "https://zg.test/v1", ALLOW_NO_0G: "true" }, zeroGFetch: fakeZeroG("not json") }, async (call) => {
    await join3(call);
    const r = await call("POST", "/mandate/draft", { text: EXAMPLE });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /failing closed/);
    assert.equal(r.body.requestId, "0g-req-42");
    assert.deepEqual((await call("GET", "/mandate")).body.drafts, []);
  });
});

// ---- evaluation ----

test("evaluateMandate: plain-sentence violations", () => {
  const rules: MandateRules = { maxPerPaymentTinybars: 40 * HBAR, monthlyCapTinybars: 200 * HBAR, payees: "registered", purposes: ["venue", "catering"], outsideMandate: "vote" };
  const p = prop("E-1", 45, "0.0.9001", "party");
  const r = evaluateMandate(rules, p, { spentThisMonthTinybars: 185 * HBAR, payeeStatus: "unregistered" });
  assert.deepEqual(r, {
    within: false,
    violations: [
      "45 HBAR is over the 40 HBAR per-payment limit",
      "would bring this month to 230 of 200 HBAR",
      "0.0.9001 is not a registered payee — new recipient",
      "purpose 'party' is not one of: venue, catering",
    ],
  });
  assert.deepEqual(evaluateMandate(rules, prop("E-2", 40, "0.0.1001", "Venue deposit"), { spentThisMonthTinybars: 160 * HBAR, payeeStatus: "registered" }), { within: true, violations: [] });
  const listed = evaluateMandate({ ...rules, payees: ["0.0.1001"] }, prop("E-3", 1, "0.0.1002", "venue"), { spentThisMonthTinybars: 0, payeeStatus: "registered" });
  assert.deepEqual(listed.violations, ["0.0.1002 is not one of the allowed payees: 0.0.1001"]);
});

test("tally: needed is a majority, failed as soon as yes can no longer win", () => {
  assert.equal(openTally(["s1", "s2", "s3"]).needed, 2);
  assert.equal(openTally(["s1", "s2", "s3", "s4"]).needed, 3);
  let t = openTally(["s1", "s2", "s3", "s4"]);
  const at = new Date().toISOString();
  for (const seat of ["s1", "s2"]) {
    const c = castBallot(t, { seat, choice: "no", at, source: "mocked" }, "P");
    assert.ok(c.ok);
    t = c.tally;
  }
  assert.equal(t.status, "failed");
  assert.equal(voteSignal("P-7", "fp", "yes").startsWith("council-vote:P-7:"), true);
  assert.notEqual(voteSignal("P-7", "fp", "yes"), voteSignal("P-7", "fp2", "yes"));
});

// ---- HTTP: adoption ----

test("adoption: draft opens a vote over current seats; 2 of 3 adopt; a new one supersedes; MANDATE_ADOPTED is anchored", async () => {
  await withServer({ env: {} }, async (call) => {
    assert.equal((await call("POST", "/mandate/draft", { text: EXAMPLE })).status, 409);
    await join3(call);
    assert.equal((await call("POST", "/mandate/draft", { text: "  " })).status, 400);
    assert.equal((await call("POST", "/mandate/draft", { text: "x".repeat(1001) })).status, 400);
    assert.equal((await call("POST", "/mandate/draft", { text: "pay whoever" })).status, 422);
    const d = await call("POST", "/mandate/draft", { text: EXAMPLE });
    assert.equal(d.status, 201);
    assert.equal(d.body.id, "M-1");
    assert.equal(d.body.status, "open");
    assert.equal(d.body.source, "simulated");
    assert.deepEqual(d.body.vote, { eligible: ["council-seat:1", "council-seat:2", "council-seat:3"], needed: 2, yes: 0, no: 0, ballots: [], status: "open" });
    assert.equal(d.body.summary[0], "One payment: at most 50 HBAR");
    const v1 = await ballot(call, "/mandate/M-1/vote", "a", "yes");
    assert.equal(v1.body.recorded, true);
    assert.equal(v1.body.mandate.status, "open");
    assert.equal((await ballot(call, "/mandate/M-1/vote", "a", "no")).status, 409);
    const v2 = await ballot(call, "/mandate/M-1/vote", "b", "yes");
    assert.equal(v2.body.vote.status, "passed");
    assert.equal(v2.body.mandate.status, "adopted");
    assert.equal(typeof v2.body.mandate.adoptedAudit.auditSeq, "number");
    assert.equal((await ballot(call, "/mandate/M-1/vote", "c", "yes")).status, 409);
    const m = (await call("GET", "/mandate")).body;
    assert.equal(m.active.id, "M-1");
    assert.equal(m.monthKey, new Date().toISOString().slice(0, 7));
    assert.equal(m.spentThisMonthTinybars, 0);
    const adopted = (await events(call)).filter((e) => e.event === "MANDATE_ADOPTED");
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0]!.meta.rulesHash, d.body.rulesHash);
    assert.equal(adopted[0]!.meta.textHash, d.body.textHash);
    assert.equal(adopted[0]!.proposalId, "M-1");
    // The seats list carries how many ballots each seat has cast (the council
    // page links every row to that member's page and shows the count).
    const seats = (await call("GET", "/council/seats")).body.seats as Array<{ seat: string; ballots: number }>;
    assert.deepEqual(Object.fromEntries(seats.map((s) => [s.seat, s.ballots])), { "council-seat:1": 1, "council-seat:2": 1, "council-seat:3": 0 });
    assert.ok((await events(call)).some((e) => e.event === "VOTE" && e.detail === "council-seat:2 voted yes on M-1 (2 of 2 needed)"));
    assert.equal((await call("GET", "/policy")).body.mandate.rulesHash, d.body.rulesHash);
    assert.match((await call("GET", "/health")).body.mandate, /^M-1 /);

    // A second instruction supersedes the first once adopted; a rejected one changes nothing.
    const d2 = await call("POST", "/mandate/draft", { text: "Up to 10 HBAR each. Refuse anything else." });
    await ballot(call, "/mandate/M-2/vote", "b", "no");
    const no2 = await ballot(call, "/mandate/M-2/vote", "c", "no");
    assert.equal(no2.body.mandate.status, "rejected");
    assert.equal((await call("GET", "/mandate")).body.active.id, "M-1");
    assert.equal(d2.body.id, "M-2");
    await adopt(call, "Up to 20 HBAR each, 100 HBAR a month.");
    const after = (await call("GET", "/mandate")).body;
    assert.equal(after.active.id, "M-3");
    assert.deepEqual(after.drafts.map((x: any) => [x.id, x.status]), [["M-3", "adopted"], ["M-2", "rejected"], ["M-1", "superseded"]]);
    assert.match((await events(call)).filter((e) => e.event === "MANDATE_ADOPTED").at(-1)!.detail, /supersedes M-1/);
  });
});

// ---- HTTP: payments under a mandate ----

test("within the mandate: a LARGE payment signs with no World ID approval and no vote", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call);
    const r = await call("POST", "/proposals", { proposal: prop("IN-1", 40) });
    assert.equal(r.body.decision, "SIGNED");
    assert.match(r.body.reason, /^Within standing instruction M-1\./);
    assert.deepEqual(r.body.mandate, { id: "M-1", rulesHash: (await call("GET", "/mandate")).body.active.rulesHash, within: true, violations: [] });
    assert.equal(r.body.usedWorldApproval, false);
    assert.equal(r.body.vote, null);
    assert.equal((await call("GET", "/mandate")).body.spentThisMonthTinybars, 40 * HBAR);
    const item = (await call("GET", "/proposals")).body.proposals[0];
    assert.deepEqual(item.mandate, { id: "M-1", within: true, violations: [] });
    assert.equal(item.vote, null);
  });
});

test("outside the mandate: PENDING_VOTE; 2 yes signs with exactly one check payment", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call);
    const capBefore = (await call("GET", "/health")).body.spendCapRemaining;
    const r = await call("POST", "/proposals", { proposal: prop("OUT-1", 60) });
    assert.equal(r.body.decision, "PENDING_VOTE");
    assert.equal(r.body.scheduledTxId, null);
    assert.deepEqual(r.body.mandate.violations, ["60 HBAR is over the 50 HBAR per-payment limit"]);
    assert.equal(r.body.vote.needed, 2);
    const capAfterCheck = (await call("GET", "/health")).body.spendCapRemaining;
    assert.notEqual(capAfterCheck, capBefore);
    // Resubmitting does not pay again or open a second vote.
    const again = await call("POST", "/proposals", { proposal: prop("OUT-1", 60) });
    assert.equal(again.body.decision, "PENDING_VOTE");
    assert.match(again.body.note, /not re-processed/);
    assert.equal((await call("POST", "/proposals/OUT-1/execute")).status, 409);
    const votes = (await call("GET", "/council/votes")).body;
    assert.equal(votes.open.length, 1);
    assert.deepEqual([votes.open[0].subject, votes.open[0].kind, votes.open[0].amountTinybars, votes.open[0].payee], ["OUT-1", "proposal", 60 * HBAR, "0.0.1001"]);
    const v1 = await ballot(call, "/proposals/OUT-1/vote", "a", "yes");
    assert.equal(v1.body.outcome.decision, "PENDING_VOTE");
    assert.equal(v1.body.vote.yes, 1);
    const v2 = await ballot(call, "/proposals/OUT-1/vote", "c", "yes");
    assert.equal(v2.body.recorded, true);
    assert.equal(v2.body.outcome.decision, "SIGNED");
    assert.equal(v2.body.outcome.paidTxId, r.body.paidTxId);
    assert.match(v2.body.outcome.reason, /Council vote passed/);
    assert.equal((await call("GET", "/health")).body.spendCapRemaining, capAfterCheck);
    const ev = (await events(call)).filter((e) => e.proposalId === "OUT-1").map((e) => e.event);
    assert.deepEqual(ev, ["VOTE_OPENED", "VOTE", "VOTE", "VOTE_PASSED", "SIGNED"]);
    assert.equal((await ballot(call, "/proposals/OUT-1/vote", "b", "yes")).status, 409);
    const closed = (await call("GET", "/council/votes")).body;
    assert.deepEqual([closed.open.filter((i: any) => i.kind === "proposal").length, closed.closed.find((i: any) => i.subject === "OUT-1").decision], [0, "SIGNED"]);
    assert.equal((await call("GET", "/mandate")).body.spentThisMonthTinybars, 60 * HBAR);
    assert.equal((await call("POST", "/proposals", { proposal: prop("OUT-1", 60) })).status, 409);
  });
});

test("outside the mandate: 2 no refuses with VOTE_FAILED; double ballot 409; strangers and later joiners 403", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call);
    assert.equal((await call("POST", "/proposals", { proposal: prop("NO-1", 60, "0.0.1002", "Pay a party") })).body.decision, "PENDING_VOTE");
    assert.equal((await call("POST", "/proposals", { proposal: prop("NO-0", 10, "0.0.1002", "Pay the venue") })).body.decision, "SIGNED");
    // Joined after the vote opened: not eligible.
    assert.equal((await joinAs(call, "late", "b")).status, 200);
    const late = await ballot(call, "/proposals/NO-1/vote", "late", "yes");
    assert.equal(late.status, 403);
    assert.match(late.body.error, /was not on the council when the vote/);
    assert.equal((await ballot(call, "/proposals/NO-1/vote", "nobody", "yes")).status, 403);
    assert.equal((await call("POST", "/proposals/NO-1/vote", { choice: "maybe", mocked: true, byNullifier: "mock:a" })).status, 400);
    assert.equal((await ballot(call, "/proposals/NOPE/vote", "a", "yes")).status, 404);
    assert.equal((await ballot(call, "/proposals/NO-0/vote", "a", "yes")).status, 409);
    await ballot(call, "/proposals/NO-1/vote", "a", "no");
    assert.equal((await ballot(call, "/proposals/NO-1/vote", "a", "no")).status, 409);
    const member = (await call("GET", "/council/members/council-seat:2")).body;
    assert.equal(member.awaiting.length, 1);
    assert.equal(member.awaiting[0].subject, "NO-1");
    const v = await ballot(call, "/proposals/NO-1/vote", "b", "no");
    assert.equal(v.body.outcome.decision, "REFUSED");
    assert.equal(v.body.vote.status, "failed");
    assert.match(v.body.outcome.reason, /Council vote failed/);
    assert.equal((await events(call)).at(-1)!.event, "VOTE_FAILED");
    const seat1 = (await call("GET", "/council/members/council-seat:1")).body;
    assert.deepEqual(seat1.ballots.map((b: any) => [b.subject, b.kind, b.choice]), [["NO-1", "proposal", "no"], ["M-1", "mandate", "yes"]]);
    assert.deepEqual(seat1.awaiting, []);
    assert.equal((await call("GET", "/council/members/council-seat:99")).status, 404);
  });
});

test("outsideMandate refuse: REFUSED_OUTSIDE_MANDATE, no vote", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call, "Up to 10 HBAR per payment to 0.0.1001 or 0.0.1002 for venue, catering. Refuse anything else.");
    const r = await call("POST", "/proposals", { proposal: prop("RF-1", 5, "0.0.1003", "venue") });
    assert.equal(r.body.decision, "REFUSED");
    assert.equal(r.body.vote, null);
    assert.equal((await events(call)).at(-1)!.event, "REFUSED_OUTSIDE_MANDATE");
    assert.equal((await call("POST", "/proposals", { proposal: prop("RF-2", 5, "0.0.1002", "Catering for day 2") })).body.decision, "SIGNED");
  });
});

test("monthly cap uses recorded spends", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call, "Up to 50 HBAR each, at most 100 HBAR a month.");
    assert.equal((await call("POST", "/proposals", { proposal: prop("C-1", 50) })).body.decision, "SIGNED");
    assert.equal((await call("POST", "/proposals", { proposal: prop("C-2", 40, "0.0.1002") })).body.decision, "SIGNED");
    const r = await call("POST", "/proposals", { proposal: prop("C-3", 20, "0.0.1003") });
    assert.equal(r.body.decision, "PENDING_VOTE");
    assert.deepEqual(r.body.mandate.violations, ["would bring this month to 110 of 100 HBAR"]);
    assert.equal((await call("GET", "/mandate")).body.spentThisMonthTinybars, 90 * HBAR);
  });
});

test("concurrent proposals cannot both fit under the monthly cap", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call, "Up to 50 HBAR each, at most 60 HBAR a month.");
    const [a, b] = await Promise.all([
      call("POST", "/proposals", { proposal: prop("Q-1", 40) }),
      call("POST", "/proposals", { proposal: prop("Q-2", 40, "0.0.1002") }),
    ]);
    assert.deepEqual([a.body.decision, b.body.decision].sort(), ["PENDING_VOTE", "SIGNED"]);
  });
});

test("revoke cancels PENDING_VOTE proposals and closes open instruction votes", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    await adopt(call);
    await call("POST", "/proposals", { proposal: prop("RV-1", 70) });
    await call("POST", "/mandate/draft", { text: "Up to 1 HBAR each." });
    const open = await call("POST", "/council/revoke", { mocked: true, byNullifier: "mock:a", seat: "council-seat:3" });
    assert.equal(open.status, 202);
    assert.deepEqual([open.body.voteOpened, open.body.subject, open.body.vote.eligible, open.body.vote.needed], [true, "R-1", ["council-seat:1", "council-seat:2"], 2]);
    // Nothing happens until the other seats decide.
    assert.equal((await call("GET", "/council/epoch")).body.epoch, 1);
    await ballot(call, "/council/revocations/R-1/vote", "a", "yes");
    const closing = await ballot(call, "/council/revocations/R-1/vote", "b", "yes");
    assert.equal(closing.body.removed, true);
    const r = closing.body.revocation;
    assert.equal(r.by, "council vote R-1");
    assert.deepEqual(r.cancelledProposals, ["RV-1"]);
    assert.deepEqual(r.closedMandateVotes, ["M-2"]);
    assert.match(r.detail, /1 pending proposals cancelled, 1 open instruction votes closed, removed by council vote R-1 \(2 of 2\)$/);
    const rejected = (await events(call)).filter((e) => e.event === "MANDATE_REJECTED");
    assert.deepEqual(rejected.map((e) => [e.proposalId, typeof e.meta?.rulesHash]), [["M-2", "string"]]);
    assert.equal((await ballot(call, "/proposals/RV-1/vote", "a", "yes")).status, 409);
    assert.equal((await ballot(call, "/mandate/M-2/vote", "a", "yes")).status, 409);
    const m = (await call("GET", "/mandate")).body;
    assert.equal(m.drafts[0].status, "rejected");
    assert.equal(m.active.id, "M-1");
    const votes = (await call("GET", "/council/votes")).body;
    assert.deepEqual(votes.open, []);
    assert.equal(votes.closed.find((i: any) => i.subject === "RV-1").decision, "CANCELLED");
  });
});

test("no mandate: behaviour unchanged (large payment needs World ID; no vote fields set)", async () => {
  await withServer({ env: {} }, async (call) => {
    await join3(call);
    const r = await call("POST", "/proposals", { proposal: prop("NM-1", 60) });
    assert.equal(r.body.decision, "REFUSED");
    assert.match(r.body.reason, /World ID gate blocked signing/);
    assert.equal(r.body.approveUrl, "/console.html?proposal=NM-1");
    assert.equal(r.body.mandate, null);
    assert.equal(r.body.vote, null);
    assert.equal((await call("POST", "/proposals", { proposal: prop("NM-2", 0.1) })).body.decision, "SIGNED");
    assert.equal((await ballot(call, "/proposals/NM-2/vote", "a", "yes")).status, 409);
    assert.equal((await call("GET", "/mandate")).body.active, null);
    assert.equal((await call("GET", "/policy")).body.mandate, null);
    assert.match((await call("GET", "/health")).body.mandate, /^none/);
  });
});

test("mocked join returns the stored, mock:-prefixed nullifier", async () => {
  await withServer({ env: {} }, async (call) => {
    const j = await call("POST", "/council/join", { mocked: true, nullifier: "me" });
    assert.deepEqual([j.body.joined, j.body.seat, j.body.nullifier, j.body.founder], [true, "council-seat:1", "mock:me", true]);
  });
});

test("concurrent final ballots: the proposal is signed exactly once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let signs = 0;
  const sched: OnChainSchedule = {
    scheduleId: "0.0.7777", memo: "", creator: "0.0.6000", payer: "0.0.6000", executed: false, deleted: false, signedBy: 1,
    hbarTransfers: [], transfer: { from: "0.0.5000", payee: "0.0.1001", amountTinybars: 60 * HBAR, token: "HBAR" }, problem: null,
  };
  const chain: ChainPort = {
    resolve: async () => sched,
    sign: async (id) => { signs += 1; await gate; return { scheduleId: id, action: "signed" }; },
  };
  await withServer({ env: {}, chain }, async (call) => {
    await join3(call);
    await adopt(call);
    for (const n of ["d", "e"]) assert.equal((await joinAs(call, n, "a")).status, 200);
    assert.equal((await call("POST", "/proposals", { proposal: prop("CC-1", 60) })).body.decision, "PENDING_VOTE");
    await ballot(call, "/proposals/CC-1/vote", "a", "yes");
    await ballot(call, "/proposals/CC-1/vote", "b", "yes");
    const both = Promise.all([ballot(call, "/proposals/CC-1/vote", "c", "yes"), ballot(call, "/proposals/CC-1/vote", "d", "yes")]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const rs = await both;
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(rs.find((r) => r.status === 200)!.body.outcome.decision, "SIGNED");
    assert.equal(signs, 1);
    assert.equal((await events(call)).filter((e) => e.proposalId === "CC-1" && e.event === "SIGNED").length, 1);
    assert.equal((await call("GET", "/mandate")).body.spentThisMonthTinybars, 60 * HBAR);
  });
});

// ---- HTTP: real World ID ballots ----

const WORLD_ENV = { WORLD_RP_ID: "rp_test", WORLD_APP_ID: "app_test", WORLD_SIGNING_KEY: "0x" + "11".repeat(32) };
const fakeWorld = (async (_u: string, init?: RequestInit) => {
  const b = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ success: true, action: b.action, environment: b.environment, results: [{ identifier: "proof_of_human", success: true, nullifier: b.responses[0].nullifier }] }), { status: 200 });
}) as typeof fetch;
const proof = (nullifier: string, signal: string, action = "join-council", nonce = "0x1") => ({
  protocol_version: "4.0", nonce, action, environment: "production",
  responses: [{ identifier: "proof_of_human", issuer_schema_id: 1, nullifier, expires_at_min: 1, signal_hash: hashSignal(signal), proof: ["1", "2", "3", "4", "5"] }],
});

test("World configured: ballots are World ID proofs under join-council, bound to subject, bytes and choice", async () => {
  await withServer({ env: WORLD_ENV, worldFetch: fakeWorld }, async (call) => {
    assert.equal((await call("POST", "/council/join", { idkitResult: proof("0x1", "council-join") })).body.joined, true);
    for (const [i, n] of ["0x2", "0x3"].entries()) {
      const inv = await call("POST", "/council/invites", { seat: "council-seat:1", idkitResult: proof("0x1", "council-invite:council-seat:1", "join-council", `0xa${i}`) });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      assert.equal((await call("POST", "/council/join", { idkitResult: proof(n, "council-join"), invite: inv.body.code })).body.joined, true);
    }
    const d = (await call("POST", "/mandate/draft", { text: EXAMPLE })).body;
    const ctx = await call("POST", "/world/rp-context", { vote: true, subject: d.id, choice: "yes" });
    assert.equal(ctx.status, 200);
    assert.deepEqual([ctx.body.action, ctx.body.signal], ["join-council", voteSignal(d.id, d.rulesHash, "yes")]);
    assert.equal((await call("POST", "/world/rp-context", { vote: true, subject: "M-99", choice: "yes" })).status, 404);
    assert.equal((await call("POST", "/world/rp-context", { vote: true, subject: d.id, choice: "maybe" })).status, 400);
    // Mocked ballots are off when World is configured.
    assert.equal((await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", mocked: true, byNullifier: "0x1" })).status, 403);
    // A proof made for "no" cannot be cast as "yes"; a join proof cannot be cast as a ballot.
    const wrong = await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x1", voteSignal(d.id, d.rulesHash, "no")) });
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.error, /signal mismatch/);
    assert.equal((await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x1", "council-join") })).status, 403);
    // A person who holds no seat cannot vote.
    assert.equal((await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x9", voteSignal(d.id, d.rulesHash, "yes")) })).status, 403);
    const ok1 = await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x1", voteSignal(d.id, d.rulesHash, "yes")) });
    assert.equal(ok1.status, 200);
    assert.equal(ok1.body.vote.ballots[0].source, "world");
    assert.equal((await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x01", voteSignal(d.id, d.rulesHash, "yes")) })).status, 409);
    const ok2 = await call("POST", `/mandate/${d.id}/vote`, { choice: "yes", idkitResult: proof("0x2", voteSignal(d.id, d.rulesHash, "yes")) });
    assert.equal(ok2.body.mandate.status, "adopted");

    // A proposal ballot is bound to the proposal's registered fingerprint.
    const p = await call("POST", "/proposals", { proposal: prop("W-1", 60) });
    assert.equal(p.body.decision, "PENDING_VOTE");
    const pctx = (await call("POST", "/world/rp-context", { vote: true, subject: "W-1", choice: "no" })).body;
    const pv = await call("POST", "/proposals/W-1/vote", { choice: "no", idkitResult: proof("0x3", pctx.signal) });
    assert.equal(pv.status, 200);
    assert.equal(pv.body.vote.no, 1);
    const crossed = await call("POST", "/proposals/W-1/vote", { choice: "no", idkitResult: proof("0x2", voteSignal("W-1", d.rulesHash, "no")) });
    assert.equal(crossed.status, 403);
  });
});

// ---- persistence ----

test("store: mandates, votes and spends persist; an old state file still loads", () => {
  const file = join(mkdtempSync(join(tmpdir(), "mstate-")), "state.json");
  writeFileSync(file, JSON.stringify({ seats: [], usedApprovals: [], epoch: 3 }));
  const old = new StateStore(file);
  assert.deepEqual([old.epoch(), old.mandates(), old.votes(), old.spentThisMonth(new Date())], [3, [], [], 0]);
  const p = parseMandateText(EXAMPLE);
  assert.ok(p.ok);
  old.addMandate({ text: EXAMPLE, rules: p.rules, summary: summarize(p.rules), source: "simulated", requestId: null, model: "m", rulesHash: "h", textHash: "t", createdAt: "2026-11-06T00:00:00.000Z", status: "open", vote: openTally(["s1"]) });
  old.adoptMandate("M-1", "2026-11-06T00:00:01.000Z");
  old.recordSpend({ proposalId: "P-1", amountTinybars: 5, at: "2026-11-06T01:00:00.000Z" });
  old.recordSpend({ proposalId: "P-1", amountTinybars: 5, at: "2026-11-06T01:00:00.000Z" });
  old.recordSpend({ proposalId: "P-0", amountTinybars: 7, at: "2026-10-31T23:59:59.000Z" });
  const back = new StateStore(file);
  assert.equal(back.activeMandate()?.id, "M-1");
  assert.equal(back.spentThisMonth(new Date("2026-11-20T00:00:00Z")), 5);
  assert.equal(back.addMandate({ ...back.mandate("M-1")!, status: "open" }).id, "M-2");
});

test("challenge window: inside-mandate and voted proposals wait, then execute without a World approval", async () => {
  let clock = new Date();
  await withServer({ env: { CHALLENGE_WINDOW_SECONDS: "60" }, now: () => clock }, async (call) => {
    await join3(call);
    await adopt(call, "Up to 50 HBAR each, at most 100 HBAR a month.");
    const inside = await call("POST", "/proposals", { proposal: prop("CW-1", 40) });
    assert.equal(inside.body.decision, "PENDING_CHALLENGE");
    assert.match(inside.body.reason, /^Within standing instruction M-1\./);
    const out = await call("POST", "/proposals", { proposal: prop("CW-2", 55) });
    assert.equal(out.body.decision, "PENDING_VOTE");
    await ballot(call, "/proposals/CW-2/vote", "a", "yes");
    const voted = await ballot(call, "/proposals/CW-2/vote", "b", "yes");
    assert.equal(voted.body.outcome.decision, "PENDING_CHALLENGE");
    // A third inside payment that would break the cap once CW-1 is spent.
    assert.equal((await call("POST", "/proposals", { proposal: prop("CW-3", 50, "0.0.1002") })).body.decision, "PENDING_CHALLENGE");
    clock = new Date(Date.now() + 90_000);
    const x1 = await call("POST", "/proposals/CW-1/execute");
    assert.equal(x1.body.decision, "SIGNED", x1.body.reason);
    assert.match(x1.body.worldGateReason, /standing instruction M-1/);
    const x2 = await call("POST", "/proposals/CW-2/execute");
    assert.equal(x2.body.decision, "SIGNED", x2.body.reason);
    // Re-evaluated at execution against the spend recorded since: 40 + 55 + 50 > 100.
    const x3 = await call("POST", "/proposals/CW-3/execute");
    assert.equal(x3.body.decision, "REFUSED");
    assert.match(x3.body.reason, /now outside standing instruction M-1 \(would bring this month to 145 of 100 HBAR\), ABORTED/);
    assert.equal((await call("GET", "/mandate")).body.spentThisMonthTinybars, 95 * HBAR);
  });
});
