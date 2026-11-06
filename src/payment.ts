// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// How the agent pays for a proposal check.
// Real mode: x402 on Hedera. The agent calls the paid check service
// (CHECK_SERVICE_URL, default this server's own POST /check), pays $0.01
// testnet USDC per check with no human approving, and gets the check
// result back. The settlement tx id is the payment id.
// Simulated mode: a SIM-PAY id, clearly labelled, no chain involved.

import type { CheckResult } from "./checker.js";
import type { HederaClient } from "./hedera.js";
import { sameAccount } from "./payee.js";
import type { Proposal } from "./proposal.js";
import { PayeeSwapError, x402Check } from "./x402Client.js";

export type PaidCheck =
  | { ok: true; paymentId: string; via: "x402" | "simulated"; remoteCheck: CheckResult | null }
  // kind "payee-swap": the 402 offer asked to pay someone other than the
  // registered check service, so nothing was paid.
  | { ok: false; paymentId: string | null; via: "x402" | "simulated"; error: string; kind?: "payee-swap" };

export interface CheckPayer {
  readonly via: "x402" | "simulated";
  readonly priceAtomic: number;
  // The registered check service wallet: the only payTo the agent will pay.
  readonly expectedPayTo: string;
  payForCheck(proposal: Proposal): Promise<PaidCheck>;
}

export function swapRefusal(offered: string, registered: string): string {
  return `The 402 offer asks to pay ${offered}, not the registered check service ${registered}`;
}

export class SimulatedCheckPayer implements CheckPayer {
  readonly via = "simulated" as const;
  readonly expectedPayTo: string;
  // What the simulated 402 offer asks for. Differs from expectedPayTo to
  // simulate a seller (or a man in the middle) swapping the recipient.
  private readonly offeredPayTo: string;

  constructor(
    private readonly hedera: HederaClient,
    readonly priceAtomic: number,
    opts: { expectedPayTo?: string; offeredPayTo?: string } = {},
  ) {
    this.expectedPayTo = opts.expectedPayTo ?? "0.0.0";
    this.offeredPayTo = opts.offeredPayTo ?? this.expectedPayTo;
  }

  async payForCheck(): Promise<PaidCheck> {
    if (!sameAccount(this.offeredPayTo, this.expectedPayTo)) {
      return { ok: false, paymentId: null, via: this.via, kind: "payee-swap", error: swapRefusal(this.offeredPayTo, this.expectedPayTo) };
    }
    return { ok: true, paymentId: this.hedera.simId("PAY"), via: this.via, remoteCheck: null };
  }
}

function asCheckResult(body: unknown): CheckResult | null {
  const b = body as Partial<CheckResult> | null;
  if (!b || typeof b.matches !== "boolean" || typeof b.proposalId !== "string" || !Array.isArray(b.mismatches)) {
    return null;
  }
  return { proposalId: b.proposalId, matches: b.matches, mismatches: b.mismatches, verdict: String(b.verdict ?? "") };
}

export class X402CheckPayer implements CheckPayer {
  readonly via = "x402" as const;
  constructor(
    private readonly opts: {
      url: string;
      accountId: string;
      privateKey: string;
      network: "hedera:testnet" | "hedera:mainnet";
      expectedPayTo: string;
    },
    readonly priceAtomic: number,
  ) {}

  get expectedPayTo(): string {
    return this.opts.expectedPayTo;
  }

  async payForCheck(proposal: Proposal): Promise<PaidCheck> {
    try {
      const r = await x402Check(this.opts.url, proposal, { ...this.opts, maxAmountAtomic: this.priceAtomic });
      const paymentId = r.settlement?.transaction || null;
      if (r.status !== 200) {
        return { ok: false, paymentId, via: this.via, error: `Check service returned HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` };
      }
      if (!r.settlement?.success || !paymentId) {
        return { ok: false, paymentId, via: this.via, error: `x402 payment did not settle: ${r.settlement?.errorReason ?? "no PAYMENT-RESPONSE"}` };
      }
      const remoteCheck = asCheckResult(r.body);
      if (!remoteCheck) return { ok: false, paymentId, via: this.via, error: "Check service returned no check result" };
      return { ok: true, paymentId, via: this.via, remoteCheck };
    } catch (err) {
      if (err instanceof PayeeSwapError) {
        return { ok: false, paymentId: null, via: this.via, kind: "payee-swap", error: swapRefusal(err.offered, err.expected) };
      }
      return { ok: false, paymentId: null, via: this.via, error: `x402 payment failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
