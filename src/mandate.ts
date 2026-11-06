// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Standing instructions ("mandates") and council votes. The owner writes the
// instruction once in plain words; 0G (or, with no key, a deterministic
// SIMULATED parser) turns it into MandateRules; the council adopts the rules
// by majority vote. From then on the deterministic code below decides whether
// a payment is inside the rules. The model never decides a payment.
// Contract: docs/mandate-spec.md.

import { canonical, sha256 } from "./auditlog.js";
import { sameAccount } from "./payee.js";
import type { Proposal } from "./proposal.js";
import { zeroGChat, type ZeroGConfig } from "./zeroG.js";

export interface MandateRules {
  maxPerPaymentTinybars: number;
  // null: no monthly cap. Month = UTC calendar month.
  monthlyCapTinybars: number | null;
  // "registered": payee registry status "registered". string[]: Hedera ids 0.0.x.
  payees: "registered" | "any" | string[];
  // Lowercase keywords; [] = any purpose. Match: purpose (lowercased) contains a keyword.
  purposes: string[];
  outsideMandate: "vote" | "refuse";
}

export interface Ballot {
  seat: string;
  choice: "yes" | "no";
  at: string;
  source: "world" | "mocked";
}

export interface VoteTally {
  // Seats that existed when the vote opened; later joiners cannot vote on it.
  eligible: string[];
  needed: number;
  yes: number;
  no: number;
  ballots: Ballot[];
  status: "open" | "passed" | "failed";
}

export interface MandateDraft {
  id: string;
  text: string;
  rules: MandateRules;
  summary: string[];
  source: "0g" | "simulated";
  requestId: string | null;
  model: string;
  rulesHash: string;
  textHash: string;
  createdAt: string;
  status: "open" | "adopted" | "rejected" | "superseded";
  vote: VoteTally;
  adoptedAt?: string;
  adoptedAudit?: { auditSeq: number | null; auditHash: string | null; auditTxId: string | null };
  // Why the draft closed without adoption (failed vote, seat revocation).
  closedReason?: string;
}

// One open or closed council vote, as listed by GET /council/votes.
export interface VoteItem {
  subject: string;
  kind: "proposal" | "mandate";
  title: string;
  amountTinybars?: number;
  payee?: string;
  violations?: string[];
  // Mandates: the plain-language rules being voted on.
  summary?: string[];
  vote: VoteTally;
  decision?: string;
  openedAt: string;
}

export interface SpendRecord {
  proposalId: string;
  amountTinybars: number;
  at: string;
}

export const MAX_MANDATE_TEXT = 1000;
export const TINYBARS_PER_HBAR = 100_000_000;
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const RULE_KEYS = ["maxPerPaymentTinybars", "monthlyCapTinybars", "payees", "purposes", "outsideMandate"];

export function hbar(tinybars: number): string {
  return `${tinybars / TINYBARS_PER_HBAR} HBAR`;
}

export function rulesHash(rules: MandateRules): string {
  return sha256(canonical(rules));
}

export type RulesResult = { ok: true; rules: MandateRules } | { ok: false; error: string };

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

// Strict: exactly the five keys, nothing else, every value in range.
// Returns a normalized copy (purposes trimmed and lowercased, payees deduplicated).
export function validateRules(input: unknown): RulesResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "rules must be a JSON object" };
  const r = input as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !RULE_KEYS.includes(k));
  if (extra.length) return { ok: false, error: `unknown field(s): ${extra.join(", ").slice(0, 120)}` };
  const missing = RULE_KEYS.filter((k) => !(k in r));
  if (missing.length) return { ok: false, error: `missing field(s): ${missing.join(", ")}` };
  if (!isPositiveInt(r.maxPerPaymentTinybars)) return { ok: false, error: "maxPerPaymentTinybars must be a positive integer" };
  if (r.monthlyCapTinybars !== null && !isPositiveInt(r.monthlyCapTinybars)) {
    return { ok: false, error: "monthlyCapTinybars must be a positive integer or null" };
  }
  let payees: MandateRules["payees"];
  if (r.payees === "registered" || r.payees === "any") payees = r.payees;
  else if (Array.isArray(r.payees)) {
    if (r.payees.length === 0 || r.payees.length > 50) return { ok: false, error: "payees list must have 1-50 Hedera account ids" };
    if (!r.payees.every((p) => typeof p === "string" && ACCOUNT_ID.test(p))) return { ok: false, error: "payees list must contain only Hedera account ids (0.0.x)" };
    payees = [...new Set(r.payees as string[])];
  } else return { ok: false, error: 'payees must be "registered", "any" or a list of Hedera account ids' };
  if (!Array.isArray(r.purposes) || r.purposes.length > 20) return { ok: false, error: "purposes must be a list of at most 20 keywords" };
  const purposes: string[] = [];
  for (const p of r.purposes) {
    if (typeof p !== "string") return { ok: false, error: "purposes must be strings" };
    const k = p.trim().toLowerCase();
    if (k.length === 0 || k.length > 40) return { ok: false, error: "each purpose keyword must be 1-40 characters" };
    if (!purposes.includes(k)) purposes.push(k);
  }
  if (r.outsideMandate !== "vote" && r.outsideMandate !== "refuse") return { ok: false, error: 'outsideMandate must be "vote" or "refuse"' };
  return {
    ok: true,
    rules: {
      maxPerPaymentTinybars: r.maxPerPaymentTinybars,
      monthlyCapTinybars: r.monthlyCapTinybars as number | null,
      payees,
      purposes,
      outsideMandate: r.outsideMandate,
    },
  };
}

export const NO_AMOUNT = "say how much one payment may be";

const AMOUNT = /(\d+(?:\.\d+)?)\s*hbars?\b/gi;
const MONTH_AFTER = /^\s*(?:a|per|each|every|in a|\/)\s*(?:calendar\s+)?month\b|^\s*monthly\b/i;
const MONTH_BEFORE = /\b(?:monthly|per month|a month|each month|every month)\b[^.\d]{0,30}$/i;
const PER_BEFORE = /\b(?:up to|max(?:imum)?|at most|no more than|not more than|limit of|under|below)\s*$/i;
const PER_AFTER = /^\s*(?:each|apiece|per (?:payment|transfer|transaction|invoice|vendor|payee)|a (?:payment|transfer)|for (?:each|one|a single) (?:payment|transfer))\b/i;
const STOP = new Set(["each", "every", "any", "all", "anything", "everything", "payment", "payments", "month", "council", "vote", "else", "them", "it", "this", "that"]);

const toTinybars = (n: string) => Math.round(Number(n) * TINYBARS_PER_HBAR);

// Deterministic SIMULATED parser, used when no ZERO_G_API_KEY is set.
export function parseMandateText(text: string): RulesResult {
  const t = text.replace(/\s+/g, " ").trim();
  let perPayment: number | null = null;
  let monthly: number | null = null;
  let bare: number | null = null;
  for (const m of t.matchAll(AMOUNT)) {
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    const value = toTinybars(m[1]!);
    if (MONTH_AFTER.test(after) || MONTH_BEFORE.test(before)) monthly ??= value;
    else if (PER_BEFORE.test(before) || PER_AFTER.test(after)) perPayment ??= value;
    else bare ??= value;
  }
  perPayment ??= bare;
  if (!perPayment || perPayment <= 0) return { ok: false, error: NO_AMOUNT };

  const ids = [...new Set(t.match(/\b\d+\.\d+\.\d+\b/g) ?? [])];
  let payees: MandateRules["payees"] = "registered";
  if (ids.length) payees = ids;
  else if (/\b(?:any|every) (?:payee|recipient|vendor|account|one)s?\b|\banyone\b|\banybody\b/i.test(t)) payees = "any";

  const purposes: string[] = [];
  const clause = /\b(?:for|purposes?:?|only for)\s+([a-z][a-z ,&/'-]*?)(?=[.;:!?]|$)/gi;
  for (const m of t.matchAll(clause)) {
    for (const raw of m[1]!.split(/,|&|\/|\band\b|\bor\b/i)) {
      const k = raw.trim().toLowerCase().replace(/^(?:the|a|an|our|their)\s+/, "");
      if (!k || k.length > 40 || k.split(" ").length > 3 || STOP.has(k) || STOP.has(k.split(" ")[0]!)) continue;
      if (!purposes.includes(k)) purposes.push(k);
    }
  }
  const outsideMandate = /\b(?:refuse|reject|decline|deny|block)\b/i.test(t) ? "refuse" : "vote";
  return validateRules({ maxPerPaymentTinybars: perPayment, monthlyCapTinybars: monthly, payees, purposes, outsideMandate });
}

export type CompileResult =
  | { ok: true; rules: MandateRules; source: "0g" | "simulated"; requestId: string | null; model: string }
  | { ok: false; error: string; requestId: string | null };

const COMPILE_PROMPT = `You convert a treasury owner's standing instruction into machine-checkable rules.
Reply with ONE JSON object and nothing else (no prose, no code fences), exactly these keys:
{"maxPerPaymentTinybars": integer > 0, "monthlyCapTinybars": integer > 0 or null, "payees": "registered" | "any" | ["0.0.x", ...], "purposes": [lowercase keywords] (empty list = any purpose), "outsideMandate": "vote" | "refuse"}
1 HBAR = 100000000 tinybars. "registered" means only payees in the council payee registry. "outsideMandate" is "refuse" only if the owner says to refuse or reject anything else; otherwise "vote" (the council decides).
Never invent limits the owner did not state; if no per-payment amount is stated, reply {"error": "no per-payment amount"}.
Instruction:
`;

// One 0G call at temperature 0 when a key is set; the deterministic parser
// otherwise. Invalid model output fails closed: no rules, no draft.
export async function compileMandate(text: string, zeroG: ZeroGConfig, fetchImpl: typeof fetch = fetch): Promise<CompileResult> {
  if (!zeroG.apiKey) {
    const parsed = parseMandateText(text);
    return parsed.ok
      ? { ok: true, rules: parsed.rules, source: "simulated", requestId: null, model: "SIMULATED deterministic parser (no ZERO_G_API_KEY)" }
      : { ok: false, error: parsed.error, requestId: null };
  }
  let reply: { text: string; requestId: string | null };
  try {
    reply = await zeroGChat(zeroG, COMPILE_PROMPT + text, fetchImpl);
  } catch (err) {
    return { ok: false, error: `0G could not compile the instruction: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), requestId: null };
  }
  // A single surrounding code fence is tolerated; validation below stays strict.
  const body = reply.text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "0G did not return valid JSON rules, failing closed", requestId: reply.requestId };
  }
  if (json && typeof json === "object" && "error" in json && Object.keys(json).length === 1) {
    return { ok: false, error: NO_AMOUNT, requestId: reply.requestId };
  }
  const v = validateRules(json);
  if (!v.ok) return { ok: false, error: `0G returned invalid rules (${v.error}), failing closed`, requestId: reply.requestId };
  return { ok: true, rules: v.rules, source: "0g", requestId: reply.requestId, model: zeroG.model };
}

// Plain-language lines, generated by code from the rules (never by the model).
export function summarize(rules: MandateRules): string[] {
  const payees =
    rules.payees === "registered" ? "registered payees only" : rules.payees === "any" ? "any payee" : `only ${rules.payees.join(", ")}`;
  return [
    `One payment: at most ${hbar(rules.maxPerPaymentTinybars)}`,
    rules.monthlyCapTinybars === null ? "Per month: no cap" : `Per month: at most ${hbar(rules.monthlyCapTinybars)}`,
    `Recipients: ${payees}`,
    `Purposes: ${rules.purposes.length ? rules.purposes.join(", ") : "any"}`,
    `Anything else: ${rules.outsideMandate === "vote" ? "council vote" : "refused"}`,
  ];
}

export interface MandateEvaluation {
  within: boolean;
  violations: string[];
}

export function evaluateMandate(
  rules: MandateRules,
  proposal: Proposal,
  ctx: { spentThisMonthTinybars: number; payeeStatus: string },
): MandateEvaluation {
  const violations: string[] = [];
  const amount = proposal.transfer.amountTinybars;
  const payee = proposal.transfer.payee;
  if (amount > rules.maxPerPaymentTinybars) violations.push(`${hbar(amount)} is over the ${hbar(rules.maxPerPaymentTinybars)} per-payment limit`);
  if (rules.monthlyCapTinybars !== null && ctx.spentThisMonthTinybars + amount > rules.monthlyCapTinybars) {
    violations.push(`would bring this month to ${(ctx.spentThisMonthTinybars + amount) / TINYBARS_PER_HBAR} of ${hbar(rules.monthlyCapTinybars)}`);
  }
  if (rules.payees === "registered" && ctx.payeeStatus !== "registered") violations.push(`${payee} is not a registered payee`);
  if (Array.isArray(rules.payees) && !rules.payees.some((p) => sameAccount(p, payee))) {
    violations.push(`${payee} is not one of the allowed payees: ${rules.payees.join(", ")}`);
  }
  const purpose = proposal.description.purpose.toLowerCase();
  if (rules.purposes.length && !rules.purposes.some((k) => purpose.includes(k))) {
    violations.push(`purpose '${proposal.description.purpose.slice(0, 60)}' is not one of: ${rules.purposes.join(", ")}`);
  }
  return { within: violations.length === 0, violations };
}

// IDKit signal for one ballot: bound to the subject, its exact bytes (proposal
// fingerprint or mandate rulesHash) and the choice.
export function voteSignal(subject: string, fingerprint: string, choice: "yes" | "no"): string {
  return `council-vote:${subject}:${sha256(fingerprint).slice(0, 16)}:${choice}`;
}

export function neededFor(eligibleCount: number): number {
  return Math.floor(eligibleCount / 2) + 1;
}

export function openTally(eligible: string[]): VoteTally {
  const t: VoteTally = { eligible: [...eligible], needed: neededFor(eligible.length), yes: 0, no: 0, ballots: [], status: "open" };
  return { ...t, status: tallyStatus(t) };
}

export function tallyStatus(t: Pick<VoteTally, "eligible" | "needed" | "yes" | "no">): VoteTally["status"] {
  if (t.yes >= t.needed) return "passed";
  if (t.no > t.eligible.length - t.needed) return "failed";
  return "open";
}

export type CastResult = { ok: true; tally: VoteTally } | { ok: false; status: 403 | 409; error: string };

// Pure: returns the new tally, or why the ballot is refused.
export function castBallot(tally: VoteTally, ballot: Ballot, subject: string): CastResult {
  if (tally.status !== "open") return { ok: false, status: 409, error: `The vote on ${subject} is closed (${tally.status}).` };
  if (!tally.eligible.includes(ballot.seat)) {
    return { ok: false, status: 403, error: `${ballot.seat} was not on the council when the vote on ${subject} opened, so it cannot vote on it.` };
  }
  if (tally.ballots.some((b) => b.seat === ballot.seat)) return { ok: false, status: 409, error: `${ballot.seat} has already voted on ${subject}.` };
  const ballots = [...tally.ballots, ballot];
  const yes = ballots.filter((b) => b.choice === "yes").length;
  const next = { ...tally, ballots, yes, no: ballots.length - yes };
  return { ok: true, tally: { ...next, status: tallyStatus(next) } };
}

export function ballotDetail(seat: string, choice: "yes" | "no", subject: string, t: VoteTally): string {
  const progress = choice === "yes" ? `${t.yes} of ${t.needed} needed` : `${t.no} no, ${t.eligible.length - t.needed + 1} to reject`;
  return `${seat} voted ${choice} on ${subject} (${progress})`;
}

export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}
