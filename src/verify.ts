// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Replayable audit of one decision: npm run verify -- <proposalId> [--server URL]
// It takes the evidence bundle and the policy from the server, then checks
// them against things the server cannot change after the fact: the digest and
// hashes recomputed here, and the audit topic. In real mode the topic is read
// from a Hedera mirror node, never from the server. In simulated mode there is
// no mirror node, so the server's own log is read and labelled as such.

import { canonical, entryHash, isChainedEntry, sha256, verifyChain, type ChainedEntry } from "./auditlog.js";
import { fetchTopicMessages, parseMessages } from "./mirror.js";
import { proposalFingerprint, type Proposal } from "./proposal.js";
import { proposalSignal } from "./world.js";

export type CheckStatus = "PASS" | "FAIL" | "WARN";
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

// Loose shape of GET /proposals/:id/evidence; every field is checked before use.
export interface EvidenceBundle {
  proposalId: string;
  decision: string;
  reason?: string;
  mode: string;
  policyHash: string;
  proposal: Proposal;
  payment: { via?: string; id: string | null };
  zeroG: { source: string; requestId: string | null; verdict?: string };
  schedule: { id: string | null; action?: string | null };
  audit: { txId?: string | null; seq: number | null; entryHash: string | null; topicId: string | null };
  digest: string;
  [k: string]: unknown;
}

export interface PublishedPolicy {
  policy: unknown;
  hash: string;
}

export interface VerifyOptions {
  // Where the audit messages came from.
  auditSource: "mirror" | "server";
  // The reader stopped before the end of the topic.
  truncated?: boolean;
}

const short = (s: string | null | undefined, n = 16) => (s ? `${s.slice(0, n)}…` : "none");
const res = (name: string, status: CheckStatus, detail: string): CheckResult => ({ name, status, detail });

// Hash-chain check that also accepts a log starting after entry 1 (the server's
// /audit returns only the latest 100 entries): links are checked from the first entry given.
function checkChain(messages: unknown[]): { ok: boolean; detail: string; partial: boolean } {
  const entries = messages.filter(isChainedEntry);
  if (entries.length === 0) return { ok: false, detail: "the log has no entries", partial: false };
  if (entries[0].seq === 1) {
    const r = verifyChain(messages);
    return { ok: r.ok, detail: r.ok ? `${r.checked} entries, hashes and links intact` : (r.reason ?? "chain broken"), partial: false };
  }
  let prev: ChainedEntry | null = null;
  for (const e of entries) {
    const { hash, ...body } = e;
    if (entryHash(body) !== hash) return { ok: false, detail: `Entry ${e.seq} does not match its own hash, so it was altered.`, partial: true };
    if (prev && (e.seq !== prev.seq + 1 || e.prev !== prev.hash)) return { ok: false, detail: `Entry ${e.seq} does not link to the entry before it.`, partial: true };
    prev = e;
  }
  return { ok: true, detail: `last ${entries.length} entries (from ${entries[0].seq}) intact; earlier entries not available`, partial: true };
}

export function verifyBundle(bundle: EvidenceBundle, policy: PublishedPolicy, auditMessages: unknown[], opts: VerifyOptions): CheckResult[] {
  const out: CheckResult[] = [];
  const real = bundle.mode === "real";

  // 1. The bundle is what the server said it was.
  const { digest, digestOf: _digestOf, ...rest } = bundle as EvidenceBundle & { digestOf?: unknown };
  const digestNow = sha256(canonical(rest));
  out.push(
    digestNow === digest
      ? res("evidence digest", "PASS", `sha256 ${short(digestNow)} matches the bundle`)
      : res("evidence digest", "FAIL", `bundle digest ${short(digest)} but its contents hash to ${short(digestNow)}: the bundle was changed`),
  );

  // 2. The proposal and its World ID signal, recomputed here.
  try {
    const fp = sha256(proposalFingerprint(bundle.proposal));
    const sameId = bundle.proposal.id === bundle.proposalId;
    out.push(
      sameId
        ? res("proposal hash", "PASS", `${fp} (world signal ${proposalSignal(proposalFingerprint(bundle.proposal))})`)
        : res("proposal hash", "FAIL", `bundle is for ${bundle.proposalId} but its proposal is ${bundle.proposal.id}`),
    );
  } catch {
    out.push(res("proposal hash", "FAIL", "bundle has no readable proposal"));
  }

  // 3. Where the audit log came from.
  if (opts.auditSource === "mirror") {
    out.push(res("audit source", "PASS", `topic ${bundle.audit?.topicId} read from a Hedera mirror node`));
  } else {
    out.push(res("audit source", "WARN", "SIMULATED: no mirror node, reading the server log"));
  }

  // 4. The log is an unbroken chain.
  const chain = checkChain(auditMessages);
  out.push(res("audit chain", chain.ok ? (chain.partial || opts.truncated ? "WARN" : "PASS") : "FAIL", chain.detail + (opts.truncated ? " (reader stopped early)" : "")));

  // 5. The decision's entry is in the log, and says what the bundle says.
  const seq = bundle.audit?.seq;
  const entry = auditMessages.filter(isChainedEntry).find((e) => e.seq === seq);
  if (seq === null || seq === undefined) {
    out.push(res("audit entry", "FAIL", "the bundle names no audit entry for this decision"));
  } else if (!entry) {
    out.push(res("audit entry", "FAIL", `entry ${seq} is not in the log${opts.truncated ? " (reader stopped early)" : ""}`));
  } else if (entry.hash !== bundle.audit.entryHash) {
    out.push(res("audit entry", "FAIL", `entry ${seq} hash ${short(entry.hash)} differs from the bundle's ${short(bundle.audit.entryHash)}`));
  } else if (entry.proposalId !== bundle.proposalId) {
    out.push(res("audit entry", "FAIL", `entry ${seq} is for ${entry.proposalId}, not ${bundle.proposalId}`));
  } else {
    out.push(res("audit entry", "PASS", `entry ${seq} (${entry.event}) hash ${short(entry.hash)} is for ${bundle.proposalId}`));
  }

  // 5b. Decisions under a standing instruction anchor its rulesHash: it must be the
  // rulesHash the council adopted, as logged in the instruction's MANDATE_ADOPTED entry.
  const under = entry?.meta?.rulesHash;
  if (entry && under) {
    const m = bundle.mandate as { id?: string; rulesHash?: string } | undefined;
    const adoptedEntry = auditMessages.filter(isChainedEntry).find((e) => e.event === "MANDATE_ADOPTED" && (!m?.id || e.proposalId === m.id) && e.meta?.rulesHash === under);
    const label = `${m?.id ?? "instruction"} rulesHash ${short(under)}`;
    if (m?.rulesHash && m.rulesHash !== under) {
      out.push(res("instruction", "FAIL", `entry ${entry.seq} anchors rulesHash ${short(under)} but the bundle's instruction ${m.id ?? ""} is ${short(m.rulesHash)}`));
    } else if (adoptedEntry) {
      out.push(res("instruction", "PASS", `${label} matches MANDATE_ADOPTED entry ${adoptedEntry.seq}`));
    } else if (chain.partial || opts.truncated) {
      out.push(res("instruction", "WARN", `${label}: its MANDATE_ADOPTED entry is not in the part of the log that was read`));
    } else {
      out.push(res("instruction", "FAIL", `${label} is not the rulesHash of any MANDATE_ADOPTED entry in the log`));
    }
  }

  // 6. The policy: published hash is real, and the decision committed to it.
  const policyNow = sha256(canonical(policy.policy));
  if (policyNow !== policy.hash) {
    out.push(res("policy hash", "FAIL", `/policy says ${short(policy.hash)} but the policy hashes to ${short(policyNow)}`));
  } else if (bundle.policyHash !== policy.hash) {
    out.push(res("policy hash", "FAIL", `bundle policy ${short(bundle.policyHash)} differs from published ${short(policy.hash)}`));
  } else if (entry && entry.policy !== policy.hash) {
    out.push(res("policy hash", "FAIL", `audit entry ${entry.seq} committed to policy ${short(entry.policy)}, not ${short(policy.hash)}`));
  } else {
    out.push(res("policy hash", "PASS", `${short(policy.hash)} is published, in the bundle and in the audit entry`));
  }

  // 7. The 0G verdict.
  const g = bundle.zeroG;
  if (g?.source === "0g") {
    out.push(g.requestId ? res("0G verdict", "PASS", `request id ${g.requestId}`) : res("0G verdict", "FAIL", "0G verdict has no request id"));
  } else if (g?.source === "simulated") {
    out.push(res("0G verdict", "WARN", "SIMULATED (not a 0G verdict)"));
  } else if (g?.source === "unavailable") {
    out.push(res("0G verdict", "FAIL", "0G was unavailable for this decision"));
  } else {
    out.push(res("0G verdict", "WARN", `no 0G verdict recorded (source: ${g?.source ?? "none"}); decision made before the check`));
  }

  // 8 + 9. Payment and schedule ids.
  const idLine = (name: string, id: string | null | undefined, missing: CheckResult): CheckResult => {
    if (!id) return missing;
    if (!real) return res(name, "WARN", `SIM id ${id}`);
    return id.startsWith("SIM-") ? res(name, "FAIL", `${id} is a simulated id in a real-mode decision`) : res(name, "PASS", id);
  };
  out.push(idLine("payment", bundle.payment?.id, res("payment", "WARN", "no payment recorded for this decision")));
  out.push(
    idLine(
      "schedule",
      bundle.schedule?.id,
      bundle.decision === "SIGNED" ? res("schedule", "FAIL", "decision is SIGNED but no schedule id is recorded") : res("schedule", "PASS", `none, decision was ${bundle.decision}`),
    ),
  );
  // 10. Decisions that are not final or not made by the checks: say what the log shows.
  if (bundle.decision === "PENDING_CHALLENGE") {
    out.push(
      entry?.event === "PROPOSAL_CREATED"
        ? res("challenge window", "PASS", `not signed yet: ${entry.detail}`)
        : res("challenge window", "FAIL", `decision is PENDING_CHALLENGE but entry ${seq} is ${entry?.event ?? "missing"}, not PROPOSAL_CREATED`),
    );
  } else if (bundle.decision === "CANCELLED") {
    const by = (bundle.challenge as { cancelledBy?: { auditSeq: number | null; auditHash: string | null } } | undefined)?.cancelledBy;
    const rev = by?.auditSeq ? auditMessages.filter(isChainedEntry).find((e) => e.seq === by.auditSeq) : undefined;
    out.push(
      rev && rev.event === "REVOKED" && rev.hash === by?.auditHash
        ? res("cancellation", "PASS", `cancelled by entry ${rev.seq} (REVOKED): ${rev.detail}`)
        : res("cancellation", "FAIL", `decision is CANCELLED but the log has no matching REVOKED entry${opts.truncated ? " (reader stopped early)" : ""}`),
    );
  }
  return out;
}

export function summarize(results: CheckResult[]): { fail: number; warn: number; pass: number; line: string } {
  const n = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const fail = n("FAIL");
  const warn = n("WARN");
  const pass = n("PASS");
  return { fail, warn, pass, line: `${fail ? "FAIL" : "OK"}: ${pass} passed, ${warn} warnings, ${fail} failed` };
}

const COLOURS: Record<CheckStatus, string> = { PASS: "\x1b[32m", FAIL: "\x1b[31m", WARN: "\x1b[33m" };

export function formatResults(results: CheckResult[], colour: boolean): string[] {
  const tag = (s: CheckStatus) => (colour ? `${COLOURS[s]}${s}\x1b[0m` : s);
  return results.map((r) => `${tag(r.status)}  ${r.name.padEnd(16)} ${r.detail}`);
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GET ${url} returned HTTP ${r.status}`);
  return r.json();
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const si = args.indexOf("--server");
  const server = (si >= 0 ? args[si + 1] : undefined) ?? "http://127.0.0.1:3000";
  const id = args.find((a, i) => !a.startsWith("--") && (si < 0 || i !== si + 1));
  if (!id) {
    console.error("usage: npm run verify -- <proposalId> [--server http://127.0.0.1:3000]");
    return 2;
  }
  const base = server.replace(/\/+$/, "");
  const bundle = (await getJson(`${base}/proposals/${encodeURIComponent(id)}/evidence`)) as EvidenceBundle;
  const policy = (await getJson(`${base}/policy`)) as PublishedPolicy;

  let messages: unknown[];
  let opts: VerifyOptions;
  if (bundle.mode === "real" && bundle.audit?.topicId) {
    const network = (policy.policy as { network?: string } | null)?.network === "mainnet" ? "mainnet" : "testnet";
    const t = await fetchTopicMessages(network, bundle.audit.topicId, { maxPages: 50 });
    messages = parseMessages(t.messages);
    opts = { auditSource: "mirror", truncated: t.truncated };
  } else {
    messages = ((await getJson(`${base}/audit`)) as { entries: unknown[] }).entries;
    opts = { auditSource: "server" };
  }

  const results = verifyBundle(bundle, policy, messages, opts);
  console.log(`verify ${id} against ${base} (decision ${bundle.decision}, mode ${bundle.mode})`);
  for (const line of formatResults(results, Boolean(process.stdout.isTTY))) console.log(line);
  const s = summarize(results);
  console.log(s.line);
  return s.fail > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
