// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Real-mode preflight: checks every external dependency before a demo
// recording and performs the one-time Hedera setup.
//   npm run preflight                         -> check only
//   npm run preflight -- --setup              -> also associate testnet USDC
//                                                and create the HCS topic
//   npm run preflight -- --create-fee-account -> also create the x402 fee account
//   npm run preflight -- --create-council     -> also create the council: a member
//                                                account and a 2-of-2 treasury, saved to .data/council.json
// Prints what to put in .env. Never prints private keys.
import { atomicToUsd } from "./budget.js";
import { loadCouncilSetup, saveCouncilSetup } from "./chain.js";
import { buildAgent } from "./server.js";
import { isWorldConfigured, rpContextFor } from "./world.js";
import { X402_FACILITATOR_URL, X402_TESTNET_USDC } from "./x402.js";
import { zeroGVerdict } from "./zeroG.js";

const args = new Set(process.argv.slice(2));
const setup = args.has("--setup");
const createFee = args.has("--create-fee-account");
const createCouncil = args.has("--create-council");
let failures = 0;
const ok = (m: string) => console.log(`  OK    ${m}`);
const warn = (m: string) => console.log(`  TODO  ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const agent = buildAgent(process.env);
const h = agent.hedera;
const usdc = X402_TESTNET_USDC;

console.log("\nHedera");
if (!h.isReal()) {
  warn("HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY not set: SIMULATED mode. Create an ECDSA testnet account at portal.hedera.com.");
} else if (h.config.network !== "testnet") {
  fail(`HEDERA_NETWORK is ${h.config.network}; this preflight only sets up testnet.`);
} else {
  try {
    const b = await h.balances();
    ok(`agent ${h.config.accountId}: ${b.hbar} HBAR, USDC ${b.tokens[usdc] ?? "not associated"}`);
    if (b.tokens[usdc] === undefined) {
      if (setup) {
        await h.associateToken(usdc);
        ok(`associated ${h.config.accountId} with testnet USDC ${usdc}. Now get USDC at faucet.circle.com (Hedera Testnet).`);
      } else warn(`associate testnet USDC ${usdc}: rerun with --setup`);
    } else if (Number(b.tokens[usdc]) < agent.priceAtomic) {
      warn(`agent holds less than one check fee (${atomicToUsd(agent.priceAtomic)}). Get testnet USDC at faucet.circle.com.`);
    }
    if (agent.payTo === h.config.accountId) {
      if (createFee) {
        const fee = await h.createFeeAccount();
        ok(`created x402 fee account ${fee} (same key, auto token association). Set X402_PAY_TO=${fee}`);
      } else warn("X402_PAY_TO is the agent itself. Rerun with --create-fee-account, then set X402_PAY_TO.");
    } else {
      const fb = await h.balances(agent.payTo);
      ok(`x402 fee account ${agent.payTo}: ${fb.hbar} HBAR, USDC ${fb.tokens[usdc] ?? "not associated (auto-association needed)"}`);
    }
    let council = loadCouncilSetup(process.env);
    if (!council && createCouncil) {
      const made = await h.createCouncil();
      saveCouncilSetup(made);
      council = made;
      ok(`created council: member ${made.memberAccountId}, 2-of-2 treasury ${made.treasuryAccountId}. Saved to .data/council.json (member key inside, keep it private).`);
    }
    const treasury = (process.env.HEDERA_TREASURY_ACCOUNT_ID ?? "").trim() || council?.treasuryAccountId || "";
    if (council && treasury) {
      const tb = await h.balances(treasury);
      ok(`treasury ${treasury} (2-of-2 with member ${council.memberAccountId}): ${tb.hbar} HBAR`);
    } else {
      warn("no council: proposals must name a scheduleId created by a council member. Rerun with --create-council for the full demo.");
    }
    if (h.config.topicId) ok(`HCS audit topic ${h.config.topicId}`);
    else if (setup) {
      const topic = await h.createTopic();
      ok(`created HCS audit topic ${topic}. Set HEDERA_TOPIC_ID=${topic}`);
    } else warn("HEDERA_TOPIC_ID not set: one is created on first audit, or rerun with --setup");
  } catch (e) {
    fail(`Hedera: ${errMsg(e)}`);
  } finally {
    h.close();
  }
}

console.log("\nx402 facilitator");
try {
  const url = (process.env.X402_FACILITATOR_URL ?? "").trim() || X402_FACILITATOR_URL;
  const r = await fetch(`${url.replace(/\/$/, "")}/supported`, { signal: AbortSignal.timeout(10_000) });
  const body = (await r.json()) as { kinds?: Array<{ scheme: string; network: string }> };
  const hedera = body.kinds?.some((k) => k.scheme === "exact" && k.network === agent.x402Network);
  if (hedera) ok(`${url} supports exact on ${agent.x402Network}`);
  else fail(`${url} does not list exact on ${agent.x402Network}`);
} catch (e) {
  fail(`facilitator: ${errMsg(e)}`);
}

console.log("\n0G Private Computer");
if (!agent.zeroG.apiKey) warn("ZERO_G_API_KEY not set: verdicts are labelled SIMULATED. Get a key at pc.0g.ai.");
else {
  const v = await zeroGVerdict(agent.zeroG, { proposalId: "PREFLIGHT", checkVerdict: "Preflight check, the transfer matches.", matches: true, amountTinybars: 1, payee: "0.0.1" });
  if (v.source === "0g") ok(`model ${v.model}, request id ${v.requestId ?? "MISSING"}`);
  else fail(v.text.slice(0, 200));
}

console.log("\nWorld ID");
if (!isWorldConfigured(agent.world)) {
  warn("WORLD_RP_ID / WORLD_APP_ID / WORLD_SIGNING_KEY not all set: approvals are MOCKED (testnet only).");
} else {
  try {
    rpContextFor(agent.world, "join-council");
    ok(`rp ${agent.world.rpId}, app ${agent.world.appId}, environment ${agent.world.environment}, signing key valid`);
  } catch (e) {
    fail(`WORLD_SIGNING_KEY cannot sign requests: ${errMsg(e)}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nNo failures. TODO lines are optional or need a manual step.");
process.exitCode = failures ? 1 : 0;
