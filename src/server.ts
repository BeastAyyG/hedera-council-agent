// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Express server. Endpoints:
//   GET  /health                     -> mode, network, prices
//   POST /check                      -> x402-protected proposal check.
//     Real mode: @x402/express paymentMiddleware, Official facilitator
//     https://x402.org/facilitator, network hedera:testnet, price $0.01
//     in testnet USDC 0.0.429274. No payment -> 402. Paid -> handler
//     returns the check result, middleware settles via the facilitator.
//     Simulated mode: same route, plain 402 shape from src/x402.ts.
//   POST /proposals                  -> full council flow for a proposal
//     (pay, 0G verdict, mismatch check, World ID gate, sign/refuse)
//   POST /world/verify               -> backend World ID v4 verification
//     for one exact action, e.g. council-sign:P-003. Never trusts the
//     client payload; calls developer.world.org/api/v4/verify/{rp_id}.
//   POST /council/join               -> IDKit Proof of Human council join.
//     Real mode verifies the proof on the server and records the
//     nullifier once (one person, one seat). Demo mode accepts an
//     explicitly mocked proof and labels it MOCKED.
import express, { type Express } from "express";
import { SpendingCap } from "./budget.js";
import { processProposal } from "./council.js";
import { checkProposal } from "./checker.js";
import { HederaClient, loadHederaConfig } from "./hedera.js";
import { loadZeroGConfig } from "./zeroG.js";
import { loadWorldConfig, mockedWorldCheck, verifyWorldProof, worldGate } from "./world.js";
import { acceptsForCheck, paymentRequiredResponse, X402_FACILITATOR_URL } from "./x402.js";
import type { Proposal } from "./proposal.js";
import type { WorldCheck } from "./world.js";

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function buildAgent() {
  const { config, mode } = loadHederaConfig(process.env);
  const hedera = new HederaClient(config, mode);
  return {
    hedera,
    budget: new SpendingCap(envInt("AGENT_SPEND_CAP_TINYBARS", 1_000_000)),
    zeroG: loadZeroGConfig(process.env),
    world: loadWorldConfig(process.env),
    largeThresholdTinybars: envInt("LARGE_PROPOSAL_TINYBARS", 50_000_000),
    checkPriceTinybars: config.checkPriceTinybars,
    payTo: config.accountId || "0.0.0",
    mode,
  };
}

export async function createApp(): Promise<Express> {
  const agent = buildAgent();
  const app = express();
  app.use(express.json());

  // Real x402 protection for POST /check, when a payee account is set.
  // The resource server must initialize() first: it fetches the
  // facilitator's supported kinds, otherwise every request fails with
  // "Facilitator does not support exact on hedera:testnet". If the
  // facilitator is unreachable at boot, fall back to the plain 402
  // shape and log it honestly.
  let x402Applied = false;
  if (agent.hedera.config.accountId) {
    try {
      const { HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server");
      const { paymentMiddleware } = await import("@x402/express");
      const { ExactHederaScheme } = await import("@x402/hedera/exact/server");
      const network = agent.hedera.config.network === "mainnet" ? "hedera:mainnet" : "hedera:testnet";
      const resourceServer = new x402ResourceServer(
        new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL }),
      ).register(network, new ExactHederaScheme());
      await resourceServer.initialize();
      app.use(
        paymentMiddleware(
          {
            "POST /check": {
              accepts: [{ scheme: "exact", price: "$0.01", network, payTo: agent.payTo }],
              description: "Paid proposal check: one check of one treasury proposal",
            },
          },
          resourceServer,
        ),
      );
      x402Applied = true;
    } catch (err) {
      console.warn("x402 middleware unavailable, falling back to plain 402:", err instanceof Error ? err.message : err);
    }
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      mode: agent.mode,
      network: agent.hedera.config.network,
      x402: x402Applied ? "real (@x402/express, Official facilitator, $0.01 testnet USDC)" : "simulated (plain 402 shape)",
      checkPriceTinybars: agent.checkPriceTinybars,
      spendCapRemainingTinybars: agent.budget.remainingTinybars,
      worldConfigured: Boolean(agent.world.rpId),
      note:
        agent.mode === "simulated"
          ? "SIMULATED mode: no Hedera credentials set. Chain ids are SIM- ids, not real."
          : "REAL mode: Hedera testnet credentials set.",
    });
  });

  app.post("/check", async (req, res) => {
    const proposal = req.body as Proposal;
    if (!x402Applied) {
      // Simulated / fallback path: plain 402, verify a SIM- payment id.
      const payment = req.headers["x-payment"];
      if (!payment || typeof payment !== "string") {
        const r = paymentRequiredResponse(
          acceptsForCheck({ network: agent.hedera.config.network, payTo: agent.payTo, priceTinybars: agent.checkPriceTinybars }),
        );
        res.status(r.status).json(r.body);
        return;
      }
      const ok = await agent.hedera.verifyPayment(payment);
      if (!ok) {
        res.status(402).json({ error: "Payment did not verify as settled on Hedera.", x402Version: 1 });
        return;
      }
      res.json({ ...checkProposal(proposal), paidWith: payment, mode: agent.mode });
      return;
    }
    // Real x402 mode: the middleware already verified and settled the
    // payment before this handler ran.
    res.json({ ...checkProposal(proposal), mode: agent.mode, x402: "settled via Official facilitator" });
  });

  app.post("/proposals", async (req, res) => {
    const body = req.body as { proposal: Proposal; worldCheck?: WorldCheck | null };
    const outcome = await processProposal(agent, body.proposal, body.worldCheck ?? null);
    res.json(outcome);
  });

  app.post("/world/verify", async (req, res) => {
    const body = req.body as { proposalId: string; proof?: Record<string, unknown>; mocked?: boolean };
    if (!body.proposalId) {
      res.status(400).json({ error: "proposalId is required" });
      return;
    }
    if (body.mocked === true) {
      res.json({
        check: mockedWorldCheck(body.proposalId, "approved"),
        note: "MOCKED proof, demo only. Not a real World ID verification.",
      });
      return;
    }
    if (!agent.world.rpId || !body.proof) {
      res.status(400).json({ error: "World RP ID is not configured, or no proof was supplied. Use mocked:true for the demo path." });
      return;
    }
    try {
      const check = await verifyWorldProof(agent.world, body.proof, `council-sign:${body.proposalId}`);
      res.json({ check, gate: worldGate(check, body.proposalId) });
    } catch (err) {
      res.status(502).json({ error: `World verification failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post("/council/join", async (req, res) => {
    const body = req.body as { nullifier?: string; proof?: Record<string, unknown>; mocked?: boolean };
    if (!body.nullifier) {
      res.status(400).json({ error: "nullifier is required (IDKit proof nullifier)." });
      return;
    }
    if (body.mocked === true || !agent.world.rpId) {
      const gate = worldGate(mockedWorldCheck("council-join", "approved"), "council-join");
      res.json({
        joined: gate.allowed,
        seat: `council-seat:${body.nullifier.slice(0, 12)}`,
        proof: "MOCKED Proof of Human (demo only)",
        note: "IDKit verification must run on the server in production; mocked proofs are demo only.",
      });
      return;
    }
    if (!body.proof) {
      res.status(400).json({ error: "proof is required for a real IDKit join" });
      return;
    }
    try {
      const check = await verifyWorldProof(agent.world, body.proof, "join-council");
      const gate = worldGate(check, "join-council");
      res.json({
        joined: gate.allowed,
        seat: gate.allowed ? `council-seat:${body.nullifier.slice(0, 12)}` : null,
        proof: "World ID Proof of Human, backend-verified",
        gate: gate.reason,
      });
    } catch (err) {
      res.status(502).json({ error: `World verification failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const app = await createApp();
  app.listen(port, () => {
    console.log(`hedera-council-agent listening on :${port}`);
  });
}
