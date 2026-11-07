// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Express server. Endpoints:
//   GET  /health                -> mode, network, prices, what is real
//   POST /check                 -> x402-protected proposal check (the paid check service).
//     Real mode: @x402/express paymentMiddleware, Official facilitator
//     https://x402.org/facilitator, network hedera:testnet, price $0.01
//     in testnet USDC 0.0.429274, paid to X402_PAY_TO. No payment -> 402.
//     Simulated mode: same route, plain 402 shape from src/x402.ts.
//   POST /proposals             -> full council flow for a proposal
//     (pay via x402, 0G verdict, mismatch check, World ID gate, sign/refuse).
//     Client-supplied World ID "checks" are ignored: only approvals the
//     server verified itself count. A proposal id is bound to its content
//     on first submission, so an approval cannot be reused for a changed transfer.
//   POST /proposals/:id/execute -> after the challenge window: re-check, then sign or abort
//   POST /proposals/:id/challenge -> pause ({reason}) or resume ({resume:true}) execution
//   POST /payees/:account/revoke -> revoke a payee registry entry at runtime
//   POST /council/revoke        -> leave the council (own seat, immediate: epoch +1, pending proposals
//     cancelled), or propose removing another seat (202: opens revocation vote R-n)
//   POST /council/revocations/:id/vote -> ballot on a revocation vote; a majority of the other seats removes it
//   POST /council/invites       -> a seat holder issues a single-use, 24 hour invite to join
//   GET  /council/epoch         -> {epoch, revokedSeats}
//   State-changing routes above need COUNCIL_API_KEY when it is set (src/auth.ts).
//   GET  /proposals             -> list of registered proposals
//   GET  /proposals/:id         -> registered proposal, last outcome, approval state
//   GET  /proposals/:id/evidence -> evidence bundle for the decision, with a digest
//   GET  /policy                -> the published agent policy and its hash
//   GET  /audit, /audit/verify  -> the HCS decision log, and a re-check of its hash chain
//   GET  /world/config          -> public World ID config for the approval page
//   POST /world/rp-context      -> RP-signed IDKit request for one server-chosen action
//   POST /world/verify          -> verify the owner's World ID for one proposal,
//     store the approval server-side (5 min, single use)
//   POST /council/join          -> Proof of Human council join, one seat per nullifier. The first
//     seat founds the council; every later seat needs an invite ({invite}).
//   GET  /council/seats         -> current seats
//   Standing instructions and council votes (docs/mandate-spec.md):
//   GET  /mandate, POST /mandate/draft, POST /mandate/:id/vote, POST /proposals/:id/vote,
//   GET  /council/votes, GET /council/members/:seat
//   GET  /                      -> static UI from public/ (see docs/ui-handoff.md)
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { atomicToUsd, SpendingCap, usdcToAtomic } from "./budget.js";
import { executePending, processProposal, resolveVote, type CouncilOutcome, type MandateContext } from "./council.js";
import { loadApiAuth } from "./auth.js";
import { checkProposal } from "./checker.js";
import { HederaClient, loadHederaConfig } from "./hedera.js";
import { canonical, sha256, verifyChain, isChainedEntry, type EntryMeta } from "./auditlog.js";
import {
  ballotDetail,
  castBallot,
  compileMandate,
  MAX_MANDATE_TEXT,
  monthKey,
  openTally,
  rulesHash,
  summarize,
  voteSignal,
  type MandateDraft,
  type VoteItem,
} from "./mandate.js";
import { HederaChain, loadCouncilSetup, type ChainPort } from "./chain.js";
import { SimulatedCheckPayer, X402CheckPayer, type CheckPayer } from "./payment.js";
import { isLargeProposal, proposalFingerprint, validateProposal, type Proposal } from "./proposal.js";
import { DEMO_PAYEES, loadPayeeRegistry } from "./payee.js";
import { buildPolicy } from "./policy.js";
import { StateStore, type RevocationVote } from "./store.js";
import {
  ApprovalStore,
  councilSignAction,
  isWorldConfigured,
  JOIN_ACTION,
  loadWorldConfig,
  proposalSignal,
  JOIN_SIGNAL,
  inviteSignal,
  revokeSignal,
  mockedAllowed,
  mockedWorldCheck,
  rpContextFor,
  verifiedWorldCheck,
  verifyWorldProof,
} from "./world.js";
import { loadZeroGConfig } from "./zeroG.js";
import { HEDERA_KEYS, WORLD_KEYS, ZERO_G_KEYS, isRealOnly, missingKeys, missingSetup, mockedDisabledReason, setupRequiredBody } from "./realOnly.js";
import { acceptsForCheck, paymentRequiredResponse, X402_FACILITATOR_URL } from "./x402.js";
import { APPROVAL_TTL_MINUTES } from "./world.js";
import { hashscanUrl } from "./hedera.js";
import { demoMode, healthMode, resolveRunMode, type RunMode } from "./runmode.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
}

// 0 (the default) disables the challenge window.
function windowSeconds(env: NodeJS.ProcessEnv): number {
  const v = Number((env.CHALLENGE_WINDOW_SECONDS ?? "").trim() || 0);
  if (!Number.isSafeInteger(v) || v < 0) throw new Error("CHALLENGE_WINDOW_SECONDS must be a whole number of seconds, 0 or more");
  return v;
}

export function buildAgent(env: NodeJS.ProcessEnv = process.env, port = Number(env.PORT ?? 3000)) {
  const { config, mode: hederaMode } = loadHederaConfig(env);
  const runMode: RunMode = resolveRunMode(env);
  // DEMO_MODE=1 forces the simulated paths even when credentials are set:
  // the demo fallback must never touch the real chain by accident.
  const mode = runMode === "demo" ? "simulated" : hederaMode;
  const council = mode === "real" ? loadCouncilSetup(env) : null;
  // The treasury comes from setup when not set explicitly.
  if (council?.treasuryAccountId && !env.HEDERA_TREASURY_ACCOUNT_ID?.trim()) config.treasuryAccountId = council.treasuryAccountId;
  const hedera = new HederaClient(config, mode);
  const priceUsd = (env.X402_PRICE_USDC ?? "0.01").trim();
  const priceAtomic = usdcToAtomic(priceUsd);
  const x402Network = config.network === "mainnet" ? ("hedera:mainnet" as const) : ("hedera:testnet" as const);
  const payTo = (env.X402_PAY_TO ?? "").trim() || config.accountId || "0.0.0";
  const checkServiceUrl = (env.CHECK_SERVICE_URL ?? "").trim() || `http://127.0.0.1:${port}/check`;
  const payer: CheckPayer =
    mode === "real"
      ? new X402CheckPayer(
          { url: checkServiceUrl, accountId: config.accountId, privateKey: config.privateKey, network: x402Network, expectedPayTo: payTo },
          priceAtomic,
        )
      : new SimulatedCheckPayer(hedera, priceAtomic, { expectedPayTo: payTo });
  // The demo payees are accepted only in simulated mode, and say so.
  // Under REAL_ONLY=1 there is no demo registry: unknown payees are refused.
  const payees = loadPayeeRegistry(env, mode === "simulated" && !isRealOnly(env) ? DEMO_PAYEES : []);
  return {
    payees,
    // Real mode fails closed without a 0G verdict; ALLOW_NO_0G=true overrides.
    requireVerdict: mode === "real",
    allowNo0G: (env.ALLOW_NO_0G ?? "").trim().toLowerCase() === "true",
    hedera,
    spendCapUsd: (env.AGENT_SPEND_CAP_USDC ?? "0.10").trim(),
    budget: new SpendingCap(usdcToAtomic((env.AGENT_SPEND_CAP_USDC ?? "0.10").trim())),
    zeroG: loadZeroGConfig(env),
    world: loadWorldConfig(env),
    largeThresholdTinybars: envInt(env, "LARGE_PROPOSAL_TINYBARS", 50_000_000),
    challengeWindowSeconds: windowSeconds(env),
    payer,
    chain: mode === "real" ? new HederaChain(hedera, council) : undefined,
    councilProposer: council?.memberAccountId ?? null,
    payTo,
    priceUsd,
    priceAtomic,
    x402Network,
    checkServiceUrl,
    mode,
    runMode,
    demoExplicit: demoMode(env),
  };
}

interface RegisteredProposal {
  proposal: Proposal;
  fingerprint: string;
  lastOutcome: CouncilOutcome | null;
  // Set while the proposal waits in its challenge window.
  pending: { until: string; epoch: number; challenged: boolean; reason: string | null } | null;
  // True while an execution is in flight, so two calls cannot both sign.
  busy?: boolean;
  // Settles when the in-flight execution has recorded its outcome.
  inflight?: Promise<void>;
  // Epoch in which its council vote opened (PENDING_VOTE).
  voteEpoch?: number;
}

export interface DemoSeedProposal {
  id: string;
  decision: string;
}

export interface DemoSeedReport {
  seeded: boolean;
  reason?: string;
  mandate?: string;
  seats?: number;
  proposals?: DemoSeedProposal[];
}

export type SeedDemoStateFn = () => Promise<DemoSeedReport>;

// The app createApp returns: plain Express plus the demo seed, attached but
// never called by createApp itself (tests assert on fresh state).
export type SeededApp = Express & { seedDemoState: SeedDemoStateFn };

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  // null keeps seats and spent approvals in memory (tests).
  statePath?: string | null;
  // Injected clock (tests): drives challenge windows and expiry checks.
  now?: () => Date;
  // Injected World verify transport (tests).
  worldFetch?: typeof fetch;
  // Injected Hedera side (tests): lets seat revocation be exercised without a network.
  chain?: ChainPort;
  port?: number;
  // Injected 0G transport for compiling standing instructions (tests).
  zeroGFetch?: typeof fetch;
}

export async function createApp(options: AppOptions = {}): Promise<SeededApp> {
  const env = options.env ?? process.env;
  const clock = options.now ?? (() => new Date());
  const built = buildAgent(env, options.port);
  const agent = { ...built, now: clock, chain: options.chain ?? built.chain };
  const auth = loadApiAuth(env);
  const store = new StateStore(
    options.statePath === undefined ? (env.STATE_FILE ?? join(ROOT, ".data", "state.json")) : options.statePath,
  );
  const approvals = new ApprovalStore();
  const { policy, hash: policyHash } = buildPolicy({
    network: agent.hedera.config.network,
    mode: agent.mode,
    treasury: agent.hedera.config.treasuryAccountId || "simulated",
    signers: {
      agent: agent.hedera.config.accountId || "simulated",
      proposer: agent.councilProposer,
      threshold: agent.councilProposer ? "2 of 2 (agent and council member)" : agent.mode === "real" ? "set by the treasury key" : "simulated",
    },
    largeThresholdTinybars: agent.largeThresholdTinybars,
    check: { via: agent.payer.via, priceUsdc: agent.priceUsd, spendCapUsdc: agent.spendCapUsd, decidedBy: "deterministic checker", payTo: agent.payTo },
    payees: agent.payees.summary(),
    verdict: { zeroG: agent.zeroG.apiKey ? "configured" : "not configured", requireVerdict: agent.requireVerdict, allowNo0G: agent.allowNo0G },
    worldGate: { requiredForLarge: true, environment: agent.world.environment, approvalTtlMinutes: APPROVAL_TTL_MINUTES, singleUse: true },
    transferSource: agent.mode === "real" ? "hedera-mirror-node" : "request",
    challenge: { windowSeconds: agent.challengeWindowSeconds, recheckAtExecution: true },
    auth: { enabled: auth.enabled },
  });
  // The demo kill-switch (src/realOnly.ts). REAL_ONLY=1: no mocked proofs,
  // no demo payee registry, and every route that needs real credentials
  // fails closed with a setup-required message instead of demo data.
  const realOnly = isRealOnly(env);
  const setupMissing = missingSetup(env);
  const authLabel = auth.enabled ? "API key required for state-changing routes" : realOnly ? "open (real-only: set COUNCIL_API_KEY before exposing)" : "open (demo)";
  agent.hedera.setPolicy(policyHash);
  const proposals = new Map<string, RegisteredProposal>();
  const worldOn = isWorldConfigured(agent.world);
  const allowMocked = realOnly ? false : mockedAllowed(agent.world, agent.hedera.config.network);
  // Fail-closed guard for state-changing routes under REAL_ONLY=1: returns
  // the 503 setup-required body when the credentials the route needs are
  // missing, null when the route may proceed. Default mode is unaffected.
  const setupGuard = (keys: string[]): { setupRequired: true; realOnly: true; missing: { key: string; where: string }[] } | null =>
    realOnly && missingKeys(env, keys).length > 0 ? setupRequiredBody(env, keys) : null;

  const mandateCtx = (): MandateContext | null => {
    const m = store.activeMandate();
    if (!m) return null;
    return { id: m.id, rulesHash: m.rulesHash, rules: m.rules, spentThisMonthTinybars: store.spentThisMonth(clock()), seats: store.seats().map((s) => s.seat) };
  };
  // Decisions that read the monthly spend run one at a time, so two payments
  // cannot both fit under the cap on the same reading.
  let spendQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = spendQueue.then(fn, fn);
    spendQueue = run.catch(() => undefined);
    return run;
  };
  const recordIfSigned = (o: CouncilOutcome) => {
    if (o.decision === "SIGNED") store.recordSpend({ proposalId: o.proposal.id, amountTinybars: o.proposal.transfer.amountTinybars, at: clock().toISOString() });
  };
  const proposalVoteOpen = (v: VoteItem) => v.decision === "PENDING_VOTE" && v.vote.status === "open";
  const mandateItem = (m: MandateDraft): VoteItem => ({
    subject: m.id,
    kind: "mandate",
    title: `Standing instruction ${m.id}: ${m.text.slice(0, 160)}`,
    summary: m.summary,
    vote: m.vote,
    decision: m.status,
    openedAt: m.createdAt,
  });
  const revocationItem = (r: RevocationVote): VoteItem => ({
    subject: r.subject,
    kind: "revocation",
    title: `Remove ${r.target}`,
    target: r.target,
    openedBy: r.openedBy,
    summary: [`Proposed by ${r.openedBy}. Only the other seats vote; a majority of them removes ${r.target}.`, ...(r.closedReason ? [r.closedReason] : [])],
    vote: r.vote,
    decision: r.status,
    openedAt: r.openedAt,
  });
  const allVotes = () => {
    const items = [...store.votes(), ...store.mandates().map(mandateItem), ...store.revocations().map(revocationItem)].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    const isOpen = (i: VoteItem) => (i.kind === "proposal" ? proposalVoteOpen(i) : i.decision === "open");
    return { items, isOpen };
  };
  // A ballot on a revocation is bound to the seat it removes and the epoch it opened in.
  const revocationFingerprint = (r: RevocationVote) => `revoke:${r.target}:${r.epoch}`;
  // Public id for an invite: the code itself is a bearer secret and never logged.
  const inviteId = (code: string) => sha256(code).slice(0, 10);
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // Setup-required mode: no Hedera credentials and no DEMO_MODE. The server
  // still starts and still answers reads, but every state-changing route
  // fails closed with a 503 that names the missing credentials and where to
  // get them. Nothing is faked, nothing crashes. See docs/REAL-MODE-RUNBOOK.md.
  const setupBlockedMissing = agent.runMode === "setup" ? missingSetup(env) : [];
  const setupError = () => ({
    error: "Setup required: this server has no Hedera credentials and DEMO_MODE is not set, so it cannot act on the real chain. Set the credentials in .env (see docs/REAL-MODE-RUNBOOK.md) or start with DEMO_MODE=1 for the labelled demo fallback.",
    setupRequired: true,
    missing: setupBlockedMissing,
  });
  const SETUP_BLOCKED = ["/check", "/proposals", "/council", "/mandate", "/payees", "/world/verify", "/world/rp-context"];
  // Under REAL_ONLY=1 the middleware stands down: the per-route guards
  // govern instead, so /world/verify keeps its own 404-before-mocked
  // ordering, mocked paths get their 403 real-only reason, and routes
  // that need credentials still fail closed with 503 via setupGuard.
  // Plain setup mode (REAL_ONLY unset) is still blocked here.
  app.use((req, res, next) => {
    if (!realOnly && setupBlockedMissing.length && req.method !== "GET" && req.method !== "HEAD" && SETUP_BLOCKED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      res.status(503).json(setupError());
      return;
    }
    next();
  });

  if (agent.mode === "real" && !auth.enabled) {
    console.warn("COUNCIL_API_KEY is not set: POST /proposals and the other state-changing routes are unauthenticated. Set it before exposing this server.");
  }
  if (agent.mode === "real" && agent.payTo === agent.hedera.config.accountId) {
    console.warn(
      "X402_PAY_TO equals HEDERA_ACCOUNT_ID: the agent would pay its own check fees to itself. " +
        "Set X402_PAY_TO to a separate fee account (npm run preflight -- --create-fee-account).",
    );
  }

  // Real x402 protection for POST /check, in real mode only, when a payee
  // account is set. Demo mode always takes the plain 402 path below, even
  // when credentials are present, so the fallback never spends real USDC.
  // The resource server must initialize() first: it fetches the
  // facilitator's supported kinds, otherwise every request fails with
  // "Facilitator does not support exact on hedera:testnet". If the
  // facilitator is unreachable at boot, real mode fails closed: /check
  // returns 503 instead of accepting unverified payments (see the handler).
  let x402Applied = false;
  let x402Error: string | null = null;
  if (agent.runMode === "real" && agent.payTo !== "0.0.0") {
    try {
      const { HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server");
      const { paymentMiddleware } = await import("@x402/express");
      const { ExactHederaScheme } = await import("@x402/hedera/exact/server");
      const { bazaarResourceServerExtension, declareDiscoveryExtension } = await import("@x402/extensions/bazaar");
      const resourceServer = new x402ResourceServer(
        new HTTPFacilitatorClient({ url: (env.X402_FACILITATOR_URL ?? "").trim() || X402_FACILITATOR_URL }),
      )
        .register(agent.x402Network, new ExactHederaScheme())
        .registerExtension(bazaarResourceServerExtension);
      await resourceServer.initialize();
      app.use(
        paymentMiddleware(
          {
            "POST /check": {
              accepts: [{ scheme: "exact", price: `$${agent.priceUsd}`, network: agent.x402Network, payTo: agent.payTo }],
              description: "Paid proposal check: one check of one treasury proposal",
              // x402 Bazaar discovery: lets other agents find and call this paid check.
              extensions: {
                ...declareDiscoveryExtension({
                  bodyType: "json",
                  input: {
                    proposal: {
                      id: "P-001",
                      description: { payee: "0.0.1001", amountTinybars: 10000000, token: "HBAR", purpose: "Pay the venue deposit" },
                      transfer: { payee: "0.0.1001", amountTinybars: 10000000, token: "HBAR" },
                    },
                  },
                  inputSchema: { properties: { proposal: { type: "object" } }, required: ["proposal"] },
                  output: {
                    example: { proposalId: "P-001", matches: true, mismatches: [], verdict: "Proposal P-001 matches its description." },
                  },
                }),
              },
            },
          },
          resourceServer,
        ),
      );
      x402Applied = true;
    } catch (err) {
      x402Error = err instanceof Error ? err.message : String(err);
      console.warn("x402 middleware unavailable, real mode fails closed on /check:", x402Error);
    }
  }

  // What is real, what is demo, and what is still missing. The UI reads
  // mode ("real", "demo" or "setup-required") for its banner; runMode is
  // the same value in the server's own words.
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      mode: healthMode(agent.runMode),
      runMode: agent.runMode,
      realOnly,
      ...(agent.runMode !== "demo" && setupMissing.length ? { missingCredentials: setupMissing, setupNote: "Set the missing credentials in .env (docs/REAL-MODE-RUNBOOK.md) or start with DEMO_MODE=1 for the labelled demo fallback." } : {}),
      // Under REAL_ONLY=1 with credentials missing, the server starts but
      // refuses to act: every state-changing route returns this payload.
      setupRequired: realOnly && setupMissing.length > 0 ? { missing: setupMissing } : null,
      network: agent.hedera.config.network,
      x402Seller:
        agent.runMode === "setup"
          ? "setup required"
          : x402Applied
            ? `real (@x402/express, Official facilitator, $${agent.priceUsd} USDC to ${agent.payTo})`
            : agent.runMode === "real"
              ? `unavailable (facilitator unreachable at boot${x402Error ? `: ${x402Error}` : ""}): /check returns 503`
              : "simulated (plain 402 shape)",
      x402Buyer: agent.payer.via === "x402" ? `real, pays ${agent.checkServiceUrl}` : "simulated (SIM-PAY ids)",
      checkPrice: atomicToUsd(agent.priceAtomic),
      spendCapRemaining: atomicToUsd(agent.budget.remainingAtomic),
      hcsTopic: agent.hedera.config.topicId || (agent.mode === "real" ? "created on first audit" : "simulated"),
      treasury: agent.hedera.config.treasuryAccountId || "simulated",
      councilProposer: agent.councilProposer ?? (agent.mode === "real" ? "none: proposals must name a scheduleId" : "simulated"),
      zeroG: agent.zeroG.apiKey ? "real" : realOnly ? "not configured (real-only mode: no simulated verdict)" : "simulated",
      zeroGFailClosed: agent.allowNo0G ? "off (ALLOW_NO_0G=true)" : agent.requireVerdict || agent.zeroG.apiKey ? "on: no 0G verdict, no signature" : "off in simulated mode with no key (labelled template verdict)",
      payeeRegistry: payeeSummary(),
      world: worldOn ? `real (${agent.world.environment})` : realOnly ? "not configured (real-only mode: mocked approvals disabled)" : "not configured, MOCKED approvals only",
      councilSeats: store.seats().length,
      epoch: store.epoch(),
      mandate: (() => {
        const m = store.activeMandate();
        return m ? `${m.id} (rulesHash ${m.rulesHash}): inside it the agent decides alone, outside it the council votes` : "none: every large payment needs a World ID approval";
      })(),
      auth: authLabel,
      challengeWindow: agent.challengeWindowSeconds > 0 ? `${agent.challengeWindowSeconds}s, re-checked at execution` : "off (signs as soon as every check passes)",
      note:
        realOnly && setupMissing.length > 0
          ? `REAL-ONLY mode: setup required before this server can act. Missing: ${setupMissing.map((m) => m.key).join(", ")}. See /health setupRequired for where to get each one.`
          : realOnly
            ? "REAL-ONLY mode (REAL_ONLY=1): all credentials configured. No demo data, no mocked proofs."
            : agent.runMode === "setup"
              ? "SETUP REQUIRED: no Hedera credentials set and DEMO_MODE is not 1. State-changing routes return 503 until the credentials are set (docs/REAL-MODE-RUNBOOK.md) or the server is started with DEMO_MODE=1."
              : agent.runMode === "demo"
                ? "DEMO mode (DEMO_MODE=1): no real chain ids. Chain ids are SIM- ids, not real."
                : "REAL mode: Hedera credentials set.",
    });
  });

  // Machine-readable setup state: which credentials are missing and where
  // each one comes from. The same list /health carries in setup mode.
  app.get("/setup", (_req, res) => {
    res.json({
      runMode: agent.runMode,
      realOnly,
      ready: agent.runMode === "real" && setupMissing.length === 0,
      missing: agent.runMode === "setup" ? setupMissing : missingSetup(env),
      demoFallback: "Start with DEMO_MODE=1 for the labelled demo fallback. It never touches the real chain.",
      runbook: "docs/REAL-MODE-RUNBOOK.md",
    });
  });

  app.post("/check", (req, res) => {
    const v = validateProposal(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const checkGuard = setupGuard(HEDERA_KEYS);
    if (checkGuard) {
      res.status(503).json({ error: "Setup required: this server cannot run a paid check without Hedera credentials.", ...checkGuard });
      return;
    }
    if (x402Applied) {
      // The middleware verified the payment before this handler ran and
      // settles it via the facilitator after it.
      res.json({ ...checkProposal(v.proposal), mode: agent.mode });
      return;
    }
    if (agent.runMode === "real") {
      // The facilitator could not be reached at boot, so there is no
      // verified way to take the check fee. The plain 402 path below only
      // checks that a transaction id exists, not that it paid this service
      // the right amount, so real mode refuses instead of taking it.
      res.status(503).json({
        error: `x402 check service unavailable: the facilitator could not be reached at boot${x402Error ? ` (${x402Error})` : ""}. No payment is taken and no check is returned. Restart once the facilitator is reachable.`,
      });
      return;
    }
    // Simulated / fallback path: plain 402, verify a SIM- payment id.
    const payment = req.headers["x-payment"];
    if (!payment || typeof payment !== "string") {
      const r = paymentRequiredResponse(
        acceptsForCheck({ network: agent.hedera.config.network, payTo: agent.payTo, priceTinybars: 100_000 }),
      );
      res.status(r.status).json(r.body);
      return;
    }
    void agent.hedera.verifyPayment(payment).then((ok) => {
      if (!ok) res.status(402).json({ error: "Payment did not verify as settled on Hedera.", x402Version: 1 });
      else res.json({ ...checkProposal(v.proposal), paidWith: payment, mode: agent.mode });
    });
  });

  app.post("/proposals", auth.require, async (req, res) => {
    const v = validateProposal((req.body as { proposal?: unknown } | null)?.proposal);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const proposalGuard = setupGuard(HEDERA_KEYS);
    if (proposalGuard) {
      res.status(503).json({ error: "Setup required: this server cannot process a proposal without Hedera credentials.", ...proposalGuard });
      return;
    }
    const proposal = v.proposal;
    const fingerprint = proposalFingerprint(proposal);
    const known = proposals.get(proposal.id);
    if (known && known.fingerprint !== fingerprint) {
      res.status(409).json({ error: `Proposal ${proposal.id} was already submitted with different content. Use a new id.` });
      return;
    }
    // A proposal in its challenge window is not processed again (that would pay for a second check).
    if (known?.pending && known.lastOutcome) {
      res.json({ ...known.lastOutcome, note: `Already in its challenge window until ${known.pending.until}; not re-processed. Use POST /proposals/${proposal.id}/execute.` });
      return;
    }
    // Nor is one waiting for the council (that would open a second vote).
    if (known?.lastOutcome?.decision === "PENDING_VOTE") {
      res.json({ ...known.lastOutcome, note: `Waiting for the council vote; not re-processed. Seats vote with POST /proposals/${proposal.id}/vote.` });
      return;
    }
    const pastVote = store.vote(proposal.id);
    if (pastVote) {
      res.status(409).json({ error: `The council already voted on ${proposal.id} (${pastVote.decision ?? pastVote.vote.status}). Use a new id.` });
      return;
    }
    const entry = known ?? { proposal, fingerprint, lastOutcome: null, pending: null };
    proposals.set(proposal.id, entry);
    // Resubmissions use the proposal as already resolved against Hedera, so
    // the same schedule is checked and signed, not a new one created.
    const decide = () => processProposal(agent, entry.proposal, approvals.get(proposal.id, clock()), mandateCtx());
    const outcome = store.activeMandate() ? await serialized(async () => {
      const o = await decide();
      recordIfSigned(o);
      return o;
    }) : await decide();
    recordIfSigned(outcome);
    if (outcome.usedWorldApproval) approvals.delete(proposal.id);
    entry.proposal = outcome.proposal;
    entry.lastOutcome = outcome;
    entry.pending = outcome.decision === "PENDING_CHALLENGE" && outcome.challengeUntil ? { until: outcome.challengeUntil, epoch: store.epoch(), challenged: false, reason: null } : null;
    if (outcome.decision === "PENDING_VOTE" && outcome.vote) {
      entry.voteEpoch = store.epoch();
      store.putVote({
        subject: proposal.id,
        kind: "proposal",
        title: entry.proposal.description.purpose,
        amountTinybars: entry.proposal.transfer.amountTinybars,
        payee: entry.proposal.transfer.payee,
        violations: outcome.mandate?.violations ?? [],
        vote: outcome.vote,
        decision: "PENDING_VOTE",
        openedAt: clock().toISOString(),
      });
    }
    const needsApproval =
      outcome.decision === "REFUSED" && outcome.worldGateReason !== null && outcome.checkMatches;
    res.json(needsApproval ? { ...outcome, approveUrl: `/console.html?proposal=${encodeURIComponent(proposal.id)}` } : outcome);
  });

  app.get("/proposals", (_req, res) => {
    res.json({
      proposals: [...proposals.values()].map((e) => ({
        id: e.proposal.id,
        purpose: e.proposal.description.purpose,
        amountTinybars: e.proposal.transfer.amountTinybars,
        large: isLargeProposal(e.proposal, agent.largeThresholdTinybars),
        matches: checkProposal(e.proposal).matches,
        decision: e.lastOutcome?.decision ?? null,
        scheduledTxId: e.lastOutcome?.scheduledTxId ?? null,
        challengeUntil: e.pending?.until ?? null,
        challenged: e.pending?.challenged ?? false,
        vote: store.vote(e.proposal.id)?.vote ?? e.lastOutcome?.vote ?? null,
        mandate: e.lastOutcome?.mandate ? { id: e.lastOutcome.mandate.id, within: e.lastOutcome.mandate.within, violations: e.lastOutcome.mandate.violations } : null,
      })),
    });
  });

  app.get("/proposals/:id", (req, res) => {
    const entry = proposals.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Unknown proposal. Submit it to POST /proposals first." });
      return;
    }
    const approval = approvals.get(entry.proposal.id, clock());
    res.json({
      proposal: entry.proposal,
      large: isLargeProposal(entry.proposal, agent.largeThresholdTinybars),
      check: checkProposal(entry.proposal),
      lastOutcome: entry.lastOutcome,
      approval: approval ? { source: approval.source, expiresAt: approval.expiresAt } : null,
      challenge: entry.pending ? { until: entry.pending.until, challenged: entry.pending.challenged, reason: entry.pending.reason, epoch: entry.pending.epoch } : null,
      vote: store.vote(entry.proposal.id) ?? null,
    });
  });


  // Audit entries that are not a council decision (challenge, revocation).
  const auditNote = async (proposalId: string, event: string, detail: string, proposalForHash?: Proposal, extraMeta?: EntryMeta) => {
    const meta: EntryMeta = { ...(proposalForHash ? { proposalHash: sha256(proposalFingerprint(proposalForHash)) } : {}), ...extraMeta };
    try {
      const r = await agent.hedera.auditEntry({
        proposalId,
        event,
        detail,
        at: clock().toISOString(),
        ...(Object.keys(meta).length ? { meta } : {}),
      });
      return { auditTxId: r.txId, auditSeq: r.entry.seq, auditHash: r.entry.hash, auditError: null };
    } catch (err) {
      return { auditTxId: null, auditSeq: null, auditHash: null, auditError: `HCS audit failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  // Proposal state is in memory: a vote left open by a previous process cannot be resolved.
  for (const v of store.votes()) {
    if (v.decision !== "PENDING_VOTE") continue;
    store.putVote({ ...v, decision: "CANCELLED" });
    await auditNote(v.subject, "VOTE_CANCELLED_RESTART", `Council vote on ${v.subject} closed: the agent restarted and pending proposals are held in memory, so it cannot be resolved. Submit the payment again under a new id.`);
  }

  // Execute after the challenge window: re-check everything, then sign or abort.
  app.post("/proposals/:id/execute", auth.require, async (req, res) => {
    const entry = proposals.get(String(req.params.id));
    if (!entry || !entry.lastOutcome) {
      res.status(404).json({ error: "Unknown proposal. Submit it to POST /proposals first." });
      return;
    }
    const executeGuard = setupGuard(HEDERA_KEYS);
    if (executeGuard) {
      res.status(503).json({ error: "Setup required: this server cannot execute a proposal without Hedera credentials.", ...executeGuard });
      return;
    }
    if (!entry.pending || entry.busy) {
      res.status(409).json({ error: `Proposal ${entry.proposal.id} is not waiting to be executed (decision: ${entry.lastOutcome.decision}).` });
      return;
    }
    entry.busy = true;
    let settle!: () => void;
    entry.inflight = new Promise<void>((resolve) => (settle = resolve));
    try {
      const now = clock();
      const pending = entry.pending;
      const prev = entry.lastOutcome;
      const run = async () => {
        const r = await executePending(
          agent,
          { outcome: prev, challengeUntil: pending.until, challenged: pending.challenged, challengeReason: pending.reason, createdEpoch: pending.epoch },
          { currentEpoch: store.epoch(), approval: approvals.get(entry.proposal.id, now), mandate: mandateCtx() },
        );
        if (r.kind === "done") recordIfSigned(r.outcome);
        return r;
      };
      // Inside-the-instruction payments re-read the monthly spend, so they queue.
      const result = prev.mandate?.within ? await serialized(run) : await run();
      if (result.kind === "too-early") {
        res.status(425).json({ error: result.reason, secondsRemaining: result.secondsRemaining, challengeUntil: entry.pending.until });
        return;
      }
      if (result.kind === "challenged") {
        res.status(409).json({ error: result.reason, challenged: true });
        return;
      }
      const outcome = result.outcome;
      // A spent approval is gone; so is one that backed an aborted execution.
      approvals.delete(entry.proposal.id);
      entry.proposal = outcome.proposal;
      entry.lastOutcome = outcome;
      entry.pending = null;
      res.json(outcome);
    } finally {
      entry.busy = false;
      entry.inflight = undefined;
      settle();
    }
  });

  // Pause (reason) or resume ({resume: true}) a proposal in its challenge window.
  app.post("/proposals/:id/challenge", auth.require, async (req, res) => {
    const entry = proposals.get(String(req.params.id));
    if (!entry) {
      res.status(404).json({ error: "Unknown proposal." });
      return;
    }
    const challengeGuard = setupGuard(HEDERA_KEYS);
    if (challengeGuard) {
      res.status(503).json({ error: "Setup required: this server cannot act on a proposal without Hedera credentials.", ...challengeGuard });
      return;
    }
    if (!entry.pending) {
      res.status(409).json({ error: `Proposal ${entry.proposal.id} is not in a challenge window (decision: ${entry.lastOutcome?.decision ?? "none"}).` });
      return;
    }
    const body = (req.body ?? {}) as { reason?: unknown; resume?: unknown };
    if (body.resume === true) {
      if (!entry.pending.challenged) {
        res.status(409).json({ error: "This proposal is not challenged." });
        return;
      }
      entry.pending.challenged = false;
      entry.pending.reason = null;
      const logged = await auditNote(entry.proposal.id, "CHALLENGE_RESOLVED", `Challenge on ${entry.proposal.id} resolved; execution may proceed after ${entry.pending.until}.`, entry.proposal);
      res.json({ proposalId: entry.proposal.id, state: "pending", challengeUntil: entry.pending.until, ...logged });
      return;
    }
    if (typeof body.reason !== "string" || body.reason.trim().length === 0 || body.reason.length > 300) {
      res.status(400).json({ error: "reason (1-300 chars) is required to challenge a proposal, or send {resume: true}." });
      return;
    }
    if (entry.pending.challenged) {
      res.status(409).json({ error: "This proposal is already challenged." });
      return;
    }
    entry.pending.challenged = true;
    entry.pending.reason = body.reason.trim();
    const logged = await auditNote(entry.proposal.id, "CHALLENGED", `Challenged: ${entry.pending.reason}`.slice(0, 400), entry.proposal);
    res.json({ proposalId: entry.proposal.id, state: "challenged", reason: entry.pending.reason, challengeUntil: entry.pending.until, ...logged });
  });

  app.post("/payees/:account/revoke", auth.require, async (req, res) => {
    const account = String(req.params.account);
    const n = agent.payees.revoke(account, clock());
    if (n === 0) {
      res.status(404).json({ error: `${account} is not an active entry in the payee registry.` });
      return;
    }
    const logged = await auditNote("PAYEES", "PAYEE_REVOKED", `Payee ${account} revoked in the council payee registry (${agent.payees.source}).`);
    res.json({ account, revoked: n, source: agent.payees.source, ...logged });
  });

  app.get("/council/epoch", (_req, res) => {
    res.json({ epoch: store.epoch(), revokedSeats: store.revokedSeatCount() });
  });

  // Applies a seat revocation: epoch +1, the person blocked from rejoining, pending
  // proposals and open votes cancelled, schedules deleted. Used for leaving the
  // council (immediate) and for a revocation vote that passed.
  const applyRevocation = async (targetSeat: string, by: { subject: string; vote: VoteItem["vote"] } | null) => {
    const revoked = store.revokeSeat(targetSeat)!;
    // An execution already past its epoch re-check may be signing right now. Let it record its
    // real outcome first; cancelling under it would leave CANCELLED on a transfer that went out.
    // Executions that start after the epoch bump abort on the re-check, so busy entries are skipped.
    const inFlight = [...proposals.values()].filter((e) => e.inflight);
    await Promise.all(inFlight.map((e) => e.inflight));
    const cancelled = [...proposals.values()].filter((e) => (e.pending || e.lastOutcome?.decision === "PENDING_VOTE") && e.lastOutcome && !e.busy);
    for (const e of cancelled) {
      e.pending = null;
      approvals.delete(e.proposal.id);
      e.lastOutcome = { ...e.lastOutcome!, decision: "CANCELLED", reason: `Cancelled: seat ${revoked.seat.seat} was revoked (epoch ${revoked.fromEpoch} -> ${revoked.toEpoch}).`, challengeUntil: null };
      const v = store.vote(e.proposal.id);
      if (v) store.putVote({ ...v, decision: "CANCELLED" });
    }
    // Open adoption votes were taken over a council that no longer exists.
    const closedMandates = store.mandates().filter((m) => m.status === "open");
    for (const m of closedMandates) {
      store.updateMandate({ ...m, status: "rejected", closedReason: `Closed: seat ${revoked.seat.seat} was revoked (epoch ${revoked.fromEpoch} -> ${revoked.toEpoch}). Draft it again.` });
    }
    // So were other open revocation votes; their ballots are bound to the old epoch.
    const closedRevocations = store.revocations().filter((r) => r.status === "open" && r.subject !== by?.subject);
    for (const r of closedRevocations) {
      store.putRevocation({ ...r, status: "cancelled", closedAt: clock().toISOString(), closedReason: `Closed: seat ${revoked.seat.seat} was revoked (epoch ${revoked.fromEpoch} -> ${revoked.toEpoch}). Propose it again.` });
    }
    const scheduleErrors: string[] = [];
    if (agent.chain?.cancel) {
      for (const e of cancelled) {
        const id = e.lastOutcome!.scheduledTxId ?? e.proposal.scheduleId;
        if (!id) continue;
        try {
          await agent.chain.cancel(id);
        } catch (err) {
          scheduleErrors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const detail =
      `epoch ${revoked.fromEpoch} -> ${revoked.toEpoch}, seat ${revoked.seat.seat} revoked, ${cancelled.length} pending proposals cancelled` +
      (closedMandates.length ? `, ${closedMandates.length} open instruction votes closed` : "") +
      (closedRevocations.length ? `, ${closedRevocations.length} open removal votes closed` : "") +
      (scheduleErrors.length ? `, ${scheduleErrors.length} schedule deletions failed` : "") +
      (by ? `, removed by council vote ${by.subject} (${by.vote.yes} of ${by.vote.eligible.length})` : ", left the council");
    const logged = await auditNote("COUNCIL", "REVOKED", detail);
    for (const e of cancelled) {
      e.lastOutcome = { ...e.lastOutcome!, cancelledBy: { auditSeq: logged.auditSeq, auditHash: logged.auditHash, epoch: revoked.toEpoch } };
    }
    for (const m of closedMandates) {
      await auditNote(m.id, "MANDATE_REJECTED", `Standing instruction ${m.id} closed without adoption: seat ${revoked.seat.seat} was revoked (epoch ${revoked.fromEpoch} -> ${revoked.toEpoch}).`, undefined, { rulesHash: m.rulesHash });
    }
    return {
      revoked: true,
      seat: revoked.seat.seat,
      by: by ? `council vote ${by.subject}` : "self",
      epoch: revoked.toEpoch,
      cancelledProposals: cancelled.map((e) => e.proposal.id),
      closedMandateVotes: closedMandates.map((m) => m.id),
      closedRevocationVotes: closedRevocations.map((r) => r.subject),
      settledBeforeRevocation: inFlight.map((e) => ({ id: e.proposal.id, decision: e.lastOutcome?.decision ?? null })),
      scheduleDeletion: agent.mode === "real" ? (scheduleErrors.length ? { failed: scheduleErrors } : "deleted") : "simulated: recorded only, no Hedera schedule existed",
      detail,
      ...logged,
    };
  };

  // Leaving the council (own seat) is immediate. Removing another seat opens a
  // revocation vote among the other seats. Only a current seat holder, proven human, may do either.
  app.post("/council/revoke", auth.require, async (req, res) => {
    const body = (req.body ?? {}) as { seat?: unknown; nullifier?: unknown; idkitResult?: Record<string, unknown>; mocked?: unknown; byNullifier?: unknown };
    let holder: string | null = null;
    if (body.mocked === true) {
      if (!allowMocked) {
        res.status(403).json({ error: realOnly ? mockedDisabledReason("revocations") : "Mocked revocations are disabled: World ID is configured (or this is mainnet)." });
        return;
      }
      if (typeof body.byNullifier !== "string" || !store.seats().some((s) => s.source === "mocked" && s.nullifier === body.byNullifier)) {
        res.status(403).json({ error: "Only a current seat holder may revoke a seat." });
        return;
      }
      holder = body.byNullifier;
    } else {
      if (!worldOn || !body.idkitResult || typeof body.idkitResult !== "object") {
        res.status(400).json({ error: "World ID is not configured, or no idkitResult was supplied." });
        return;
      }
      const named = store.seats().find((s) => (typeof body.seat === "string" && s.seat === body.seat) || (typeof body.nullifier === "string" && s.nullifier === body.nullifier));
      if (!named) {
        res.status(404).json({ error: "No such seat. Give a seat id (seat) or its nullifier." });
        return;
      }
      const verified = await verifyWorldProof(agent.world, body.idkitResult, JOIN_ACTION, options.worldFetch, revokeSignal(named.seat));
      if (!verified.ok || !verified.nullifier) {
        res.status(403).json({ revoked: false, error: verified.detail });
        return;
      }
      if (!store.seats().some((s) => s.source === "world" && s.nullifier === verified.nullifier)) {
        res.status(403).json({ revoked: false, error: "Only a current seat holder may revoke a seat." });
        return;
      }
      holder = verified.nullifier;
    }
    const target = store.seats().find((s) => (typeof body.seat === "string" && s.seat === body.seat) || (typeof body.nullifier === "string" && s.nullifier === body.nullifier));
    if (!target) {
      res.status(404).json({ error: "No such seat. Give a seat id (seat) or its nullifier." });
      return;
    }
    const holderSeat = store.seats().find((s) => s.nullifier === holder)!;
    if (holder === target.nullifier) {
      res.json(await applyRevocation(target.seat, null));
      return;
    }
    const already = store.revocations().find((r) => r.status === "open" && r.target === target.seat);
    if (already) {
      res.status(409).json({ voteOpened: false, error: `A vote on removing ${target.seat} is already open (${already.subject}).`, subject: already.subject, vote: already.vote });
      return;
    }
    const eligible = store.seats().map((s) => s.seat).filter((s) => s !== target.seat);
    if (eligible.length === 0) {
      res.status(409).json({ voteOpened: false, error: `No other seat could vote on removing ${target.seat}.` });
      return;
    }
    const r = store.openRevocation({ target: target.seat, openedBy: holderSeat.seat, epoch: store.epoch(), vote: openTally(eligible), status: "open", openedAt: clock().toISOString() });
    const logged = await auditNote(
      r.subject,
      "REVOCATION_VOTE_OPENED",
      `${holderSeat.seat} proposed removing ${target.seat}. Council vote ${r.subject} opened: ${r.vote.needed} of the ${eligible.length} other seats needed.`,
    );
    res.status(202).json({ voteOpened: true, subject: r.subject, kind: "revocation", target: target.seat, by: holderSeat.seat, vote: r.vote, ...logged });
  });

  // Link to the original console app (run separately: npm run console).
  app.get("/original-console", (_req, res) => {
    res.redirect((env.ORIGINAL_CONSOLE_URL ?? "").trim() || "http://localhost:3380/council");
  });

  const payeeSummary = () => {
    const sm = agent.payees.summary();
    const name = sm.source === "demo registry" ? "demo registry" : sm.source;
    return `${name}: ${sm.count} payee(s), ${sm.enforce ? "enforced" : "not enforced"}`;
  };

  app.get("/payees", (_req, res) => {
    res.json({ ...agent.payees.summary(), payees: agent.payees.entries });
  });

  app.get("/policy", (_req, res) => {
    const m = store.activeMandate();
    res.json({
      policy,
      hash: policyHash,
      auth: authLabel,
      note: "Every HCS audit entry carries this hash.",
      // Outside the hashed policy: adopting an instruction must not change the policy hash.
      mandate: m ? { id: m.id, rulesHash: m.rulesHash, textHash: m.textHash, summary: m.summary, adoptedAt: m.adoptedAt ?? null, source: m.source } : null,
    });
  });

  const topicLink = (topicId: string | null) =>
    topicId && agent.mode === "real"
      ? `https://hashscan.io/${agent.hedera.config.network === "mainnet" ? "mainnet" : "testnet"}/topic/${topicId}`
      : null;

  // Re-reads the audit topic and re-checks the hash chain from scratch.
  app.get("/audit/verify", async (_req, res) => {
    try {
      const log = await agent.hedera.readAuditLog();
      const report = verifyChain(log.messages);
      res.json({ source: log.source, topicId: log.topicId, hashscan: topicLink(log.topicId), truncated: log.truncated, ...report, policyHash });
    } catch (err) {
      res.status(502).json({ error: `Could not read the audit topic: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get("/audit", async (_req, res) => {
    try {
      const log = await agent.hedera.readAuditLog();
      const entries = log.messages.filter(isChainedEntry);
      res.json({
        source: log.source,
        topicId: log.topicId,
        hashscan: topicLink(log.topicId),
        report: verifyChain(log.messages),
        entries: entries.slice(-100),
      });
    } catch (err) {
      res.status(502).json({ error: `Could not read the audit topic: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Everything a judge needs to check one decision, with a digest over it.
  app.get("/proposals/:id/evidence", (req, res) => {
    const entry = proposals.get(req.params.id);
    const o = entry?.lastOutcome;
    if (!entry || !o) {
      res.status(404).json({ error: "No decision recorded for this proposal yet." });
      return;
    }
    const net = agent.hedera.config.network;
    const real = o.mode === "real";
    const bundle = {
      version: 1,
      proposalId: entry.proposal.id,
      decision: o.decision,
      reason: o.reason,
      mode: o.mode,
      policyHash,
      proposal: entry.proposal,
      transferSource: o.transferSource,
      check: checkProposal(entry.proposal),
      payment: { via: o.paidVia, id: o.paidTxId, hashscan: real && o.paidTxId ? hashscanUrl(net, o.paidTxId) : null },
      zeroG: { source: o.zeroGSource, requestId: o.zeroGRequestId, verdict: o.zeroGVerdictText },
      worldGate: o.worldGateReason,
      schedule: {
        id: o.scheduledTxId,
        action: o.scheduleAction,
        hashscan: real && o.scheduledTxId ? `https://hashscan.io/${net === "mainnet" ? "mainnet" : "testnet"}/schedule/${o.scheduledTxId}` : null,
      },
      audit: { txId: o.auditTxId, seq: o.auditSeq, entryHash: o.auditHash, topicId: agent.hedera.config.topicId || null, hashscan: topicLink(agent.hedera.config.topicId || null) },
      ...(o.challengeUntil || o.cancelledBy
        ? { challenge: { until: o.challengeUntil, challenged: entry.pending?.challenged ?? false, cancelledBy: o.cancelledBy ?? null } }
        : {}),
      ...(o.mandate ? { mandate: o.mandate } : {}),
      ...(o.vote ? { vote: o.vote } : {}),
    };
    res.json({ ...bundle, digest: sha256(canonical(bundle)), digestOf: "sha256 over the canonical JSON of this bundle without the digest field" });
  });

  app.get("/world/config", (_req, res) => {
    res.json({
      configured: worldOn,
      appId: worldOn ? agent.world.appId : null,
      environment: agent.world.environment,
      mockedAllowed: allowMocked,
      realOnly,
      setupRequired: realOnly && missingKeys(env, WORLD_KEYS).length > 0,
    });
  });

  // The action is chosen by the server, never by the client.
  // The fingerprint a ballot on this subject is bound to: a proposal's registered
  // fingerprint, or a standing instruction's rulesHash.
  const voteFingerprint = (subject: unknown, kind?: unknown): { fingerprint: string } | { error: string; status: number } => {
    const id = typeof subject === "string" ? subject : "";
    const m = store.mandate(id);
    const p = proposals.get(id);
    const r = store.revocation(id);
    if (kind === "mandate") return m ? { fingerprint: m.rulesHash } : { error: "Unknown standing instruction.", status: 404 };
    if (kind === "proposal") return p ? { fingerprint: p.fingerprint } : { error: "Unknown proposal.", status: 404 };
    if (kind === "revocation") return r ? { fingerprint: revocationFingerprint(r) } : { error: "Unknown revocation vote.", status: 404 };
    if ([m, p, r].filter(Boolean).length > 1) return { error: `More than one vote subject is called ${id}: give kind "proposal", "mandate" or "revocation".`, status: 400 };
    if (m) return { fingerprint: m.rulesHash };
    if (p) return { fingerprint: p.fingerprint };
    if (r) return { fingerprint: revocationFingerprint(r) };
    return { error: "Unknown vote subject. Give a proposal id, a standing instruction id or a revocation vote id (subject).", status: 404 };
  };

  const actionFor = (body: { proposalId?: unknown; join?: unknown; revoke?: unknown; invite?: unknown; seat?: unknown; vote?: unknown; subject?: unknown; choice?: unknown; kind?: unknown }): { action: string; signal?: string } | { error: string; status: number } => {
    if (body.join === true) return { action: JOIN_ACTION, signal: JOIN_SIGNAL };
    if (body.invite === true) {
      const seat = store.seats().find((s) => s.seat === body.seat);
      return seat ? { action: JOIN_ACTION, signal: inviteSignal(seat.seat) } : { error: "No such seat. Give the inviting seat id (seat).", status: 404 };
    }
    if (body.vote === true) {
      if (body.choice !== "yes" && body.choice !== "no") return { error: 'choice must be "yes" or "no".', status: 400 };
      const f = voteFingerprint(body.subject, body.kind);
      if ("error" in f) return f;
      // Ballots are proven under the join action so the nullifier matches a seat.
      return { action: JOIN_ACTION, signal: voteSignal(body.subject as string, f.fingerprint, body.choice) };
    }
    if (body.revoke === true) {
      const seat = store.seats().find((s) => s.seat === body.seat);
      return seat ? { action: JOIN_ACTION, signal: revokeSignal(seat.seat) } : { error: "No such seat. Give the seat id to revoke (seat).", status: 404 };
    }
    if (typeof body.proposalId !== "string" || !proposals.has(body.proposalId)) {
      return { error: "Unknown proposal. Submit it to POST /proposals first.", status: 404 };
    }
    return { action: councilSignAction(body.proposalId), signal: proposalSignal(proposals.get(body.proposalId)!.fingerprint) };
  };

  app.post("/world/rp-context", (req, res) => {
    if (!worldOn) {
      res.status(503).json({ error: "World ID is not configured on this server (WORLD_RP_ID, WORLD_APP_ID, WORLD_SIGNING_KEY)." });
      return;
    }
    const a = actionFor({
      proposalId: req.body?.proposalId,
      join: req.body?.join,
      revoke: req.body?.revoke,
      invite: req.body?.invite,
      seat: req.body?.seat,
      vote: req.body?.vote,
      subject: req.body?.subject,
      choice: req.body?.choice,
      kind: req.body?.kind,
    });
    if ("error" in a) {
      res.status(a.status).json({ error: a.error });
      return;
    }
    res.json({ action: a.action, signal: a.signal, appId: agent.world.appId, environment: agent.world.environment, rpContext: rpContextFor(agent.world, a.action) });
  });

  app.post("/world/verify", async (req, res) => {
    const body = (req.body ?? {}) as { proposalId?: unknown; idkitResult?: Record<string, unknown>; mocked?: unknown };
    const a = actionFor({ proposalId: body.proposalId });
    if ("error" in a) {
      res.status(a.status).json({ error: a.error });
      return;
    }
    const proposalId = body.proposalId as string;
    if (body.mocked === true) {
      if (!allowMocked) {
        res.status(403).json({ error: realOnly ? mockedDisabledReason("approvals") : "Mocked approvals are disabled: World ID is configured (or this is mainnet)." });
        return;
      }
      const check = mockedWorldCheck(proposalId, "approved");
      approvals.set(check);
      res.json({ approved: true, source: "mocked", expiresAt: check.expiresAt, note: "MOCKED proof, demo only. Not a real World ID verification." });
      return;
    }
    if (!worldOn || !body.idkitResult || typeof body.idkitResult !== "object") {
      res.status(400).json({ error: "World ID is not configured, or no idkitResult was supplied." });
      return;
    }
    const verified = await verifyWorldProof(agent.world, body.idkitResult, a.action, options.worldFetch, a.signal);
    if (!verified.ok || !verified.nullifier) {
      res.status(403).json({ approved: false, error: verified.detail });
      return;
    }
    if (!store.consumeApproval(`${a.action}:${verified.nullifier}`)) {
      res.status(409).json({ approved: false, error: "This World ID approval was already used." });
      return;
    }
    const check = verifiedWorldCheck(proposalId);
    approvals.set(check);
    res.json({ approved: true, source: "world", expiresAt: check.expiresAt, detail: verified.detail });
  });

  // The first seat founds the council; every later seat consumes a single-use invite.
  app.post("/council/join", async (req, res) => {
    const body = (req.body ?? {}) as { idkitResult?: Record<string, unknown>; mocked?: unknown; nullifier?: unknown; invite?: unknown };
    if (body.invite !== undefined && (typeof body.invite !== "string" || body.invite.length === 0 || body.invite.length > 64)) {
      res.status(400).json({ joined: false, error: "invite must be the invite code (1-64 chars)." });
      return;
    }
    const invite = typeof body.invite === "string" ? body.invite : null;
    let nullifier: string;
    let source: "world" | "mocked";
    if (body.mocked === true) {
      if (!allowMocked) {
        res.status(403).json({ error: realOnly ? mockedDisabledReason("joins") : "Mocked joins are disabled: World ID is configured (or this is mainnet)." });
        return;
      }
      if (typeof body.nullifier !== "string" || body.nullifier.length === 0 || body.nullifier.length > 80) {
        res.status(400).json({ error: "nullifier (1-80 chars) is required for a mocked join." });
        return;
      }
      nullifier = `mock:${body.nullifier}`;
      source = "mocked";
    } else {
      if (!worldOn || !body.idkitResult || typeof body.idkitResult !== "object") {
        res.status(400).json({ error: "World ID is not configured, or no idkitResult was supplied." });
        return;
      }
      const verified = await verifyWorldProof(agent.world, body.idkitResult, JOIN_ACTION, options.worldFetch, JOIN_SIGNAL);
      if (!verified.ok || !verified.nullifier) {
        res.status(403).json({ joined: false, error: verified.detail });
        return;
      }
      nullifier = verified.nullifier;
      source = "world";
    }
    const joined = store.joinCouncil(nullifier, source, invite, clock());
    if (!joined.ok) {
      res.status(joined.status).json({ joined: false, error: joined.error });
      return;
    }
    const { seat, invite: used } = joined;
    const logged = await auditNote(
      "COUNCIL",
      "SEAT_JOINED",
      used
        ? `${seat.seat} joined (${source === "world" ? "World ID Proof of Human" : "MOCKED proof, demo only"}) with invite ${inviteId(used.code)} from ${used.by}.`
        : `${seat.seat} founded the council (${source === "world" ? "World ID Proof of Human" : "MOCKED proof, demo only"}).`,
    );
    res.json({
      joined: true,
      seat: seat.seat,
      founder: !used,
      invitedBy: used?.by ?? null,
      // The stored nullifier lets the browser remember "who am I" in demo mode.
      ...(source === "mocked" ? { nullifier: seat.nullifier, proof: "MOCKED Proof of Human (demo only)" } : { proof: "World ID Proof of Human, backend-verified" }),
      auditSeq: logged.auditSeq,
    });
  });

  // A current seat holder issues a single-use invite (24 hours). Demo: the holder's
  // mocked nullifier. Real: a World ID proof under the join action, signal "council-invite:<seat>".
  app.post("/council/invites", auth.require, async (req, res) => {
    const body = (req.body ?? {}) as { mocked?: unknown; byNullifier?: unknown; idkitResult?: Record<string, unknown>; seat?: unknown };
    let by: string;
    if (body.mocked === true) {
      if (!allowMocked) {
        res.status(403).json({ error: realOnly ? mockedDisabledReason("invites") : "Mocked invites are disabled: World ID is configured (or this is mainnet)." });
        return;
      }
      const seat = typeof body.byNullifier === "string" ? store.seats().find((s) => s.source === "mocked" && s.nullifier === body.byNullifier) : undefined;
      if (!seat) {
        res.status(403).json({ error: "Only a current seat holder may invite." });
        return;
      }
      by = seat.seat;
    } else {
      if (!worldOn || !body.idkitResult || typeof body.idkitResult !== "object") {
        res.status(400).json({ error: "World ID is not configured, or no idkitResult was supplied." });
        return;
      }
      const named = store.seats().find((s) => s.seat === body.seat);
      if (!named) {
        res.status(404).json({ error: "No such seat. Give the inviting seat id (seat)." });
        return;
      }
      let verified;
      try {
        verified = await verifyWorldProof(agent.world, body.idkitResult, JOIN_ACTION, options.worldFetch, inviteSignal(named.seat));
      } catch (err) {
        res.status(502).json({ error: `World ID verification is unavailable: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      if (!verified.ok || !verified.nullifier) {
        res.status(403).json({ error: verified.detail });
        return;
      }
      if (!store.seats().some((s) => s.seat === named.seat && s.source === "world" && s.nullifier === verified.nullifier)) {
        res.status(403).json({ error: `Only the holder of ${named.seat} may invite as it.` });
        return;
      }
      // One invite per proof: each RP request carries a fresh server-signed nonce.
      const nonce = body.idkitResult.nonce;
      if (typeof nonce !== "string" || !store.consumeApproval(`invite:${nonce}`)) {
        res.status(409).json({ error: "This World ID proof was already used for an invite. Make a fresh proof." });
        return;
      }
      by = named.seat;
    }
    const inv = store.createInvite(by, clock());
    const logged = await auditNote("COUNCIL", "SEAT_INVITED", `${by} issued invite ${inviteId(inv.code)}, single use, expires ${inv.expiresAt}.`);
    res.status(201).json({ code: inv.code, id: inviteId(inv.code), expiresAt: inv.expiresAt, by, link: `/council.html?invite=${encodeURIComponent(inv.code)}`, ...logged });
  });

  // Public: the council's members, with how many ballots each has cast (the council
  // page links every row to that member's page).
  app.get("/council/seats", (_req, res) => {
    const { items } = allVotes();
    const cast = new Map<string, number>();
    for (const i of items) for (const b of i.vote.ballots) cast.set(b.seat, (cast.get(b.seat) ?? 0) + 1);
    res.json({
      count: store.seats().length,
      epoch: store.epoch(),
      admission: store.seats().length === 0 ? "founder: the first seat joins freely" : "invite: a current seat holder must invite",
      seats: store.seats().map((s) => ({ seat: s.seat, source: s.source, joinedAt: s.joinedAt, ballots: cast.get(s.seat) ?? 0, nullifier: `${s.nullifier.slice(0, 10)}…` })),
    });
  });

  // ---- standing instructions and council votes (docs/mandate-spec.md) ----

  type BallotAuth = { ok: true; seat: string; source: "world" | "mocked"; choice: "yes" | "no" } | { ok: false; status: number; error: string };
  // Who is voting: a mocked seat (demo mode only) or a World ID proof under the
  // join action, bound by its signal to this subject's exact bytes and the choice.
  const authBallot = async (raw: unknown, subject: string, fingerprint: string): Promise<BallotAuth> => {
    const b = (raw ?? {}) as { choice?: unknown; mocked?: unknown; byNullifier?: unknown; idkitResult?: unknown };
    if (b.choice !== "yes" && b.choice !== "no") return { ok: false, status: 400, error: 'choice must be "yes" or "no".' };
    const choice = b.choice;
    if (b.mocked === true) {
      if (!allowMocked) return { ok: false, status: 403, error: realOnly ? mockedDisabledReason("ballots") : "Mocked ballots are disabled: World ID is configured (or this is mainnet)." };
      const seat = typeof b.byNullifier === "string" ? store.seats().find((s) => s.source === "mocked" && s.nullifier === b.byNullifier) : undefined;
      return seat ? { ok: true, seat: seat.seat, source: "mocked", choice } : { ok: false, status: 403, error: "Only a current seat holder may vote." };
    }
    if (!worldOn || !b.idkitResult || typeof b.idkitResult !== "object") {
      return { ok: false, status: 400, error: "World ID is not configured, or no idkitResult was supplied." };
    }
    let verified;
    try {
      verified = await verifyWorldProof(agent.world, b.idkitResult as Record<string, unknown>, JOIN_ACTION, options.worldFetch, voteSignal(subject, fingerprint, choice));
    } catch (err) {
      return { ok: false, status: 502, error: `World ID verification is unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!verified.ok || !verified.nullifier) return { ok: false, status: 403, error: verified.detail };
    const seat = store.seats().find((s) => s.source === "world" && s.nullifier === verified.nullifier);
    return seat ? { ok: true, seat: seat.seat, source: "world", choice } : { ok: false, status: 403, error: "Only a current seat holder may vote." };
  };

  app.get("/mandate", (_req, res) => {
    const now = clock();
    res.json({ active: store.activeMandate(), drafts: store.mandates().reverse(), spentThisMonthTinybars: store.spentThisMonth(now), monthKey: monthKey(now) });
  });

  app.post("/mandate/draft", auth.require, async (req, res) => {
    const raw = (req.body as { text?: unknown } | null)?.text;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      res.status(400).json({ error: "text is required: write the standing instruction in plain words." });
      return;
    }
    if (text.length > MAX_MANDATE_TEXT) {
      res.status(400).json({ error: `text is too long (at most ${MAX_MANDATE_TEXT} characters).` });
      return;
    }
    // Under REAL_ONLY=1 the simulated parser is off: compiling needs a real 0G key.
    const mandateGuard = setupGuard(ZERO_G_KEYS);
    if (mandateGuard) {
      res.status(503).json({ error: "Setup required: compiling a standing instruction needs a 0G API key.", ...mandateGuard });
      return;
    }
    if (store.seats().length === 0) {
      res.status(409).json({ error: "Join the council first: a standing instruction is adopted by a council vote." });
      return;
    }
    const compiled = await compileMandate(text, agent.zeroG, options.zeroGFetch);
    if (!compiled.ok) {
      res.status(422).json({ error: `The rules could not be compiled: ${compiled.error}.`, requestId: compiled.requestId });
      return;
    }
    const seats = store.seats().map((s) => s.seat);
    if (seats.length === 0) {
      res.status(409).json({ error: "Join the council first: a standing instruction is adopted by a council vote." });
      return;
    }
    const draft = store.addMandate({
      text,
      rules: compiled.rules,
      summary: summarize(compiled.rules),
      source: compiled.source,
      requestId: compiled.requestId,
      model: compiled.model,
      rulesHash: rulesHash(compiled.rules),
      textHash: sha256(text),
      createdAt: clock().toISOString(),
      status: "open",
      vote: openTally(seats),
    });
    await auditNote(
      draft.id,
      "MANDATE_PROPOSED",
      `Standing instruction ${draft.id} proposed, compiled by ${draft.source === "0g" ? `0G (request ${draft.requestId ?? "none"})` : "the SIMULATED parser"}. Council vote opened: ${draft.vote.needed} of ${seats.length} needed.`,
      undefined,
      { rulesHash: draft.rulesHash, textHash: draft.textHash, ...(draft.requestId ? { zeroGRequestId: draft.requestId.slice(0, 80) } : {}) },
    );
    res.status(201).json(draft);
  });

  app.post("/mandate/:id/vote", auth.require, async (req, res) => {
    const id = String(req.params.id);
    const before = store.mandate(id);
    if (!before) {
      res.status(404).json({ error: "Unknown standing instruction." });
      return;
    }
    if (before.status !== "open") {
      res.status(409).json({ error: `Standing instruction ${id} is ${before.status}; its vote is closed.` });
      return;
    }
    const who = await authBallot(req.body, id, before.rulesHash);
    if (!who.ok) {
      res.status(who.status).json({ recorded: false, error: who.error });
      return;
    }
    // Re-read after the await: another ballot may have closed the vote meanwhile.
    const m = store.mandate(id)!;
    if (m.status !== "open") {
      res.status(409).json({ recorded: false, error: `Standing instruction ${id} is ${m.status}; its vote is closed.` });
      return;
    }
    const cast = castBallot(m.vote, { seat: who.seat, choice: who.choice, at: clock().toISOString(), source: who.source }, id);
    if (!cast.ok) {
      res.status(cast.status).json({ recorded: false, error: cast.error });
      return;
    }
    const vote = cast.tally;
    let superseded: MandateDraft | null = null;
    if (vote.status === "passed") {
      store.updateMandate({ ...m, vote });
      superseded = store.adoptMandate(id, clock().toISOString())!.superseded;
    } else if (vote.status === "failed") {
      store.updateMandate({ ...m, vote, status: "rejected", closedReason: "The council voted it down." });
    } else store.updateMandate({ ...m, vote });
    await auditNote(id, "VOTE", ballotDetail(who.seat, who.choice, id, vote), undefined, { rulesHash: m.rulesHash });
    if (vote.status === "passed") {
      const logged = await auditNote(
        id,
        "MANDATE_ADOPTED",
        `Standing instruction ${id} adopted by the council (${vote.yes} of ${vote.eligible.length}, ${vote.needed} needed)${superseded ? `, supersedes ${superseded.id}` : ""}. ${m.summary.join(". ")}.`,
        undefined,
        { rulesHash: m.rulesHash, textHash: m.textHash },
      );
      const adopted = store.mandate(id)!;
      store.updateMandate({ ...adopted, adoptedAudit: { auditSeq: logged.auditSeq, auditHash: logged.auditHash, auditTxId: logged.auditTxId } });
    } else if (vote.status === "failed") {
      await auditNote(id, "MANDATE_REJECTED", `Standing instruction ${id} rejected by the council (${vote.no} no of ${vote.eligible.length}).`, undefined, { rulesHash: m.rulesHash });
    }
    res.json({ recorded: true, vote, mandate: store.mandate(id) });
  });

  app.post("/proposals/:id/vote", auth.require, async (req, res) => {
    const id = String(req.params.id);
    const entry = proposals.get(id);
    if (!entry || !entry.lastOutcome) {
      res.status(404).json({ error: "Unknown proposal. Submit it to POST /proposals first." });
      return;
    }
    const waiting = () => entry.lastOutcome?.decision === "PENDING_VOTE" && !entry.busy && store.vote(id)?.vote.status === "open";
    if (!waiting()) {
      res.status(409).json({ error: `Proposal ${id} is not waiting for a council vote (decision: ${entry.lastOutcome.decision}).` });
      return;
    }
    const who = await authBallot(req.body, id, entry.fingerprint);
    if (!who.ok) {
      res.status(who.status).json({ recorded: false, error: who.error });
      return;
    }
    if (!waiting()) {
      res.status(409).json({ recorded: false, error: `Proposal ${id} is not waiting for a council vote (decision: ${entry.lastOutcome.decision}).` });
      return;
    }
    const item = store.vote(id)!;
    const cast = castBallot(item.vote, { seat: who.seat, choice: who.choice, at: clock().toISOString(), source: who.source }, id);
    if (!cast.ok) {
      res.status(cast.status).json({ recorded: false, error: cast.error });
      return;
    }
    const vote = cast.tally;
    store.putVote({ ...item, vote });
    entry.lastOutcome = { ...entry.lastOutcome, vote };
    if (vote.status === "open") {
      await auditNote(id, "VOTE", ballotDetail(who.seat, who.choice, id, vote), entry.proposal);
      res.json({ recorded: true, vote, outcome: entry.lastOutcome });
      return;
    }
    // The vote just closed. Claim the entry before any await, so a second
    // closing ballot or an execute cannot resolve it twice.
    entry.busy = true;
    let settle!: () => void;
    entry.inflight = new Promise<void>((resolve) => (settle = resolve));
    try {
      await auditNote(id, "VOTE", ballotDetail(who.seat, who.choice, id, vote), entry.proposal);
      const outcome = await resolveVote(agent, entry.lastOutcome, vote, { createdEpoch: entry.voteEpoch ?? store.epoch(), currentEpoch: store.epoch() });
      recordIfSigned(outcome);
      entry.proposal = outcome.proposal;
      entry.lastOutcome = outcome;
      entry.pending = outcome.decision === "PENDING_CHALLENGE" && outcome.challengeUntil ? { until: outcome.challengeUntil, epoch: store.epoch(), challenged: false, reason: null } : null;
      store.putVote({ ...store.vote(id)!, vote, decision: outcome.decision });
      res.json({ recorded: true, vote, outcome });
    } finally {
      entry.busy = false;
      entry.inflight = undefined;
      settle();
    }
  });

  app.post("/council/revocations/:id/vote", auth.require, async (req, res) => {
    const id = String(req.params.id);
    const before = store.revocation(id);
    if (!before) {
      res.status(404).json({ error: "Unknown revocation vote." });
      return;
    }
    if (before.status !== "open") {
      res.status(409).json({ error: `The vote on ${id} is closed (${before.status}).` });
      return;
    }
    const who = await authBallot(req.body, id, revocationFingerprint(before));
    if (!who.ok) {
      res.status(who.status).json({ recorded: false, error: who.error });
      return;
    }
    // Re-read after the await: another ballot or a revocation may have closed it.
    const r = store.revocation(id)!;
    if (r.status !== "open" || r.epoch !== store.epoch()) {
      res.status(409).json({ recorded: false, error: `The vote on ${id} is closed (${r.status === "open" ? "the council changed" : r.status}).` });
      return;
    }
    if (who.seat === r.target) {
      res.status(403).json({ recorded: false, error: `${r.target} cannot vote on its own removal.` });
      return;
    }
    const cast = castBallot(r.vote, { seat: who.seat, choice: who.choice, at: clock().toISOString(), source: who.source }, id);
    if (!cast.ok) {
      res.status(cast.status).json({ recorded: false, error: cast.error });
      return;
    }
    const vote = cast.tally;
    // Saved before any await, so a second closing ballot sees a closed vote.
    const status = vote.status === "passed" ? "removed" : vote.status === "failed" ? "kept" : "open";
    store.putRevocation({ ...r, vote, status, ...(status === "open" ? {} : { closedAt: clock().toISOString() }) });
    await auditNote(id, "VOTE", ballotDetail(who.seat, who.choice, id, vote));
    if (vote.status === "open") {
      res.json({ recorded: true, vote, removed: false });
      return;
    }
    if (vote.status === "failed") {
      await auditNote(id, "REVOCATION_REJECTED", `Council vote ${id} on removing ${r.target} failed (${vote.yes} yes, ${vote.no} no of ${vote.eligible.length}). ${r.target} keeps its seat.`);
      res.json({ recorded: true, vote, removed: false });
      return;
    }
    const revocation = await applyRevocation(r.target, { subject: id, vote });
    res.json({ recorded: true, vote, removed: true, revocation });
  });

  app.get("/council/votes", (_req, res) => {
    const { items, isOpen } = allVotes();
    res.json({ open: items.filter(isOpen), closed: items.filter((i) => !isOpen(i)) });
  });

  // Public: a council's votes are public. Nullifiers are not shown.
  app.get("/council/members/:seat", (req, res) => {
    const seat = store.seats().find((s) => s.seat === String(req.params.seat));
    if (!seat) {
      res.status(404).json({ error: "No such seat." });
      return;
    }
    const { items, isOpen } = allVotes();
    res.json({
      seat: seat.seat,
      source: seat.source,
      joinedAt: seat.joinedAt,
      ballots: items.flatMap((i) => i.vote.ballots.filter((b) => b.seat === seat.seat).map((b) => ({ subject: i.subject, kind: i.kind, choice: b.choice, at: b.at }))),
      awaiting: items.filter((i) => isOpen(i) && i.vote.eligible.includes(seat.seat) && !i.vote.ballots.some((b) => b.seat === seat.seat)),
      // Invite codes are bearer secrets: only their public id is shown.
      invites: store
        .invites()
        .filter((i) => i.by === seat.seat)
        .reverse()
        .map((i) => ({ id: inviteId(i.code), createdAt: i.createdAt, expiresAt: i.expiresAt, status: i.usedAt ? "used" : Date.parse(i.expiresAt) <= clock().getTime() ? "expired" : "open", usedBy: i.usedBy ?? null })),
      removals: items.filter((i) => i.kind === "revocation" && (i.target === seat.seat || i.openedBy === seat.seat)),
    });
  });

  app.get("/world/qr.svg", async (req, res) => {
    const data = typeof req.query.data === "string" ? req.query.data : "";
    if (!data || data.length > 2048) {
      res.status(400).send("data is required");
      return;
    }
    res.type("image/svg+xml").send(await QRCode.toString(data, { type: "svg", margin: 1 }));
  });

  app.get("/vendor/idkit.js", (_req, res) => {
    res.sendFile(join(ROOT, "node_modules", "@worldcoin", "idkit-core", "dist", "idkit.global.js"));
  });
  app.use(express.static(join(ROOT, "public")));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (res.headersSent) return;
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: status === 500 ? "Internal error" : String((err as Error).message) });
  });

  // ---- demo-data seed (PR #12) ----
  // Live demo instances start empty: the Report shows "NO PROPOSAL RECORD IS
  // AVAILABLE" and Atlas says "No logged proposals". The seed runs the real
  // code paths (processProposal, compileMandate, castBallot, resolveVote,
  // auditEntry) once at server startup in demo mode, so every fresh
  // serverless instance starts with the judged story: a World ID-approved
  // large payment, an adopted standing instruction, a payment inside it, a
  // refused mismatch, and a payment outside it that the council votes
  // through. The World ID payment (P-104) runs BEFORE the mandate is
  // adopted: once M-1 is active a large payment inside it skips the World
  // ID gate entirely, and one outside it goes to a vote instead.
  // Gates: demo mode only (agent.runMode === "demo") and never under
  // REAL_ONLY=1. createApp only attaches this function; it never calls it.
  const seedDemoState: SeedDemoStateFn = async () => {
    if (agent.runMode !== "demo" || realOnly) {
      return { seeded: false, reason: agent.runMode !== "demo" ? `not demo mode (runMode: ${agent.runMode})` : "REAL_ONLY=1" };
    }
    if (store.seats().length > 0 || store.mandates().length > 0) {
      return { seeded: false, reason: "already seeded" };
    }
    const seedProposal = (id: string, payee: string, amountTinybars: number, purpose: string, transfer?: { payee: string; amountTinybars: number }): Proposal => ({
      id,
      description: { payee, amountTinybars, token: "HBAR", purpose },
      transfer: { payee: transfer?.payee ?? payee, amountTinybars: transfer?.amountTinybars ?? amountTinybars, token: "HBAR" },
      createdAt: clock().toISOString(),
    });
    const registerProposal = (proposal: Proposal, outcome: CouncilOutcome): RegisteredProposal => {
      const entry: RegisteredProposal = { proposal: outcome.proposal, fingerprint: proposalFingerprint(proposal), lastOutcome: outcome, pending: null };
      proposals.set(proposal.id, entry);
      return entry;
    };
    // Mirror of POST /proposals when a mandate is active: decide inside
    // serialized() (monthly-spend reads run one at a time) and record spend.
    const decideInside = async (proposal: Proposal) =>
      serialized(async () => {
        const o = await processProposal(agent, proposal, null, mandateCtx());
        recordIfSigned(o);
        return o;
      });

    // 2. Seats: same as demo.ts scene 9.
    const seats = ["asha", "bilal", "chen"].map((n) => store.addSeat(`mock:demo-${n}`, "mocked")!);
    const seatIds = seats.map((s) => s.seat);

    // 3. P-104, large payment with a World ID approval, SIGNED. No mandate
    // active yet, so the gate applies and the mocked approval carries it.
    const p104 = seedProposal("P-104", "0.0.1001", 80_000_000, "Pay the main sponsor grant");
    const o104 = await processProposal(agent, p104, mockedWorldCheck("P-104", "approved"), null);
    if (o104.decision !== "SIGNED" || !o104.usedWorldApproval) {
      throw new Error(`Demo seed failed at P-104: expected SIGNED with a World ID approval, got ${o104.decision} (${o104.reason})`);
    }
    recordIfSigned(o104);
    registerProposal(p104, o104);

    // 4. Mandate M-1: forced-simulated compile, adoption by 2 of 3 seats.
    const mandateText = "Pay 0.0.1001 or 0.0.1002 up to 50 HBAR each, at most 100 HBAR a month. Anything else goes to the council.";
    const compiled = await compileMandate(mandateText, { ...agent.zeroG, apiKey: "" });
    if (!compiled.ok) throw new Error(`Demo seed failed at M-1: mandate did not compile: ${compiled.error}`);
    const draft = store.addMandate({
      text: mandateText,
      rules: compiled.rules,
      summary: summarize(compiled.rules),
      source: compiled.source,
      requestId: compiled.requestId,
      model: compiled.model,
      rulesHash: rulesHash(compiled.rules),
      textHash: sha256(mandateText),
      createdAt: clock().toISOString(),
      status: "open",
      vote: openTally(seatIds),
    });
    await auditNote(
      draft.id,
      "MANDATE_PROPOSED",
      `Standing instruction ${draft.id} proposed, compiled by ${draft.source === "0g" ? `0G (request ${draft.requestId ?? "none"})` : "the SIMULATED parser"}. Council vote opened: ${draft.vote.needed} of ${seatIds.length} needed.`,
      undefined,
      { rulesHash: draft.rulesHash, textHash: draft.textHash, ...(draft.requestId ? { zeroGRequestId: draft.requestId.slice(0, 80) } : {}) },
    );
    // Mirror of POST /mandate/:id/vote.
    for (const seat of seatIds.slice(0, 2)) {
      const m = store.mandate(draft.id)!;
      const cast = castBallot(m.vote, { seat, choice: "yes", at: clock().toISOString(), source: "mocked" }, draft.id);
      if (!cast.ok) throw new Error(`Demo seed failed at ${draft.id}: ballot refused: ${cast.error}`);
      const vote = cast.tally;
      let superseded: MandateDraft | null = null;
      if (vote.status === "passed") {
        store.updateMandate({ ...m, vote });
        superseded = store.adoptMandate(draft.id, clock().toISOString())!.superseded;
      } else if (vote.status === "failed") {
        store.updateMandate({ ...m, vote, status: "rejected", closedReason: "The council voted it down." });
      } else store.updateMandate({ ...m, vote });
      await auditNote(draft.id, "VOTE", ballotDetail(seat, "yes", draft.id, vote), undefined, { rulesHash: m.rulesHash });
      if (vote.status === "passed") {
        const logged = await auditNote(
          draft.id,
          "MANDATE_ADOPTED",
          `Standing instruction ${draft.id} adopted by the council (${vote.yes} of ${vote.eligible.length}, ${vote.needed} needed)${superseded ? `, supersedes ${superseded.id}` : ""}. ${m.summary.join(". ")}.`,
          undefined,
          { rulesHash: m.rulesHash, textHash: m.textHash },
        );
        const adopted = store.mandate(draft.id)!;
        store.updateMandate({ ...adopted, adoptedAudit: { auditSeq: logged.auditSeq, auditHash: logged.auditHash, auditTxId: logged.auditTxId } });
      } else if (vote.status === "failed") {
        await auditNote(draft.id, "MANDATE_REJECTED", `Standing instruction ${draft.id} rejected by the council (${vote.no} no of ${vote.eligible.length}).`, undefined, { rulesHash: m.rulesHash });
      }
    }
    const adopted = store.mandate(draft.id)!;
    if (adopted.status !== "adopted" || !adopted.rulesHash) throw new Error(`Demo seed failed at M-1: expected an adopted mandate, got status ${adopted.status}`);

    // 5. P-101, inside the rules, SIGNED: no vote, no World ID check.
    // Spend so far: 0.8 + 50 = 50.8 HBAR this month, under the 100 HBAR cap.
    const p101 = seedProposal("P-101", "0.0.1001", 5_000_000_000, "Pay the venue balance");
    const o101 = await decideInside(p101);
    recordIfSigned(o101);
    if (o101.decision !== "SIGNED" || o101.mandate?.within !== true || o101.usedWorldApproval) {
      throw new Error(`Demo seed failed at P-101: expected SIGNED inside the mandate with no World ID check, got ${o101.decision} (within: ${o101.mandate?.within}, usedWorldApproval: ${o101.usedWorldApproval})`);
    }
    registerProposal(p101, o101);

    // 6. P-102, mismatch, REFUSED: description and transfer disagree.
    const p102 = seedProposal("P-102", "0.0.1002", 2_000_000_000, "Pay the caterer", { payee: "0.0.9999", amountTinybars: 9_000_000_000 });
    const o102 = await decideInside(p102);
    recordIfSigned(o102);
    if (o102.decision !== "REFUSED" || o102.checkMatches !== false || !o102.paidTxId) {
      throw new Error(`Demo seed failed at P-102: expected REFUSED with checkMatches false and a paid check, got ${o102.decision} (matches: ${o102.checkMatches}, paidTxId: ${o102.paidTxId ?? "none"})`);
    }
    registerProposal(p102, o102);

    // 7. P-103, outside the rules (0.0.1003 is not an allowed payee), council
    // vote then SIGNED with no second check fee.
    const p103 = seedProposal("P-103", "0.0.1003", 3_000_000_000, "Pay the new AV vendor");
    const o103 = await decideInside(p103);
    recordIfSigned(o103);
    if (o103.decision !== "PENDING_VOTE" || !o103.vote) {
      throw new Error(`Demo seed failed at P-103: expected PENDING_VOTE, got ${o103.decision} (${o103.reason})`);
    }
    const entry103 = registerProposal(p103, o103);
    entry103.voteEpoch = store.epoch();
    store.putVote({
      subject: p103.id,
      kind: "proposal",
      title: p103.description.purpose,
      amountTinybars: p103.transfer.amountTinybars,
      payee: p103.transfer.payee,
      violations: o103.mandate?.violations ?? [],
      vote: o103.vote,
      decision: "PENDING_VOTE",
      openedAt: clock().toISOString(),
    });
    // Mirror of POST /proposals/:id/vote (closing flow).
    let o103final = o103;
    for (const seat of seatIds.slice(0, 2)) {
      const item = store.vote("P-103")!;
      const cast = castBallot(item.vote, { seat, choice: "yes", at: clock().toISOString(), source: "mocked" }, "P-103");
      if (!cast.ok) throw new Error(`Demo seed failed at P-103: ballot refused: ${cast.error}`);
      const vote = cast.tally;
      store.putVote({ ...item, vote });
      entry103.lastOutcome = { ...entry103.lastOutcome!, vote };
      await auditNote("P-103", "VOTE", ballotDetail(seat, "yes", "P-103", vote), entry103.proposal);
      if (vote.status === "open") continue;
      const resolved = await resolveVote(agent, entry103.lastOutcome!, vote, { createdEpoch: entry103.voteEpoch ?? store.epoch(), currentEpoch: store.epoch() });
      recordIfSigned(resolved);
      entry103.proposal = resolved.proposal;
      entry103.lastOutcome = resolved;
      entry103.pending = null;
      store.putVote({ ...store.vote("P-103")!, vote, decision: resolved.decision });
      o103final = resolved;
    }
    if (o103final.decision !== "SIGNED") throw new Error(`Demo seed failed at P-103: expected SIGNED after the vote, got ${o103final.decision} (${o103final.reason})`);
    if (o103final.paidTxId !== o103.paidTxId) throw new Error("Demo seed failed at P-103: vote resolution paid a second check fee");

    return {
      seeded: true,
      mandate: draft.id,
      seats: seats.length,
      proposals: [
        { id: "P-104", decision: o104.decision },
        { id: "P-101", decision: o101.decision },
        { id: "P-102", decision: o102.decision },
        { id: "P-103", decision: o103final.decision },
      ],
    };
  };
  const seededApp = app as SeededApp;
  seededApp.seedDemoState = seedDemoState;

  return seededApp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const app = await createApp({ port });
  // Demo mode only: seed the judged story at startup, so a fresh instance
  // never starts empty. The seed itself gates on demo mode and REAL_ONLY=1.
  if ((process.env.DEMO_MODE ?? "").trim() === "1") {
    const seed = await app.seedDemoState();
    console.log(seed.seeded ? `demo seed: ${seed.proposals?.length ?? 0} proposals, mandate ${seed.mandate}, ${seed.seats} seats` : `demo seed skipped (${seed.reason})`);
  }
  app.listen(port, () => {
    console.log(`hedera-council-agent listening on :${port}`);
  });
}
