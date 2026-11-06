// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// A proposal is a transfer: a human description plus the exact on-chain
// transfer it will execute. The two must match exactly, or the agent refuses.

export type Token = "HBAR";

export interface Transfer {
  payee: string; // Hedera account id, e.g. 0.0.12345
  amountTinybars: number; // integer tinybars, 1 HBAR = 100_000_000 tinybars
  token: Token;
}

export interface ProposalDescription {
  payee: string;
  amountTinybars: number;
  token: Token;
  purpose: string;
}

export interface Proposal {
  id: string;
  description: ProposalDescription;
  transfer: Transfer;
  // Hedera Scheduled Transaction id (0.0.x) holding the exact transfer.
  // Real mode: set by the proposer, or filled in when the agent's
  // council proposer creates it. The agent then checks the transfer on Hedera.
  scheduleId?: string;
  // True when `transfer` is only a placeholder to be replaced by the
  // transfer read back from Hedera (the request named a scheduleId and gave no transfer).
  transferFromChain?: boolean;
  createdAt: string;
}

export function isLargeProposal(p: Proposal, thresholdTinybars: number): boolean {
  return p.transfer.amountTinybars >= thresholdTinybars;
}

export function hbarToTinybars(hbar: number): number {
  return Math.round(hbar * 100_000_000);
}

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// Shape validation for untrusted input. A description and transfer that
// are well-formed but differ are valid here: catching that is the checker's job.
export function validateProposal(input: unknown): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  const p = input as Partial<Proposal> | null;
  if (!p || typeof p !== "object") return { ok: false, error: "proposal must be an object" };
  if (typeof p.id !== "string" || !PROPOSAL_ID.test(p.id)) {
    return { ok: false, error: "proposal.id must be 1-64 chars of letters, digits, _ or -" };
  }
  const d = p.description as Partial<ProposalDescription> | undefined;
  const t = p.transfer as Partial<Transfer> | undefined;
  if (!d || typeof d !== "object") return { ok: false, error: "proposal.description is required" };
  const scheduleId = p.scheduleId;
  if (scheduleId !== undefined && (typeof scheduleId !== "string" || !ACCOUNT_ID.test(scheduleId))) {
    return { ok: false, error: "proposal.scheduleId must look like 0.0.12345" };
  }
  const fromChain = scheduleId !== undefined && (t === undefined || t === null);
  if (!fromChain && (!t || typeof t !== "object")) return { ok: false, error: "proposal.transfer is required (or give a scheduleId)" };
  if (typeof d.payee !== "string" || !ACCOUNT_ID.test(d.payee.trim())) {
    return { ok: false, error: "description.payee must be a Hedera account id (0.0.x)" };
  }
  if (!fromChain && (typeof t!.payee !== "string" || !ACCOUNT_ID.test(t!.payee.trim()))) {
    return { ok: false, error: "transfer.payee must be a Hedera account id (0.0.x)" };
  }
  if (!isAmount(d.amountTinybars) || (!fromChain && !isAmount(t!.amountTinybars))) {
    return { ok: false, error: "amountTinybars must be a positive integer on both description and transfer" };
  }
  if (d.token !== "HBAR" || (!fromChain && t!.token !== "HBAR")) return { ok: false, error: 'token must be "HBAR"' };
  if (typeof d.purpose !== "string" || d.purpose.length === 0 || d.purpose.length > 200) {
    return { ok: false, error: "description.purpose must be 1-200 chars" };
  }
  return {
    ok: true,
    proposal: {
      id: p.id,
      description: { payee: d.payee.trim(), amountTinybars: d.amountTinybars, token: "HBAR", purpose: d.purpose },
      transfer: fromChain
        ? { payee: d.payee.trim(), amountTinybars: d.amountTinybars, token: "HBAR" }
        : { payee: t!.payee!.trim(), amountTinybars: t!.amountTinybars!, token: "HBAR" },
      ...(scheduleId ? { scheduleId } : {}),
      ...(fromChain ? { transferFromChain: true } : {}),
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    },
  };
}

// Content identity of a proposal: the fields an approver is approving.
export function proposalFingerprint(p: Proposal): string {
  return JSON.stringify([p.id, p.description.payee, p.description.amountTinybars, p.description.token, p.description.purpose, p.transfer.payee, p.transfer.amountTinybars, p.transfer.token, p.scheduleId ?? null]);
}
