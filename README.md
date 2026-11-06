# hedera-council-agent

An AI agent holds one signing seat on a Hedera treasury council.

A proposal is a transfer: a description (payee, amount, purpose) plus the
exact on-chain transfer it will execute. The agent pays for a check of
each proposal, signs routine ones itself, and refuses any proposal whose
actual transfer does not match its description. Before signing a large
proposal, its owner must pass a fresh World ID check tied to that exact
proposal. If the check is denied or expires, the agent does not sign.

Proposals are Hedera Scheduled Transactions plus HCS, with no smart
contracts. The exact transfer is fixed when the proposal is created, and
council signatures approve it.

Written fresh for ETHGlobal Mumbai 2026, Nov 5-7. Deadline: Saturday
Nov 7, 09:00 IST. No code, designs, or assets from any earlier project
are in this repo. The ideas come from an earlier DAO governance project,
the code here is new.

## Architecture

```
proposal (description vs exact transfer)
  -> x402 paid check (402, pay, verify settlement)
  -> 0G Private Computer writes the plain-language verdict (request id logged)
  -> deterministic mismatch checker (exact payee / amount / token, no LLM in the decision path)
  -> large proposal? World ID Agent Pass gate (fresh check, this exact proposal)
  -> sign: Hedera Scheduled Transaction for the exact transfer
  -> audit: every decision logged to an HCS topic
```

- `src/proposal.ts` - proposal and transfer model
- `src/checker.ts` - deterministic mismatch checker
- `src/budget.ts` - spending cap for check payments
- `src/x402.ts` - 402 response, self-run x402 facilitator shape
- `src/hedera.ts` - Hedera client, env-gated real / simulated
- `src/zeroG.ts` - 0G Private Computer client (OpenAI-compatible)
- `src/world.ts` - World ID gate, denied / expired / wrong-proposal paths
- `src/council.ts` - orchestration: pay, verdict, check, gate, sign or refuse
- `src/server.ts` - HTTP server: `/health`, `/check`, `/proposals`, `/council/join`
- `src/demo.ts` - demo rehearsal, 4 scenes

## Setup

```bash
npm install
cp .env.example .env   # fill in the real values below, never commit .env
npm test               # build + 10 unit tests
npm run demo           # demo rehearsal, 4 scenes
npm start              # HTTP server on :3000 (PORT to change)
```

## Env vars

| Var | What it is |
| --- | --- |
| `HEDERA_NETWORK` | `testnet` (default) or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Hedera testnet account id, e.g. `0.0.123456`, from portal.hedera.com |
| `HEDERA_PRIVATE_KEY` | Private key for that account, ECDSA |
| `HEDERA_TOPIC_ID` | HCS topic id for the audit log, optional |
| `X402_CHECK_PRICE_TINYBARS` | Price of one proposal check, default `100000` (0.001 HBAR) |
| `AGENT_SPEND_CAP_TINYBARS` | Agent spending cap per run, default `1000000` |
| `LARGE_PROPOSAL_TINYBARS` | Large threshold, World ID required at or above, default `50000000` (0.5 HBAR) |
| `ZERO_G_API_KEY` | 0G Private Computer API key, `sk-` key from pc.0g.ai |
| `ZERO_G_BASE_URL` | Default `https://router-api.0g.ai/v1` |
| `ZERO_G_MODEL` | Default `0gm-1.0-35b-a3b` (verified slug; `0gm-1.0` on the prize page is shorthand) |
| `WORLD_RP_ID` | World ID RP id (`rp_...`), server only, from developer.world.org |
| `WORLD_APP_ID` | World ID app id (`app_...`), public |
| `WORLD_SIGNING_KEY` | World signing key, server only, never expose to the client |
| `X402_FACILITATOR_URL` | Default `https://x402.org/facilitator` (Official) |

How to get Hedera testnet credentials: register at portal.hedera.com,
choose Testnet, create an account. It gives an account ID, a private key,
and 1,000 test HBAR. Put the account ID and private key in `.env`.
This cannot be done without a browser login; there is no verified
portal API or CLI for account creation. Create ECDSA accounts for x402.

Hedera SDK: the current package is `@hiero-ledger/sdk` (2.90.1
installed); `@hashgraph/sdk` is the legacy name. Do not install both.

Real x402: `POST /check` is protected by `@x402/express`
paymentMiddleware, Official facilitator, network `hedera:testnet`,
price $0.01 in testnet USDC `0.0.429274` (amount `10000`, 6 decimals,
fee payer `0.0.9185802`). The resource server must `initialize()`
first to fetch the facilitator's supported kinds, otherwise every
request fails. Verified live 2026-11-06: an unpaid `POST /check`
returns HTTP 402 with a `PAYMENT-REQUIRED` header carrying those
accepts. A paid request is verified and settled by the facilitator. The paying account must be
associated with that token; testnet USDC comes from faucet.circle.com
(Hedera Testnet). `src/x402Client.ts` is the agent-side x402 client
(`@x402/fetch` + `@x402/hedera` Exact scheme). The internal council
check fee is still paid in HBAR via the Hedera SDK, under the spending
cap, and logged to HCS.

How to get 0G credits: ask at the 0G booth / 0G docs at the event. Every
team gets 0G compute credits to build with. A key is created at pc.0g.ai
after a wallet login, Dashboard, API Keys. The auditable request id is
`x_0g_trace.request_id` in the response body, and it is stored and
printed per check.

## Real vs simulated

Without `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY`, the app runs in
SIMULATED mode: the full logic runs, but chain ids are `SIM-PAY-…`,
`SIM-SCHED-…`, `SIM-HCS-…` and output says SIMULATED. Without
`ZERO_G_API_KEY`, 0G verdicts are labelled `[SIMULATED 0G verdict]`.
World ID proofs in the demo are labelled MOCKED, because World is
mocking proofs for this event and no sandbox app is needed.

With the env vars set, the same code paths use the real Hedera SDK
(Scheduled Transactions, HCS, transfer payments, receipt verification),
the real 0G API, and backend World ID validation. No fake transaction
id is ever presented as real.

Current status at build time: SIMULATED. No real Hedera payment has
settled yet, because no testnet credentials were available on this
machine. See "Hedera transaction IDs" below.

## Demo rehearsal

`npm run demo` runs 4 scenes:

1. Routine proposal, paid check, agent signs.
2. Mismatched proposal (payee and amount differ), paid check, agent refuses.
3. Large proposal, World ID approved, agent signs.
4. Large proposal, World ID denied, agent does not sign.

Each scene prints its decision, the check payment id, the 0G verdict
and request id, the World ID gate result, the Scheduled Transaction id,
and the HCS audit id. In real mode the payment line also prints a
HashScan link.

Demo video: 2-3 minutes. ETHGlobal requires 2-4 minutes, 0G wants under
3 minutes. Show scene 1, then scene 2 (the refusal), then scene 3 and 4
(the World ID gate), in that order.

## Track-by-track submission notes

1. **Hedera, AI Agents That Pay: x402 on Hedera, $6,500.**
   Proves it: `POST /check` returns HTTP 402 with price and payTo
   (`src/x402.ts`, `src/server.ts`). The agent pays on Hedera testnet
   with no human approving (`src/council.ts`, `src/hedera.ts` `pay()`),
   under a spending cap (`src/budget.ts`), and each payment is logged
   to an HCS topic (`audit()`). Demo scene 1 shows a paid check and a
   sign; the README section below holds the real transaction ID and
   HashScan link once a real payment settles.
2. **Hedera, "No Solidity Allowed": Build with Hedera SDKs, $2,000.**
   Proves it: Hedera JS/TS SDK (`@hiero-ledger/sdk`), no Solidity anywhere
   in this repo. Uses HTS transfers, HCS topics, and Scheduled
   Transactions, three native services (`src/hedera.ts`).
3. **World, World ID Agent Pass, $5,000.**
   Proves it: before signing a large proposal, the owner must pass a
   fresh World ID check tied to that exact proposal id
   (`src/world.ts` `worldGate()`, `src/council.ts` step 4). Demo scene 3
   is the approved path, scene 4 is the denied path where the agent
   does not sign. Backend validation is `POST
   https://developer.world.org/api/v4/verify/{rp_id}`
   (`src/world.ts` `verifyWorldProof()`, `POST /world/verify`), checking
   success, action (`council-sign:<proposalId>`), environment, and
   `results[0].success`; an unvalidated client response is never
   treated as authorization. There is no standalone Agent Pass SDK;
   the official flow is World ID human-in-the-loop / IDKit 4.x.
   Integration debrief: see `docs/world-debrief.md` (to be filled after
   the first real integration attempt).
4. **World, Best Use of IDKit, $2,500, if time allows.**
   Proves it: `POST /council/join` (`src/server.ts`). Proof of Human to
   join the council, one person gets one seat, keyed by the IDKit proof
   nullifier. Demo path is labelled MOCKED; real IDKit server
   verification is the remaining step.
5. **0G, Build with 0G Private Computer, $5,000.**
   Proves it: 0G writes the check's plain-language verdict in the main
   flow (`src/zeroG.ts`), and the request id is printed per check
   (`src/demo.ts`, `src/council.ts`). The verdict is load-bearing: it
   is the human-readable record of the check that the sign/refuse
   decision is logged alongside. If 0G is removed, there is no verdict
   and no plain-language explanation of any check. Not a chat wrapper:
   the AI call is the check's verdict, not decoration.

## Hedera transaction IDs

TODO, fill with real links only after a real payment settles on testnet.
Do not put SIM- ids here.

- Check payment, scene 1: tx id: (none yet), HashScan: (none yet)
- HCS audit, scene 1: tx id: (none yet), HashScan: (none yet)
- Scheduled Transaction, scene 1: (none yet)

## What is not in scope

No dashboard. No tokenization (Tokenize Anything dropped). No robot
(Physical AI dropped). No earning loop (Agents That Pay for Themselves
dropped). No Continuity tracks: this is a new-project-only submission.
