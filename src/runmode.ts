// Fresh code, written 2026-11-07 for ETHGlobal Mumbai.
// Run mode: which world the server lives in.
//   real  - Hedera credentials are set (and DEMO_MODE is not "1").
//           The real paths are primary: x402 through the facilitator,
//           Hedera Scheduled Transactions plus HCS, 0G verdicts, World ID.
//   demo  - DEMO_MODE=1, explicit only. The simulated paths run, every
//           chain id is a SIM- id, and the UI shows the SIMULATED banner.
//           This is the fallback until real is verified, never the default.
//   setup - neither: no Hedera credentials and no DEMO_MODE. The server
//           still starts, but every state-changing route fails closed with
//           a 503 that names the missing credentials and where to get them.
//           Nothing is faked and nothing crashes.
// The six credentials below are the whole real integration. Three are
// secrets (never print their values, never commit them): HEDERA_PRIVATE_KEY,
// ZERO_G_API_KEY, WORLD_SIGNING_KEY. The other three are public ids.

export type RunMode = "real" | "demo" | "setup";

export interface MissingCredential {
  name: string;
  where: string;
  secret: boolean;
}

export const CREDENTIALS: MissingCredential[] = [
  { name: "HEDERA_ACCOUNT_ID", where: "portal.hedera.com, Testnet, ECDSA account (1000 test HBAR)", secret: false },
  { name: "HEDERA_PRIVATE_KEY", where: "portal.hedera.com, the same testnet account, ECDSA DER or raw hex key", secret: true },
  { name: "ZERO_G_API_KEY", where: "pc.0g.ai, wallet login, Dashboard, API Keys (sk- key)", secret: true },
  { name: "WORLD_RP_ID", where: "developer.world.org, your app, RP ID", secret: false },
  { name: "WORLD_APP_ID", where: "developer.world.org, your app, App ID (app_...)", secret: false },
  { name: "WORLD_SIGNING_KEY", where: "developer.world.org, your app, RP signing key (0x hex, server only)", secret: true },
];

export function demoMode(env: NodeJS.ProcessEnv): boolean {
  return (env.DEMO_MODE ?? "").trim() === "1";
}

export function hasHederaCredentials(env: NodeJS.ProcessEnv): boolean {
  return Boolean((env.HEDERA_ACCOUNT_ID ?? "").trim() && (env.HEDERA_PRIVATE_KEY ?? "").trim());
}

// Real only when the credentials are there and the demo was not asked for.
// DEMO_MODE=1 forces the demo even with credentials set, so the fallback
// can be exercised against a real-configured box without touching .env.
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  if (demoMode(env)) return "demo";
  if (hasHederaCredentials(env)) return "real";
  return "setup";
}

// The credentials still missing, with where to get each one. Empty in real mode.
export function missingSetup(env: NodeJS.ProcessEnv): MissingCredential[] {
  return CREDENTIALS.filter((c) => !(env[c.name] ?? "").trim());
}

// The /health mode string the UI reads: "real", "demo" or "setup-required".
export function healthMode(runMode: RunMode): string {
  return runMode === "real" ? "real" : runMode === "demo" ? "demo" : "setup-required";
}
