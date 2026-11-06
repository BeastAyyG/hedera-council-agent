// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// x402 paid proposal check, real protocol v2.
// Verified 2026-11-06: packages @x402/core, @x402/express, @x402/hedera,
// @x402/fetch (v2.30.0 installed). Facilitator: Official x402
// https://x402.org/facilitator (also on the prize page list), or Blocky402
// https://api.testnet.blocky402.com. Network: hedera:testnet.
// Default asset on Hedera testnet is testnet USDC 0.0.429274 (6 decimals),
// so the real x402 price is "$0.01" in USDC, not HBAR. The agent's
// Hedera account must be associated with that token to pay in USDC;
// testnet USDC comes from faucet.circle.com (Hedera Testnet).
// The self-run facilitator option in the prize text is also kept as a
// fallback shape in acceptsForCheck(): a plain 402 with price/payTo,
// used only in SIMULATED mode. Real mode uses the @x402/express
// paymentMiddleware in server.ts, which verifies and settles through
// the official facilitator.

export const X402_FACILITATOR_URL = "https://x402.org/facilitator";
export const X402_TESTNET_USDC = "0.0.429274";
export const X402_NETWORK_TESTNET = "hedera:testnet";
export const X402_NETWORK_MAINNET = "hedera:mainnet";

export interface X402Accepts {
  scheme: string;
  network: string;
  amount: string; // tinybars, as a string (simulated / self-run shape only)
  asset: string; // HBAR
  payTo: string; // Hedera account id receiving the check fee
  description: string;
}

export function paymentRequiredResponse(accepts: X402Accepts): { status: 402; body: unknown } {
  return {
    status: 402,
    body: {
      x402Version: 1,
      error: "Payment Required",
      accepts: [accepts],
    },
  };
}

export function acceptsForCheck(config: {
  network: string;
  payTo: string;
  priceTinybars: number;
}): X402Accepts {
  return {
    scheme: "exact",
    network: config.network === "mainnet" ? "hedera-mainnet" : "hedera-testnet",
    amount: String(config.priceTinybars),
    asset: "HBAR",
    payTo: config.payTo,
    description: "Payment for one proposal check",
  };
}
