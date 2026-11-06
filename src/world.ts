// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// World ID gate, backend side.
// For a LARGE proposal the agent may only sign after its owner passes a
// fresh World ID check tied to that exact proposal id.
// A check is valid only if: it names this proposal, it is approved,
// it has not expired, and (in real mode) the proof was validated by the
// backend, never just trusted from the client.
// In demo mode with no World credentials configured, proofs are accepted
// only when explicitly marked mocked, and the demo output labels them
// MOCKED. A denied or expired check always blocks signing.
//
// Verified 2026-11-06: there is no standalone "Agent Pass" SDK or
// endpoint. The official implementation is World ID human-in-the-loop
// (@worldcoin/human-in-the-loop, IDKit 4.x). Backend verification is
// POST https://developer.world.org/api/v4/verify/{rp_id} with the full
// IDKit result as the body, checking success, action, environment and
// results[0].success. Env, server only: WORLD_RP_ID, WORLD_SIGNING_KEY,
// plus the public WORLD_APP_ID (app_...). Never expose the signing key
// to the client. Mocked proofs in the prize page mean no Orb or sandbox
// app is needed for the demo wiring, but a mocked proof proves nothing
// about a real human and must be labelled MOCKED.

export interface WorldConfig {
  rpId: string;
  appId: string;
  signingKey: string;
}

export function loadWorldConfig(env: NodeJS.ProcessEnv): WorldConfig {
  return {
    rpId: (env.WORLD_RP_ID ?? "").trim(),
    appId: (env.WORLD_APP_ID ?? "").trim(),
    signingKey: (env.WORLD_SIGNING_KEY ?? "").trim(),
  };
}

export function isWorldConfigured(config: WorldConfig): boolean {
  return Boolean(config.rpId);
}

// Verify an IDKit proof result against the World v4 endpoint, binding
// it to one exact action (e.g. `council-sign:P-003`). Returns a
// WorldCheck the gate can consume. Throws on network / verify failure;
// callers treat a throw as "does not sign".
export async function verifyWorldProof(
  config: WorldConfig,
  proof: Record<string, unknown>,
  expectedAction: string,
  environment: "production" | "staging" = "production",
): Promise<WorldCheck> {
  const res = await fetch(`https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...proof, action: expectedAction, environment }),
    signal: AbortSignal.timeout(10_000),
  });
  const v = (await res.json().catch(() => null)) as {
    success?: boolean;
    action?: string;
    environment?: string;
    results?: Array<{ success?: boolean }>;
    nullifier?: string;
  } | null;
  const ok =
    res.ok &&
    v?.success === true &&
    v.action === expectedAction &&
    v.environment === environment &&
    v.results?.[0]?.success === true;
  const now = new Date();
  return {
    proposalId: expectedAction.replace(/^council-sign:/, ""),
    status: ok ? "approved" : "denied",
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    source: "world",
    backendValidated: ok,
  };
}

export interface WorldCheck {
  proposalId: string;
  status: "approved" | "denied" | "expired" | "cancelled";
  verifiedAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp
  source: "world" | "mocked";
  // Backend validation result, when a real verifier ran.
  backendValidated?: boolean;
}

export interface WorldGateResult {
  allowed: boolean;
  reason: string;
}

export function worldGate(check: WorldCheck | null, proposalId: string, now = new Date()): WorldGateResult {
  if (!check) {
    return { allowed: false, reason: "No World ID check was presented for this large proposal." };
  }
  if (check.proposalId !== proposalId) {
    return { allowed: false, reason: `World ID check was for proposal ${check.proposalId}, not ${proposalId}.` };
  }
  if (check.status !== "approved") {
    return { allowed: false, reason: `World ID check was ${check.status}, not approved. The agent does not sign.` };
  }
  if (new Date(check.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "World ID check has expired. The agent does not sign." };
  }
  if (check.source === "world" && check.backendValidated === false) {
    return { allowed: false, reason: "World ID proof failed backend validation. The agent does not sign." };
  }
  return {
    allowed: true,
    reason:
      check.source === "mocked"
        ? "World ID check approved (MOCKED proof, demo only)."
        : "World ID check approved and backend-validated for this exact proposal.",
  };
}

// Demo helper: build a mocked check. Only for the demo rehearsal, never
// presented as a real World verification.
export function mockedWorldCheck(
  proposalId: string,
  status: WorldCheck["status"],
  minutesValid = 5,
): WorldCheck {
  const now = new Date();
  return {
    proposalId,
    status,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutesValid * 60_000).toISOString(),
    source: "mocked",
    backendValidated: false,
  };
}
