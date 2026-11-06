// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Spending cap: the agent pays for proposal checks out of a fixed budget.
// Over the cap, it stops paying and stops checking.
// Units are USDC atomic units (6 decimals): $0.01 = 10000, matching the
// x402 price of a check on Hedera testnet USDC.

export const USDC_DECIMALS = 6;

// "0.01" -> 10000. Rejects anything that is not a plain non-negative decimal.
export function usdcToAtomic(usd: string): number {
  const s = usd.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`Invalid USDC amount: ${usd}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 10 ** USDC_DECIMALS + Number(frac.padEnd(USDC_DECIMALS, "0"));
}

export function atomicToUsd(atomic: number): string {
  return `$${(atomic / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/0{1,4}$/, "")}`;
}

export class SpendingCap {
  private spent = 0;
  constructor(private readonly capAtomic: number) {}

  get spentAtomic(): number {
    return this.spent;
  }
  get remainingAtomic(): number {
    return Math.max(0, this.capAtomic - this.spent);
  }
  canAfford(priceAtomic: number): boolean {
    return priceAtomic > 0 && this.spent + priceAtomic <= this.capAtomic;
  }
  record(priceAtomic: number): boolean {
    if (!this.canAfford(priceAtomic)) return false;
    this.spent += priceAtomic;
    return true;
  }
}
