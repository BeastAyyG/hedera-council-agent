// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// The public verifier (public/assets/chain-verify.js) must agree with
// src/auditlog.ts exactly: same hashes, same break reasons.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EMPTY_HEAD, sealEntry, verifyChain, canonical as nodeCanonical, sha256, type ChainedEntry, type ChainHead } from "../src/auditlog.js";

interface Report {
  ok: boolean;
  checked: number;
  ignored: number;
  head: ChainHead | null;
  brokenAt: number | null;
  reason: string | null;
}
interface Verifier {
  canonical(v: unknown): string;
  sha256Hex(s: string): Promise<string>;
  verifyChainAsync(m: unknown[]): Promise<Report>;
  fetchTopic(network: string, topic: string, o?: { fetchImpl?: typeof fetch; onPage?: (n: number) => void; baseUrl?: string }): Promise<unknown[]>;
}

const load = async (): Promise<Verifier> =>
  (await import(pathToFileURL(join(process.cwd(), "public/assets/chain-verify.js")).href)) as Verifier;

function buildLog(n = 5): ChainedEntry[] {
  const log: ChainedEntry[] = [];
  let head: ChainHead = EMPTY_HEAD;
  for (let i = 1; i <= n; i++) {
    const e = sealEntry(head, { proposalId: `P-${i}`, event: i % 2 ? "decision:SIGNED" : "decision:REFUSED", detail: `caf\u00e9 \u2713 ${i}`, at: `2026-11-06T00:00:0${i}Z`, policy: "ab".repeat(32) });
    log.push(e);
    head = { seq: e.seq, hash: e.hash };
  }
  return log;
}

async function same(v: Verifier, messages: unknown[]) {
  const a = await v.verifyChainAsync(messages);
  assert.deepEqual(a, verifyChain(messages));
  return a;
}

test("browser module hashes and canonicalises like src/auditlog.ts", async () => {
  const v = await load();
  const sample = { b: 1, a: [1, { z: undefined, y: "\u00e9" }], c: null };
  assert.equal(v.canonical(sample), nodeCanonical(sample));
  assert.equal(await v.sha256Hex("abc"), sha256("abc"));
});

test("intact log: same head hash as verifyChain", async () => {
  const v = await load();
  const log = buildLog();
  const r = await same(v, [...log, null, { hello: "world" }]);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 5);
  assert.equal(r.ignored, 2);
  assert.equal(r.head?.hash, log[4].hash);
});

test("edited, dropped, reordered and forged entries give the same reasons", async () => {
  const v = await load();
  const log = buildLog();

  const edited = log.map((e) => ({ ...e }));
  edited[2].detail = "changed";
  const a = await same(v, edited);
  assert.deepEqual([a.ok, a.brokenAt], [false, 3]);
  assert.match(a.reason!, /altered/);

  const dropped = [log[0], log[1], log[3], log[4]];
  const b = await same(v, dropped);
  assert.equal(b.brokenAt, 4);
  assert.match(b.reason!, /missing or out of order/);

  const reordered = [log[0], log[2], log[1], log[3], log[4]];
  const c = await same(v, reordered);
  assert.equal(c.ok, false);
  assert.match(c.reason!, /missing or out of order/);

  // Re-hashed forgery that does not link to the previous entry.
  const forged = sealEntry({ seq: 2, hash: "f".repeat(64) }, { proposalId: "P-X", event: "decision:SIGNED", detail: "x", at: "t", policy: "p" });
  const d = await same(v, [log[0], log[1], forged]);
  assert.equal(d.brokenAt, 3);
  assert.match(d.reason!, /does not link/);
});

test("fetchTopic follows pagination and decodes base64 UTF-8", async () => {
  const v = await load();
  const log = buildLog(3);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const pages: Record<string, unknown> = {
    "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.77/messages?order=asc&limit=100": {
      messages: [{ message: b64(JSON.stringify(log[0])) }, { message: b64("not json") }],
      links: { next: "/api/v1/topics/0.0.77/messages?order=asc&limit=100&sequencenumber=gt:2" },
    },
    "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.77/messages?order=asc&limit=100&sequencenumber=gt:2": {
      messages: [{ message: b64(JSON.stringify(log[1])) }, { message: b64(JSON.stringify(log[2])) }],
      links: { next: null },
    },
  };
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    const body = pages[url];
    return new Response(body ? JSON.stringify(body) : "nope", { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;
  const counts: number[] = [];
  const messages = await v.fetchTopic("testnet", "0.0.77", { fetchImpl, onPage: (n) => counts.push(n) });
  assert.equal(seen.length, 2);
  assert.deepEqual(counts, [2, 4]);
  assert.equal(messages[1], null);
  assert.deepEqual(messages[0], log[0]);
  const r = await v.verifyChainAsync(messages);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 3);
  assert.equal(r.ignored, 1);
  await assert.rejects(v.fetchTopic("testnet", "0.0.78", { fetchImpl }), /404/);
  await assert.rejects(v.fetchTopic("testnet", "bad", { fetchImpl }), /not a topic id/);
});
