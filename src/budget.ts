// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Spending cap: the agent pays for proposal checks out of a fixed budget.
// Over the cap, it stops paying and stops checking.

export class SpendingCap {
  private spent = 0;
  constructor(private readonly capTinybars: number) {}

  get spentTinybars(): number {
    return this.spent;
  }
  get remainingTinybars(): number {
    return Math.max(0, this.capTinybars - this.spent);
  }
  canAfford(priceTinybars: number): boolean {
    return priceTinybars > 0 && this.spent + priceTinybars <= this.capTinybars;
  }
  record(priceTinybars: number): boolean {
    if (!this.canAfford(priceTinybars)) return false;
    this.spent += priceTinybars;
    return true;
  }
}
