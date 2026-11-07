# Real-mode runbook

How to take hedera-council-agent from the labelled demo to the real thing on
Hedera testnet, in order. Nothing here needs a code change. Everything that
needs a human is in step 1 and step 5. Do the steps in order; each one is
checked by the next.

## The three run modes

- `real`: Hedera credentials are set in `.env` and `DEMO_MODE` is not `1`.
  This is the primary path. The x402 check goes through the Official
  facilitator, transfers are real Scheduled Transactions, the audit log is a
  real HCS topic, 0G writes real verdicts, World ID proofs are verified
  against developer.world.org.
- `demo`: start with `DEMO_MODE=1`. The explicit fallback until real is
  verified. Every chain id is a `SIM-` id, the UI shows the SIMULATED banner,
  and nothing touches the real chain, even if credentials are set.
- `setup-required`: no Hedera credentials and no `DEMO_MODE`. The server
  still starts and still answers reads, but every state-changing route
  returns 503 and names the missing credentials. Nothing is faked.

`npm run demo` runs the rehearsal as `DEMO_MODE=1` when no credentials are
set, and as a real rehearsal when they are.

## Step 1: credentials into .env

Copy `.env.example` to `.env` and fill in the six values. Never commit a
real `.env`. The three secrets below are never printed by any command.

How credentials reach the server: the copies in Muse's Secure Vault
(`custom.0g`, `custom.world`) are for Muse's own verification calls only.
The server reads its keys from its `.env` at runtime, so the owner puts
the values into the `.env` on agbeast-1 themselves when running preflight.
Never paste a key in chat, never write a key into a file, never invent one.

| Name | Where to get it | Status |
| --- | --- | --- |
| `HEDERA_ACCOUNT_ID` | portal.hedera.com, Testnet, ECDSA account | STILL NEEDED from the owner in chat. Public identifier (`0.0.x`), not a secret, and not stored in the vault. The server reads it from `HEDERA_ACCOUNT_ID`. 1000 test HBAR from the portal |
| `HEDERA_PRIVATE_KEY` | portal.hedera.com, the same account | Held in the vault (`custom.hedera`), ECDSA key. NOT VERIFIED: the key itself is proven only by a signed transaction in the preflight run on agbeast-1 (step 2), which needs the account ID above plus the key in the server's `.env`. The testnet mirror node is reachable (verified 2026-11-07), but that is a public read and does not use the key. The paying account also needs the testnet USDC `0.0.429274` association via faucet.circle.com; check it with `hedera account <id>` once the account ID is known |
| `ZERO_G_API_KEY` | pc.0g.ai, wallet login, Dashboard, API Keys | Key held in the vault (`custom.0g`) and verified live 2026-11-07, but the account is UNFUNDED: a test completion got past auth and came back 402 `insufficient_balance`. Top up at pc.0g.ai, or ask the 0G booth for hackathon credits, before the 0G compile step can run for real. Do not treat 0G as working until it is funded |
| `WORLD_RP_ID` | developer.world.org, your app | STILL NEEDED from the owner in chat. Public identifier (`rp_...`), not a secret, and not stored in the vault. The server reads it from `WORLD_RP_ID` |
| `WORLD_APP_ID` | developer.world.org, your app | STILL NEEDED from the owner in chat. Public identifier (`app_...`), not a secret, and not stored in the vault. The server reads it from `WORLD_APP_ID` |
| `WORLD_SIGNING_KEY` | developer.world.org, your app | Held in the vault (`custom.world`), server-side only. UNTESTED: no real World App proof has been available, so no verify call has been proven yet. The first real proof verification is the test |

All three providers are now connected in the vault: 0G valid but unfunded,
World signing key stored with RP ID and app ID still needed, Hedera key
stored with account ID still needed. What is still missing is listed in
each row above.

Optional, filled in by step 2: `X402_PAY_TO`, `HEDERA_TOPIC_ID`,
`HEDERA_TREASURY_ACCOUNT_ID`, `HEDERA_TOPIC_ADMIN_KEY`. Set
`COUNCIL_API_KEY` to a random string before exposing the server: without it,
`POST /proposals` and the other state-changing routes are unauthenticated.

Two World setup notes, both owner-only:

- The Developer Portal `join-council` action must allow more than one
  verification per person. Joins, ballots, invites and removals all prove
  under that one action (nullifiers are per action, so this is the only way
  a ballot's nullifier matches a seat). The signals tell them apart:
  `council-join`, `council-invite:<seat>`, `council-revoke:<seat>`,
  `council-vote:<subject>:<hash>:<choice>`. This was tested against a fake
  verifier only; confirm the action setting in the portal.
- World mocks proofs for this event, so no sandbox app is needed for the
  demo wiring. The real flow still goes through
  `POST https://developer.world.org/api/v4/verify/{rp_id}` with the
  environment pinned server-side.

## Step 2: one-time Hedera setup

```sh
npm run preflight -- --setup --create-fee-account --create-council
```

What it does, in order:

1. Checks the agent account balance. If the agent is not associated with
   testnet USDC `0.0.429274`, `--setup` associates it. Then get testnet USDC
   at faucet.circle.com (Hedera Testnet): the agent needs at least $0.01
   per check, and the fee account needs the same.
2. `--create-fee-account` creates a second account (same key, auto token
   association) to receive x402 check fees. It prints the account id. Set
   `X402_PAY_TO=<that id>` in `.env`. If `X402_PAY_TO` equals the agent
   account, the agent pays its own check fees to itself; the server warns
   about this at boot.
3. `--create-council` creates a council member account and a 2-of-2
   treasury (agent key plus member key), funded with 5 HBAR each, and saves
   them to `.data/council.json` (mode 0600, member key inside, keep it
   private). The server reads that file on boot, so proposals pay out of
   the treasury without another env var.
4. `--setup` creates the HCS audit topic. It prints the topic id. Set
   `HEDERA_TOPIC_ID=<that id>` in `.env`. The agent key is the submit key
   (it can append, it cannot rewrite history). If `HEDERA_TOPIC_ADMIN_KEY`
   is set to the council's public key, the council administers the topic;
   with it blank the topic has no admin key and is immutable.

Re-run plain `npm run preflight` after this. It must show no FAIL lines.
It also checks the x402 facilitator (`/supported` lists `exact` on
`hedera:testnet`), the 0G key (one real verdict call), and the World signing
key (it must be able to sign an RP request for `join-council`). Until the 0G
account is funded, the 0G check fails with 402 `insufficient_balance`;
that is the account, not the key. The preflight run is also the proof of
the Hedera key: the first signed transaction (USDC association, fee
account, council, or topic creation) proves the key matches the account.
Until that run, the stored key is unproven. Until Hedera credentials exist,
preflight reports SIMULATED mode and skips the real checks.

## Step 3: start the server and check the mode

```sh
npm start
curl http://localhost:3000/health
```

`/health` must say `"mode": "real"`. If it says `"setup-required"`, the
`missingCredentials` list in the same response names what is still missing.
If it says `"demo"`, `DEMO_MODE=1` is set somewhere; unset it for real mode.

## Step 4: one real x402 payment

Submit a small real proposal from the console, or from the command line:

```sh
curl -X POST http://localhost:3000/proposals \
  -H "Content-Type: application/json" \
  -d '{"proposal": {"id": "P-REAL-1", "description": {"payee": "<fee account or a registered payee>", "amountTinybars": 10000000, "token": "HBAR", "purpose": "Real check payment test"}, "transfer": {"payee": "<same>", "amountTinybars": 10000000, "token": "HBAR"}}}'
```

What happens, in order:

1. The agent pays $0.01 testnet USDC for the check through x402: its
   client signs a USDC transfer to `X402_PAY_TO`, the check service's
   `@x402/express` middleware has the Official facilitator verify and
   settle it, and the settlement comes back in the `PAYMENT-RESPONSE`
   header. The response carries `paidTxId` and a HashScan link.
2. 0G writes the plain-language verdict (request id in the response).
3. The deterministic checker compares description and transfer exactly.
4. A large proposal (at or above `LARGE_PROPOSAL_TINYBARS`, default
   50,000,000 tinybars, 0.5 HBAR) needs a World ID approval before the
   agent signs. A small proposal signs directly.
5. The agent co-signs the Scheduled Transaction for the exact transfer
   (the council member created it, or the server created it from
   `.data/council.json`), and the decision is appended to the HCS audit
   topic as a hash-chained entry.

Capture the evidence bundle:

```sh
curl http://localhost:3000/proposals/P-REAL-1/evidence
```

It has the check payment tx id and HashScan link, the 0G request id, the
schedule id and its HashScan link, and the HCS audit tx id, sequence and
hash. Verify the chain independently:

```sh
npm run verify -- P-REAL-1
```

It must show no FAIL lines. `/audit/verify` in the browser must say the
chain is intact.

If `POST /check` returns 503 in real mode, the facilitator was unreachable
at boot. The server refuses rather than taking an unverified payment.
Restart once the facilitator is reachable; do not work around it.

## Step 5: record the proof

In `README.md`, under `## Hedera transaction IDs`, replace the
`(none yet)` lines with the real values from the evidence bundle. Real
links only, never simulated ids. Fill in at least:

- Check payment: tx id and HashScan link.
- HCS audit topic entry: tx id and HashScan link.
- Scheduled Transaction co-signed inside the instruction, and after a
  council vote, once each has happened for real.

Then fill `docs/world-debrief.md`: time to first success, friction
encountered, the missing capability or documentation, and the one
improvement with the greatest impact. The file already lists what was
verified (backend verify endpoint, action and environment checks, the
single `join-council` action) and what is still unconfirmed (the portal
action setting from step 1).

## Step 6: final checks before submitting

```sh
npm test        # 160 tests, all green
npm run demo    # ALL 12 SCENES CORRECT (demo fallback, DEMO_MODE=1)
npm run ready   # no FAIL lines
```

`npm run ready` turns green on the real-mode items one by one: the six
credentials set, a HashScan link in the README, and the debrief filled in.
The remaining TODO lines are owner decisions (demo video, keep-or-strip on
the CODE_TANTRAFEST-derived pages, the 09:00 IST deadline).

## What now works in real mode

- Paid check: `POST /check` behind `@x402/express` `paymentMiddleware`
  with the Official facilitator, `hedera:testnet`, $0.01 testnet USDC
  `0.0.429274`. The resource server calls `initialize()` before the
  middleware is mounted. If the facilitator is unreachable at boot, real
  mode fails closed on `/check` (503) instead of falling back to the plain
  402 shape, which only checks that a transaction id exists and cannot
  prove it paid this service the right amount.
- Agent-side payment: `src/x402Client.ts` pays through `@x402/fetch` with
  an `@x402/hedera` Exact scheme signer, a policy that pays only the
  registered check service whatever the 402 names, and a policy that never
  pays more than the configured check price. A swapped recipient is
  refused before anything is signed.
- Scheduled Transactions: the council member creates the schedule
  (`npm run propose -- <payee> <amount HBAR> "<purpose>"`), the agent
  reads it back from the mirror node and checks the transfer it will
  really execute against the description, then co-signs with
  `ScheduleSign`. A deleted, executed or changed schedule aborts the
  decision. The treasury is a 2-of-2 threshold key, so the transfer runs
  only once both signatures exist.
- HCS audit log: entries are hash-chained, written serially, and the chain
  continues from the topic's latest entry after a restart. `/audit/verify`
  re-reads the topic from the mirror node and re-checks the chain.
- 0G verdicts: `POST /v1/chat/completions` on `router-api.0g.ai`,
  model `0gm-1.0-35b-a3b`, `X-0G-Provider-Trust-Mode: verified`, request
  id from the response body `x_0g_trace.request_id`. A missing verdict
  fails closed in real mode. Standing instructions are compiled by 0G
  into machine-checkable rules with strict JSON validation; invalid model
  output fails closed with 422. Status 2026-11-07: the key is valid and
  the Router lists 125 models, but the account is UNFUNDED (402
  `insufficient_balance`), so no real verdict or compile can run until the
  owner tops up at pc.0g.ai or gets hackathon credits from the 0G booth.
- World ID: the server signs each proof request with the RP signing key
  (`@worldcoin/idkit-core/signing`, server only), the browser scans the
  IDKit QR in World App, and the server forwards the result to the v4
  verify API with the environment pinned. Approvals are stored server-side,
  single use, 5 minutes. A client-supplied "approved" object is never
  accepted as authorization. Mocked approvals are accepted only when World
  is not configured and never on mainnet. Status 2026-11-07: the signing
  key is held in the vault, but the RP ID and app ID are still needed from
  the owner, and no real World App proof has been available, so the verify
  call is untested. The first real proof verification is the test.
- Preflight: `npm run preflight` checks Hedera balances and USDC
  association, the fee account, the council and treasury, the HCS topic,
  the facilitator, 0G and the World signing key, and performs the one-time
  setup with `--setup --create-fee-account --create-council`.

## What still needs the owner

- Hedera account ID: still needed from the owner in chat (public
  identifier). The key is stored in the vault, but it is unproven until
  the preflight run on agbeast-1 signs a transaction with it. The paying
  account also needs the testnet USDC `0.0.429274` association via
  faucet.circle.com; check it with `hedera account <id>` once the account
  ID is known.
- 0G funding: the key is valid but the account is unfunded (402
  `insufficient_balance`, verified 2026-11-07). Top up at pc.0g.ai or get
  hackathon credits from the 0G booth. Until then, 0G verdicts and the 0G
  compile step fail closed.
- World RP ID and app ID: still needed from the owner in chat (public
  identifiers, not secrets). The signing key is already in the vault.
  Then the first real World App proof is the test of the verify call.
- The World Developer Portal `join-council` action setting (step 1).
- A real x402 payment and its HashScan link, recorded in the README.
- `docs/world-debrief.md` filled in after the first real attempt.
- The demo video (human voiceover) and the submission itself.
