// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Reads a scheduled transaction back from the Hedera mirror node and
// decodes the transfer it will actually execute. The agent checks THIS,
// not a JSON object supplied with the request, against the proposal's
// description before it signs.

import { proto } from "@hiero-ledger/proto";
import type { Transfer } from "./proposal.js";

export const MIRROR_URLS = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
} as const;

export interface OnChainSchedule {
  scheduleId: string;
  memo: string;
  creator: string;
  payer: string;
  executed: boolean;
  deleted: boolean;
  signedBy: number;
  // Every HBAR movement in the scheduled body, account -> tinybars (signed).
  hbarTransfers: Array<{ account: string; tinybars: number }>;
  // null when the scheduled transaction is not a plain HBAR transfer.
  transfer: (Transfer & { from: string }) | null;
  problem: string | null;
}

interface MirrorSchedule {
  schedule_id: string;
  memo?: string;
  creator_account_id: string;
  payer_account_id: string;
  executed_timestamp: string | null;
  deleted: boolean;
  signatures?: unknown[];
  transaction_body: string;
}

function acct(a: proto.IAccountID | null | undefined): string {
  return `${a?.shardNum ?? 0}.${a?.realmNum ?? 0}.${a?.accountNum ?? 0}`;
}

// Pure decoder, separate from the network call so it can be tested.
export function decodeScheduledTransfer(bodyBase64: string): {
  hbarTransfers: Array<{ account: string; tinybars: number }>;
  transfer: (Transfer & { from: string }) | null;
  problem: string | null;
} {
  const body = proto.SchedulableTransactionBody.decode(Buffer.from(bodyBase64, "base64"));
  const ct = body.cryptoTransfer;
  if (!ct) return { hbarTransfers: [], transfer: null, problem: "The scheduled transaction is not a crypto transfer." };
  const hbarTransfers = (ct.transfers?.accountAmounts ?? []).map((aa) => ({
    account: acct(aa.accountID),
    tinybars: Number(aa.amount ?? 0),
  }));
  const hasTokens = (ct.tokenTransfers?.length ?? 0) > 0;
  const out = hbarTransfers.filter((t) => t.tinybars < 0);
  const inn = hbarTransfers.filter((t) => t.tinybars > 0);
  if (hasTokens) return { hbarTransfers, transfer: null, problem: "The scheduled transfer also moves tokens, which the description does not cover." };
  if (out.length !== 1 || inn.length !== 1 || hbarTransfers.length !== 2) {
    return { hbarTransfers, transfer: null, problem: "The scheduled transfer must be exactly one sender and one receiver." };
  }
  if (out[0]!.tinybars + inn[0]!.tinybars !== 0) {
    return { hbarTransfers, transfer: null, problem: "The scheduled transfer does not balance." };
  }
  return {
    hbarTransfers,
    transfer: { from: out[0]!.account, payee: inn[0]!.account, amountTinybars: inn[0]!.tinybars, token: "HBAR" },
    problem: null,
  };
}

export async function fetchSchedule(
  network: string,
  scheduleId: string,
  opts: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OnChainSchedule> {
  const base = network === "mainnet" ? MIRROR_URLS.mainnet : MIRROR_URLS.testnet;
  const f = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 8;
  let last = "";
  // A schedule created seconds ago takes a few seconds to reach the mirror node.
  for (let i = 0; i < attempts; i++) {
    const res = await f(`${base}/api/v1/schedules/${encodeURIComponent(scheduleId)}`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const s = (await res.json()) as MirrorSchedule;
      const d = decodeScheduledTransfer(s.transaction_body);
      return {
        scheduleId: s.schedule_id,
        memo: s.memo ?? "",
        creator: s.creator_account_id,
        payer: s.payer_account_id,
        executed: s.executed_timestamp !== null,
        deleted: s.deleted,
        signedBy: s.signatures?.length ?? 0,
        ...d,
      };
    }
    last = `HTTP ${res.status}`;
    if (res.status !== 404) break;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs ?? 1500));
  }
  throw new Error(`Mirror node has no schedule ${scheduleId} (${last}).`);
}

export interface TopicMessage {
  sequence: number;
  consensusTimestamp: string;
  text: string;
}

// Read an HCS topic's messages from the mirror node, following pagination.
// An unknown or brand-new topic (404) reads as empty.
export async function fetchTopicMessages(
  network: string,
  topicId: string,
  opts: { order?: "asc" | "desc"; limit?: number; maxPages?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ messages: TopicMessage[]; truncated: boolean }> {
  const base = network === "mainnet" ? MIRROR_URLS.mainnet : MIRROR_URLS.testnet;
  const f = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 10;
  let path: string | null = `/api/v1/topics/${encodeURIComponent(topicId)}/messages?order=${opts.order ?? "asc"}&limit=${opts.limit ?? 100}`;
  const messages: TopicMessage[] = [];
  let pages = 0;
  while (path && pages < maxPages) {
    const res = await f(base + path, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return { messages, truncated: false };
    if (!res.ok) throw new Error(`Mirror node returned HTTP ${res.status} for topic ${topicId}.`);
    const body = (await res.json()) as {
      messages?: Array<{ sequence_number: number; consensus_timestamp: string; message: string }>;
      links?: { next?: string | null };
    };
    for (const m of body.messages ?? []) {
      messages.push({
        sequence: m.sequence_number,
        consensusTimestamp: m.consensus_timestamp,
        text: Buffer.from(m.message, "base64").toString("utf8"),
      });
    }
    path = body.links?.next ?? null;
    pages += 1;
  }
  return { messages, truncated: path !== null };
}

// Parse topic messages as JSON; anything that is not JSON becomes null.
export function parseMessages(messages: TopicMessage[]): unknown[] {
  return messages.map((m) => {
    try {
      return JSON.parse(m.text) as unknown;
    } catch {
      return null;
    }
  });
}
