// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Tamper-evident decision log on HCS. Every message the agent writes is
// an entry that commits to the one before it (prev = hash of the last
// entry) and to the agent's published policy (policy = hash from
// src/policy.ts). Anyone can read the topic from a mirror node and
// re-check the chain with verifyChain(): an edited, dropped, reordered or
// forged entry breaks it. The topic is created with the agent's submit
// key, so nobody else can append to it.

import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

export interface ChainedEntry {
  v: 1;
  seq: number;
  prev: string;
  proposalId: string;
  event: string;
  detail: string;
  at: string;
  policy: string;
  // Optional anchors for a decision (0G request id and verdict hash, proposal
  // hash, payee registry result). Part of the hash when present.
  meta?: EntryMeta;
  hash: string;
}

export interface EntryMeta {
  zeroGRequestId?: string | null;
  zeroGModel?: string | null;
  verdictHash?: string;
  proposalHash?: string;
  payeeRegistry?: string;
  // Standing instruction anchors (MANDATE_ADOPTED).
  rulesHash?: string;
  textHash?: string;
}

export type EntryInput = Pick<ChainedEntry, "proposalId" | "event" | "detail" | "at" | "policy" | "meta">;

// An HCS message is at most 1024 bytes; stay under this for every entry.
export const MAX_ENTRY_BYTES = 1000;

// JSON with sorted keys, so the same data always hashes the same.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function entryHash(e: Omit<ChainedEntry, "hash">): string {
  return sha256(canonical(e));
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export const EMPTY_HEAD: ChainHead = { seq: 0, hash: GENESIS };

export function sealEntry(head: ChainHead, input: EntryInput): ChainedEntry {
  const build = (detail: string): ChainedEntry => {
    const body: Omit<ChainedEntry, "hash"> = {
      v: 1,
      seq: head.seq + 1,
      prev: head.hash,
      proposalId: input.proposalId,
      event: input.event,
      detail,
      at: input.at,
      policy: input.policy,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    return { ...body, hash: entryHash(body) };
  };
  // Anchors take room too, so the detail gives way until the message fits.
  let detail = input.detail.slice(0, 400);
  let entry = build(detail);
  while (detail.length > 0 && Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) {
    detail = detail.slice(0, Math.max(0, detail.length - 16));
    entry = build(detail);
  }
  return entry;
}

export function isChainedEntry(x: unknown): x is ChainedEntry {
  const e = x as Partial<ChainedEntry> | null;
  return (
    !!e &&
    typeof e === "object" &&
    e.v === 1 &&
    Number.isSafeInteger(e.seq) &&
    typeof e.prev === "string" &&
    typeof e.hash === "string" &&
    typeof e.proposalId === "string" &&
    typeof e.event === "string" &&
    typeof e.detail === "string" &&
    typeof e.at === "string" &&
    typeof e.policy === "string"
  );
}

export interface ChainReport {
  ok: boolean;
  checked: number;
  // Messages on the topic that are not chain entries (ignored).
  ignored: number;
  head: ChainHead | null;
  brokenAt: number | null;
  reason: string | null;
}

// Verify a topic's messages in consensus order.
export function verifyChain(messages: unknown[]): ChainReport {
  let head: ChainHead = EMPTY_HEAD;
  let checked = 0;
  let ignored = 0;
  for (const m of messages) {
    if (!isChainedEntry(m)) {
      ignored += 1;
      continue;
    }
    const { hash, ...body } = m;
    const fail = (reason: string): ChainReport => ({ ok: false, checked, ignored, head: checked ? head : null, brokenAt: m.seq, reason });
    if (entryHash(body) !== hash) return fail(`Entry ${m.seq} does not match its own hash, so it was altered.`);
    if (m.seq !== head.seq + 1) return fail(`Entry ${m.seq} follows entry ${head.seq}: an entry is missing or out of order.`);
    if (m.prev !== head.hash) return fail(`Entry ${m.seq} does not link to the entry before it.`);
    head = { seq: m.seq, hash };
    checked += 1;
  }
  return { ok: true, checked, ignored, head: checked ? head : null, brokenAt: null, reason: null };
}
