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
  // Scheduled Transaction id, once created on Hedera (real mode only).
  scheduledTxId?: string;
  createdAt: string;
}

export function isLargeProposal(p: Proposal, thresholdTinybars: number): boolean {
  return p.transfer.amountTinybars >= thresholdTinybars;
}

export function hbarToTinybars(hbar: number): number {
  return Math.round(hbar * 100_000_000);
}
