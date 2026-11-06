// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Agent-side x402 client: pays for a proposal check through the real
// x402 protocol v2, via the official facilitator.
// Uses @x402/fetch wrapFetchWithPayment with an @x402/hedera Exact
// scheme signer. Real mode only when HEDERA_ACCOUNT_ID and
// HEDERA_PRIVATE_KEY are set. In simulated mode this throws, and the
// caller falls back to the direct simulated payment in council.ts.

import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { PrivateKey } from "@hiero-ledger/sdk";

export async function x402Check(
  url: string,
  proposal: unknown,
  config: { accountId: string; privateKey: string; network: "hedera:testnet" | "hedera:mainnet" },
): Promise<{ status: number; body: unknown }> {
  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromString(config.privateKey),
    { network: config.network },
  );
  const client = new x402Client().register(config.network, new ExactHederaScheme(signer));
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPay(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposal),
  });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}
