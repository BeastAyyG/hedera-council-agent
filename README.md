# hedera-council-agent

An AI agent holds one signing seat on a Hedera treasury council.

A proposal is a transfer: a description (payee, amount, purpose) plus the
exact on-chain transfer it will execute. The agent pays for a check of
each proposal, signs routine ones itself, and refuses any proposal whose
actual transfer does not match its description. Before signing a large
proposal, its owner must pass a fresh World ID check tied to that exact
proposal (the transfer bytes themselves, via the IDKit signal). If the check is denied or expires, the agent does not sign.

Proposals are Hedera Scheduled Transactions plus HCS, with no smart
contracts. The exact transfer is fixed when the proposal is created, and
council signatures approve it.

Written fresh for ETHGlobal Mumbai 2026, Nov 5-7. Deadline: Saturday
Nov 7, 09:00 IST. No code, designs, or assets from any earlier project
are in this repo. The ideas come from an earlier DAO governance project,
the code here is new.

## Architecture

```
council member schedules the exact transfer out of a 2-of-2 treasury (Hedera Scheduled Transaction)
  -> agent reads the schedule back from the mirror node: the transfer to check is the one on Hedera
  -> x402 paid check (402, pay, verify settlement)
  -> 0G Private Computer writes the plain-language verdict (request id logged)
  -> deterministic mismatch checker (exact payee / amount / token, no LLM in the decision path)
  -> large proposal? World ID Agent Pass gate (fresh check, this exact proposal)
  -> sign: ScheduleSign adds the agent's signature, the second of two, and the transfer executes
  -> audit: every decision logged to an HCS topic
```

- `src/proposal.ts` - proposal and transfer model, input validation
- `src/checker.ts` - deterministic mismatch checker
- `src/budget.ts` - spending cap for check payments (USDC)
- `src/x402.ts` - plain 402 shape used in simulated mode
- `src/x402Client.ts`, `src/payment.ts` - the agent pays for checks over real x402
- `src/hedera.ts` - Hedera client, env-gated real / simulated; schedules, HCS, setup helpers
- `src/chain.ts`, `src/mirror.ts` - the council on Hedera: propose, read back from the mirror node, check, co-sign
- `src/propose.ts` - `npm run propose`: a council member schedules a transfer
- `src/zeroG.ts` - 0G Private Computer client (OpenAI-compatible)
- `src/world.ts` - World ID: RP-signed requests, server-side verification, approval store, gate
- `src/store.ts` - durable council seats and spent approvals (`.data/state.json`)
- `src/council.ts` - orchestration: pay, verdict, check, gate, sign or refuse
- `src/server.ts` - HTTP server and API (below)
- `src/preflight.ts` - checks every external dependency, one-time Hedera setup
- `src/demo.ts` - demo rehearsal, 8 scenes
- `public/` - the UI: `index.html` (atlas), `report.html`, `console.html`, shared `assets/` (see `docs/ui-handoff.md`)

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below, never commit .env
npm test               # build + 109 tests (unit + HTTP level)
npm run preflight      # check Hedera, x402, 0G, World ID; add -- --setup, --create-fee-account, --create-council for one-time Hedera setup
npm run demo           # demo rehearsal, 8 scenes
npm start              # HTTP server on :3000 (PORT to change); UI at /
```

`.env` is loaded automatically by `npm start`, `npm run demo` and `npm run preflight`.
Node 20.12 or newer.

## API

| Route | What it does |
| --- | --- |
| `GET /health` | mode, what is real and what is simulated |
| `POST /check` | the paid check service, protected by x402 (HTTP 402 until paid) |
| `POST /proposals` | full flow: pay via x402, 0G verdict, mismatch check, World ID gate, sign or refuse |
| `GET /proposals` | list of registered proposals |
| `GET /proposals/:id` | registered proposal, last outcome, approval state |
| `GET /proposals/:id/evidence` | evidence bundle for the decision (payment, 0G request id, schedule, audit entry) with a sha256 digest |
| `GET /policy` | the published agent policy and its hash |
| `GET /audit`, `GET /audit/verify` | the HCS decision log, and a from-scratch re-check of its hash chain |
| `POST /world/rp-context` | RP-signed IDKit request for one server-chosen action |
| `POST /world/verify` | verifies the owner's World ID for one proposal and stores the approval server-side |
| `POST /council/join` | Proof of Human council join, one seat per nullifier |
| `GET /council/seats` | current seats, and the epoch |
| `POST /proposals/:id/execute` | after the challenge window: re-check everything from scratch (mismatch check, payee registry, epoch, World ID approval still unexpired), then sign or abort. `425` with seconds remaining before the window ends; `409` on a challenged proposal. Needs the API key |
| `POST /proposals/:id/challenge` | `{reason}` pauses execution (`CHALLENGED` in the log); `{resume: true}` lifts it (`CHALLENGE_RESOLVED`). Needs the API key |
| `POST /payees/:account/revoke` | revokes a registry entry at runtime (`PAYEE_REVOKED`). `GET /payees` shows `revokedAt`. Needs the API key |
| `POST /council/revoke` | a current seat holder (World ID proof under the `join-council` action with signal `council-revoke:<seat>`, so its nullifier matches the holder's seat; or a labelled MOCKED holder in demo mode) revokes a seat: epoch +1, the nullifier is blocked from rejoining, every pending proposal is cancelled, one `REVOKED` log entry. Needs the API key |
| `GET /council/epoch` | `{epoch, revokedSeats}` |
| `GET /`, `/console.html`, `/report.html?proposal=<id>` | the UI |

## Verifiable by anyone

These make the agent auditable, not just correct. They are Hedera-native and need no extra service.

- **Tamper-evident decision log.** Every decision is an HCS message that carries the hash of the previous one
  (`src/auditlog.ts`). `GET /audit/verify` re-reads the topic from the mirror node and re-checks the chain from
  genesis: an edited, dropped, reordered or forged entry is reported with the entry number. The topic is created
  with the agent's submit key, so nobody else can append to it. After a restart the chain continues from the
  topic's latest entry.
- **Check it without trusting our server.** `/verify.html` is a static page that reads the topic straight from a
  Hedera mirror node and re-computes every hash in your own browser (`public/assets/chain-verify.js`, no
  dependencies). Open `/verify.html?topic=0.0.1234&network=testnet`; each entry turns green as it is re-checked, and
  a break shows the entry number. It also lists the policy hash found in the entries to compare with `/policy`.
- **Published policy.** `GET /policy` is the rule set the agent signs under (`src/policy.ts`); its hash is inside
  every audit entry, so each decision commits to the policy in force when it was made.
- **Evidence bundle per decision.** `GET /proposals/:id/evidence` gathers the transfer actually checked and where it
  was read from, the check, the x402 payment, the 0G request id, the schedule and the audit entry, with HashScan
  links in real mode and a digest over the whole bundle.
- **Replayable audit.** `npm run verify -- <proposalId> [--server http://127.0.0.1:3000]` (`src/verify.ts`) fetches the
  evidence bundle and policy, then re-computes the bundle digest, the proposal hash and World ID signal, re-reads
  the audit topic, re-checks the whole hash chain, and confirms the decision's entry and policy hash. In real mode
  the topic comes from a Hedera mirror node, not from our server. In simulated mode there is no mirror node, so it
  reads the server log and prints `SIMULATED: no mirror node, reading the server log`. Each line is `PASS`, `WARN`
  (simulated 0G verdict or `SIM-` ids) or `FAIL`; any `FAIL` exits 1. Change one character of a stored receipt and
  the matching line fails (`test/verify.test.ts`).
- **Discoverable paid check.** `POST /check` declares an x402 Bazaar discovery extension (`@x402/extensions`), so
  other agents can find the paid service and see its input and output. The unpaid 402 carries it (checked against
  the Official facilitator).

Considered and left out: World AgentKit. Its documented networks are World Chain and Base, and it does not
document Hedera, so adding it here would not be a real integration.

## Real-mode council setup

```bash
npm run preflight -- --setup --create-fee-account --create-council
# set X402_PAY_TO from the output; the treasury and member are saved to .data/council.json
npm run propose -- 0.0.<payee> 0.1 "Pay the venue deposit"   # a member schedules the transfer
# POST the printed JSON to /proposals: the agent reads the schedule back from Hedera,
# compares it to the description, pays for the check over x402, and co-signs if it matches.
```

The treasury needs two signatures (agent and member), so a proposal does nothing until
the agent signs, and the agent never signs a schedule whose on-chain transfer differs from
its description, even when the request body says it matches. A proposal without a
`scheduleId` makes the server act as the member and schedule it, which keeps the demo to one command.

Authorization rules the tests enforce: a client-supplied World ID "check" in the
request body is ignored; only approvals the server verified itself count. An
approval is bound to one proposal id, expires after 5 minutes, and is spent
on the first signing. A proposal id is bound to its content on first submission.
Each World proof is accepted once (keyed on action + nullifier, stored on disk).
The World environment comes from server config, so a client cannot pick
`staging` or `sandbox`. With World configured, mocked approvals are refused.
There is no user authentication on `POST /proposals`: run it on a trusted
network, it is a council agent API, not a public one.

## Env vars

| Var | What it is |
| --- | --- |
| `HEDERA_NETWORK` | `testnet` (default) or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Agent's Hedera account id, e.g. `0.0.123456`, from portal.hedera.com |
| `HEDERA_PRIVATE_KEY` | Its private key. Raw hex is read as ECDSA (required for x402); DER keeps its own type; `HEDERA_KEY_TYPE=ed25519` for raw ED25519 |
| `HEDERA_TREASURY_ACCOUNT_ID` | Account the proposals pay out of. `--create-council` makes a 2-of-2 treasury and saves it; the agent refuses schedules that pay out of any other account |
| `COUNCIL_PROPOSER_ACCOUNT_ID`, `COUNCIL_PROPOSER_PRIVATE_KEY` | The council member that schedules proposals. Default: read from `.data/council.json` (written by `--create-council`) |
| `HEDERA_TOPIC_ID` | HCS topic for the audit log. Created on first audit if unset (printed in the log) |
| `X402_PAY_TO` | Account that receives check fees. Defaults to the agent, which pays itself: use `npm run preflight -- --create-fee-account` |
| `X402_PRICE_USDC` | Price of one check, default `0.01` |
| `CHECK_SERVICE_URL` | Paid check service the agent calls, default this server's `/check` |
| `AGENT_SPEND_CAP_USDC` | Agent spending cap per run, default `0.10` |
| `LARGE_PROPOSAL_TINYBARS` | Large threshold, World ID required at or above, default `50000000` (0.5 HBAR) |
| `PAYEE_REGISTRY` | Payee accounts the council may pay: JSON array of `{account, label, validFrom?, validUntil?}` or a comma list of `0.0.x`. Non-empty turns enforcement on |
| `PAYEE_REGISTRY_FILE` | Same, read from a JSON file. A runtime revocation is written back to this file; env and demo registries are revoked in memory only |
| `CHALLENGE_WINDOW_SECONDS` | Default `0` (off: sign as soon as every check passes). Above 0, a passing proposal is `PENDING_CHALLENGE` and signs only through `POST /proposals/:id/execute` after the window, once a re-check passes. A World ID approval lasts 5 minutes, so for a window over 5 minutes the owner approves again before executing. Part of the published policy |
| `COUNCIL_API_KEY` | When set, `POST /proposals`, `/proposals/:id/execute`, `/proposals/:id/challenge`, `/payees/:account/revoke` and `/council/revoke` need `Authorization: Bearer <key>` or `x-api-key`. Unset: open (`auth: "open (demo)"` in `/health` and `/policy`, and a startup warning in real mode). `/check`, `/world/*` and `/council/join` keep their own protection |
| `REQUIRE_REGISTERED_PAYEE` | `true` enforces the registry even when it is empty (refuses every payee) |
| `ALLOW_NO_0G` | `true` lets the agent sign without a 0G verdict. Default off: no verdict, no signature |
| `ZERO_G_API_KEY` | 0G Private Computer API key, `sk-` key from pc.0g.ai |
| `ZERO_G_BASE_URL` | Default `https://router-api.0g.ai/v1` |
| `ZERO_G_MODEL` | Default `0gm-1.0-35b-a3b` (verified slug; `0gm-1.0` on the prize page is shorthand) |
| `WORLD_RP_ID` | World ID RP id (`rp_...`), server only, from developer.world.org |
| `WORLD_APP_ID` | World ID app id (`app_...`), public |
| `WORLD_SIGNING_KEY` | World signing key, server only, never expose to the client |
| `WORLD_ENVIRONMENT` | `production` (default), `staging` or `sandbox`. Server-side only |
| `X402_FACILITATOR_URL` | Default `https://x402.org/facilitator` (Official) |
| `STATE_FILE` | Council seats and spent approvals, default `.data/state.json` |

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
(`@x402/fetch` + `@x402/hedera` Exact scheme). The agent pays that route itself
(`src/payment.ts`) under the USDC spending cap, never offering more than the
configured price, and the settlement transaction id is the payment id.
Every decision is logged to HCS.

How to get 0G credits: ask at the 0G booth / 0G docs at the event. Every
team gets 0G compute credits to build with. A key is created at pc.0g.ai
after a wallet login, Dashboard, API Keys. The auditable request id is
`x_0g_trace.request_id` in the response body, and it is stored and
printed per check.

## Real vs simulated

Each integration switches on by its own env vars and is labelled in `/health`
and in every outcome.

- Hedera and x402: without `HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY` the full
  logic runs in SIMULATED mode (`SIM-PAY-…`, `SIM-SCHED-…`, `SIM-HCS-…`). With
  them, the agent pays `/check` over real x402, creates or co-signs real
  Scheduled Transactions and writes real HCS messages.
- 0G: without `ZERO_G_API_KEY` in simulated mode, verdicts are labelled
  `[SIMULATED 0G verdict]`. The agent fails closed: if a key is set and the 0G
  call fails, or in real Hedera mode with no key, it refuses (`REFUSED_NO_VERDICT`)
  rather than signing without a verdict. `ALLOW_NO_0G=true` overrides this, and
  the log entry says so. Every decision entry on HCS anchors the proposal hash,
  the 0G request id and model, a hash of the verdict plus the proposal hash,
  and the payee registry result.
- Payee registry: the council keeps its own list of payee accounts (this
  project's registry, not ERC-8004 or ERC-8478, and nothing is read from any
  on-chain registry). When it has entries, or `REQUIRE_REGISTERED_PAYEE=true`,
  a proposal whose transfer goes to an unregistered or expired account is refused
  (`REFUSED_UNREGISTERED_PAYEE`) after the mismatch check and before the World ID
  gate. Simulated mode with nothing configured uses a labelled demo registry
  (0.0.1001-0.0.1004, 0.0.6666); real mode with an empty registry enforces
  nothing, and `/policy` says so. `GET /payees` lists it.
- x402 seller identity: the 402 response is untrusted. The agent pays only an
  offer whose `payTo` equals the registered check service (`X402_PAY_TO`); a
  swapped `payTo` is refused before anything is paid (`REFUSED_PAYEE_SWAP`).
  Verified against a local seller with the real `@x402/fetch` client; not yet
  against the live facilitator.
- World ID: without `WORLD_RP_ID`, `WORLD_APP_ID` and `WORLD_SIGNING_KEY`, the
  approval page offers a MOCKED approval (testnet only). With them, only
  server-verified World ID proofs count and mocks are refused. `npm run demo`
  always uses MOCKED approvals. The approval is bound to the exact transfer
  bytes: the server derives an IDKit `signal` (`council-proposal:` plus the
  SHA-256 of the proposal fingerprint) from its own registered copy, the
  owner's proof must carry that signal's hash, and a proof made for any
  other content is refused without being spent.

No fake transaction id is ever presented as real.

Current status at build time: the code paths for all of this are written and
tested against stubs, but no real Hedera payment, 0G call or World proof has
run, because no credentials were available. `npm run preflight` shows what is
missing.

## Demo rehearsal

`npm run demo` runs 8 scenes (it prints `ALL 8 SCENES CORRECT` when every one behaves):

1. Routine proposal, paid check, agent signs.
2. Mismatched proposal (payee and amount differ), paid check, agent refuses.
3. Large proposal, World ID approved, agent signs.
4. Large proposal, World ID denied, agent does not sign.
5. Reuse of yesterday's World approval is refused: an approval signs one payment and is spent.
6. Same amount, same description, swapped recipient in the 402: refused before paying, nothing spent. "The amount was right. The recipient was a lie."
7. 0G unavailable: the agent fails closed and does not sign.
8. Challenge window (600 s on a fake clock, no sleeping): a proposal passes every check and waits instead of signing. Its payee is revoked inside the window, so at execution the agent prints `re-checked at execution: payee revoked, ABORTED`. A second proposal executes after the window and signs.

Each scene prints its decision, the check payment id, the 0G verdict
and request id, the World ID gate result, the Scheduled Transaction id,
and the HCS audit id. In real mode the payment line also prints a
HashScan link.

Demo video: 2-3 minutes. ETHGlobal requires 2-4 minutes, 0G wants under
3 minutes. Lead with the refusal (scene 2), then scenes 1, 3 and 4
(the World ID gate), then 5, 6 and 7 (spent approval, swapped recipient,
0G fails closed), and 8 if time allows (challenge window). See `docs/demo-script.md`.

## Track-by-track submission notes

1. **Hedera, AI Agents That Pay: x402 on Hedera, $6,500.**
   `POST /check` is a real x402 resource (`src/server.ts`, `@x402/express`,
   Official facilitator). The agent is the buyer: `src/payment.ts` and
   `src/x402Client.ts` pay it $0.01 testnet USDC per check with no human
   approving, refuse any offer above the configured price, stay under a
   USDC spending cap (`src/budget.ts`), and use the settlement transaction
   id as the payment id. `src/council.ts` cross-checks the paid result
   against its own deterministic check. Each decision is logged to HCS.
   Real transaction ids go in the section below once a payment settles.
2. **Hedera, "No Solidity Allowed": Build with Hedera SDKs, $2,000.**
   `@hiero-ledger/sdk`, no Solidity anywhere in this repo. HTS (the USDC
   transfer inside each x402 payment), HCS (audit topic, created on first
   use) and Scheduled Transactions (`src/hedera.ts`, `src/chain.ts`). A
   council member schedules the exact transfer out of a 2-of-2 threshold-key
   treasury, which fixes it on Hedera before anyone signs. The agent reads
   the schedule back from the mirror node (`src/mirror.ts` decodes the
   scheduled transaction body), compares what it will really execute with the
   description, and adds its signature with `ScheduleSign` only if they match.
3. **World, World ID Agent Pass, $5,000.**
   Before signing a large proposal the owner must pass a fresh World ID
   check for that exact proposal. The server signs the IDKit request
   (`rpContextFor`, RP signing key never leaves the server), the owner scans
   the QR in the console, and the server verifies the result at
   `POST https://developer.world.org/api/v4/verify/{rp_id}` with the
   environment pinned from config (`src/world.ts`). The approval is stored
   server-side for 5 minutes, bound to the proposal, and spent once; the proof's
   nullifier is recorded so it cannot be replayed. This follows World's
   human-in-the-loop guidance. There is no standalone Agent Pass SDK.
   Debrief: `docs/world-debrief.md`, to fill in after the first real run.
4. **World, Best Use of IDKit, $2,500, if time allows.**
   `POST /council/join` plus the join panel in the console. Proof of Human, verified on
   the server, one council seat per nullifier, stored on disk
   (`src/store.ts`). Not yet run against World with real credentials.
5. **0G, Build with 0G Private Computer, $5,000.**
   0G writes the check's plain-language verdict in the main flow
   (`src/zeroG.ts`) and its `x_0g_trace.request_id` is stored and logged to
   HCS per check. The deterministic checker, not 0G, decides to refuse; the
   verdict is the human-readable record that decision is logged alongside.
   Not yet run with a real key.

## Hedera transaction IDs

Fill with real links only after a real payment settles on testnet.
Do not put SIM- ids here.

- Check payment, scene 1: tx id: (none yet), HashScan: (none yet)
- HCS audit, scene 1: tx id: (none yet), HashScan: (none yet)
- Scheduled Transaction, scene 1: (none yet)

## Challenge window and seat revocation: limits

- The real-mode path (schedule admin key set to the proposer, `ScheduleDeleteTransaction` on seat revocation, re-reading the schedule at execution) is written and unit-tested only against a fake chain port. It has not run against Hedera.
- World ID nullifiers are per person, app and action, so `POST /council/revoke` takes a proof under the same `join-council` action as joining; the signal (`council-join` vs `council-revoke:<seat>`) keeps a join proof from being replayed as a revocation. This is tested against a fake verifier only. Not yet tried against World: whether the Developer Portal accepts a second verification by the same person for one action (if the action is limited to one verification, revocation needs that limit raised).
- No limit ladder was built: revoking only bumps the epoch, blocks the nullifier and cancels pending proposals.
- A World ID approval lasts 5 minutes. With a window longer than that, a large proposal needs a fresh approval before execution.

## What is not in scope

No dashboard (only the small World ID approval page). No tokenization (Tokenize Anything dropped). No robot
(Physical AI dropped). No earning loop (Agents That Pay for Themselves
dropped). No Continuity tracks: this is a new-project-only submission.
