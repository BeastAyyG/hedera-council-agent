// Fresh code, written 2026-11-07 for ETHGlobal Mumbai.
// The demo kill-switch. REAL_ONLY=1 hides every demo surface and makes the
// server fail closed with a setup-required message when real credentials
// are missing. Default OFF: with REAL_ONLY unset, the app behaves exactly
// as before (simulated mode with labelled demo data).
//
// The switch is one flag on purpose: the owner keeps the demo until the
// real integration is verified, then flips this on to prove the product
// stands on its own. Final removal (docs/DEMO-REMOVAL.md) deletes the
// demo code paths instead of gating them.

export interface SetupItem {
  key: string;
  // Where the owner gets it. Public ids may come over chat; secrets only
  // through the Secure Vault (custom.0g, custom.hedera, custom.world).
  where: string;
}

// Required before anything real can run. The Hedera account id and the
// World RP/app ids are public; the keys are secrets and never go in chat.
export const SETUP_ITEMS: SetupItem[] = [
  {
    key: "HEDERA_ACCOUNT_ID",
    where: "Hedera Portal (portal.hedera.com): create a Testnet account. It comes with 1,000 test HBAR.",
  },
  {
    key: "HEDERA_PRIVATE_KEY",
    where: "Hedera Portal (portal.hedera.com): the ECDSA private key of the Testnet account. Secret: enter it through the Secure Vault (custom.hedera), never in chat.",
  },
  {
    key: "ZERO_G_API_KEY",
    where: "0G Private Computer console (pc.0g.ai): create an API key. ETHGlobal teams ask at the 0G booth for credits. Secret: enter it through the Secure Vault (custom.0g), never in chat.",
  },
  {
    key: "WORLD_RP_ID",
    where: "World Developer Portal (developer.world.org): create an app and copy the RP id.",
  },
  {
    key: "WORLD_APP_ID",
    where: "World Developer Portal (developer.world.org): the app id of the same app.",
  },
  {
    key: "WORLD_SIGNING_KEY",
    where: "World Developer Portal (developer.world.org): the RP signing key. Server-side only, it never reaches the browser. Secret: enter it through the Secure Vault (custom.world), never in chat.",
  },
];

export function isRealOnly(env: NodeJS.ProcessEnv): boolean {
  return (env.REAL_ONLY ?? "").trim() === "1";
}

export function missingSetup(env: NodeJS.ProcessEnv): SetupItem[] {
  return SETUP_ITEMS.filter((item) => !(env[item.key] ?? "").trim());
}

export function missingKeys(env: NodeJS.ProcessEnv, keys: string[]): SetupItem[] {
  return missingSetup(env).filter((item) => keys.includes(item.key));
}

export const HEDERA_KEYS = ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY"];
export const ZERO_G_KEYS = ["ZERO_G_API_KEY"];
export const WORLD_KEYS = ["WORLD_RP_ID", "WORLD_APP_ID", "WORLD_SIGNING_KEY"];

// The fail-closed body every guarded route returns under REAL_ONLY=1
// when the credentials it needs are missing. No fake data, no crash.
export function setupRequiredBody(env: NodeJS.ProcessEnv, keys: string[]): { setupRequired: true; realOnly: true; missing: SetupItem[] } {
  return { setupRequired: true, realOnly: true, missing: missingKeys(env, keys) };
}

// One-line reason the mocked paths print when the switch is on.
export function mockedDisabledReason(what: string): string {
  return `Real-only mode (REAL_ONLY=1): mocked ${what} are disabled. Set up World ID (WORLD_RP_ID, WORLD_APP_ID, WORLD_SIGNING_KEY) or unset REAL_ONLY to restore the demo.`;
}
