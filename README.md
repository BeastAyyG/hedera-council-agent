# hedera-council-agent

**Tell it once. It guards the treasury.**

An agent with a signing key to a company treasury is a liability: one bad instruction, one dishonest proposer
or one prompt injection and the money is gone. This project turns that around. The owner writes a standing
instruction once, in plain words. 0G turns it into rules that code can check. A council of World-ID-verified humans
adopts those rules by majority vote, and their hash is anchored on Hedera. After that, the agent co-signs payments
inside the rules on its own. Anything outside the rules goes to a council vote. Every step goes into a hash-chained
audit log that anyone can re-check.

The AI never signs and never decides a payment. It compiles words into rules that humans read and adopt. Fixed
code applies the rules.

Written fresh for ETHGlobal Mumbai 2026, Nov 5-7. Deadline: Saturday Nov 7, 09:00 IST (check the Hacker Dashboard
for the final time). No code, designs or assets from an earlier project are in `src/`. The ideas come from an
earlier DAO governance project. For the UI pages, see the From Scratch items in `docs/submission.md`.

## How it works

```
OWNER     "Pay 0.0.1001 or 0.0.1002 up to 50 HBAR each, at most 100 HBAR a month.
           Anything else goes to the council."                              /mandate.html
            |
0G        compiles the text into MandateRules JSON (one call, temperature 0)
            -> strict validation (exactly 5 fields, ranges, account ids); bad output = 422, no draft
            -> a plain-language summary, written by code from the rules, not by the model
            |
COUNCIL   majority vote of World-ID-verified seats; each ballot is a World ID proof
          bound to the exact rulesHash and the choice                       /council.html, /member.html
            -> MANDATE_ADOPTED (rulesHash, textHash) written to the HCS audit log
            |
PAYMENT   a council member schedules the exact transfer (Hedera Scheduled Transaction, 2-of-2 treasury)
            -> agent reads the schedule back from the mirror node (real mode)
            -> pays the x402 check fee -> 0G writes the verdict -> deterministic mismatch check
            -> payee registry -> standing instruction:
                 inside   -> agent co-signs (ScheduleSign), no vote, no per-payment World ID
                 outside  -> PENDING_VOTE: the council votes; yes = re-check and sign, no = refused
                             (or refused at once if the instruction says "refuse anything else")
            |
AUDIT     every decision, ballot and adoption is a hash-chained HCS entry
          -> GET /audit/verify, /verify.html (in your browser, from a mirror node), npm run verify
```

### The hole this closes

The first version checked a transfer against the proposer's own description. A dishonest proposer writes both, so
they always matched. Now the amount and recipient are also checked against the owner's adopted rules
(`src/mandate.ts` `evaluateMandate`): per-payment limit, monthly cap, allowed payees, purpose keywords. The proposer
cannot change those rules. Only a council vote can adopt new rules.

### The three partner integrations

| Partner | What it does here | Code |
| --- | --- | --- |
| **Hedera** | Scheduled Transactions hold the exact transfer out of a 2-of-2 treasury. The agent's `ScheduleSign` is the second signature. HCS holds the hash-chained audit log, including `MANDATE_ADOPTED` with the rules hash. The agent pays an x402 check fee in testnet USDC (HTS) per payment. `@hiero-ledger/sdk`, no Solidity. | `src/hedera.ts`, `src/chain.ts`, `src/mirror.ts`, `src/payment.ts`, `src/x402Client.ts`, `src/auditlog.ts` |
| **World ID** | One council seat per human (Proof of Human, nullifier). Every ballot is a fresh proof whose signal binds it to the subject, its exact bytes and the choice. Seat revocation uses the same action. With no instruction active, a large payment needs a per-payment World ID approval (the original gate). | `src/world.ts`, `src/server.ts` (`authBallot`, `/council/join`, `/council/revoke`) |
| **0G Private Computer** | Compiles the owner's instruction into `MandateRules` (request id kept on the draft and in the `MANDATE_PROPOSED` entry). Writes the plain-language verdict for each payment check. The agent fails closed without it. | `src/mandate.ts` `compileMandate`, `src/zeroG.ts` |

### What is simulated without keys

Each integration turns on with its own env vars and is labelled in `/health` and in every outcome:

- **No Hedera keys:** the full logic runs, but ids are `SIM-PAY-…`, `SIM-SCHED-…`, `SIM-HCS-…`. No mirror node is
  used, and the check is paid with a simulated payer.
- **No `ZERO_G_API_KEY`:** a deterministic parser (`parseMandateText`) compiles instructions, labelled
  `SIMULATED 0G`. Verdicts are templates labelled `[SIMULATED 0G verdict]`. In real Hedera mode with no key, the agent
  refuses to sign.
- **No World keys:** joins, approvals and ballots are MOCKED. They are labelled as mocked, allowed only on testnet,
  and refused once World is configured. The council page offers a DEMO "Act as" picker so one person can play several
  members.

**Nothing has run against real Hedera, 0G or World yet.** See [What is simulated / not yet verified](#what-is-simulated--not-yet-verified).

## Source map

- `src/mandate.ts`: standing instructions. `MandateRules`, strict `validateRules`, the SIMULATED parser,
  `compileMandate` (0G), `summarize`, `evaluateMandate`, ballots (`castBallot`, `voteSignal`, majority `neededFor`)
- `src/council.ts`: orchestration. `processProposal` runs pay, verdict, mismatch check, payee registry, instruction,
  World ID gate, then signs or refuses. `resolveVote` closes a council vote. `executePending` runs after the
  challenge window.
- `src/proposal.ts`: proposal and transfer model, validation, fingerprint
- `src/checker.ts`: deterministic mismatch checker (payee, amount, token)
- `src/payee.ts`: council payee registry
- `src/challenge.ts`: re-check at execution
- `src/budget.ts`: USDC spending cap for check fees
- `src/x402.ts`, `src/x402Client.ts`, `src/payment.ts`: the paid check (seller and buyer)
- `src/hedera.ts`, `src/chain.ts`, `src/mirror.ts`: Hedera client (real or simulated), schedules, HCS, mirror node reads
- `src/auditlog.ts`: hash-chained audit entries, `canonical()` JSON
- `src/zeroG.ts`: 0G Private Computer client (OpenAI-compatible)
- `src/world.ts`: World ID (RP-signed requests, server-side v4 verify, approvals, signals)
- `src/store.ts`: durable state in `.data/state.json` (seats, epoch, used approvals, instructions, votes, monthly spend)
- `src/policy.ts`: the published policy and its hash
- `src/server.ts`: HTTP API and static pages
- `src/verify.ts`: `npm run verify`, a replayable audit of one decision
- `src/preflight.ts`, `src/ready.ts`, `src/propose.ts`, `src/demo.ts`: tooling (below)
- `public/`: the UI. `index.html` (Atlas), `console.html`, `mandate.html` (Instructions), `council.html` (Council),
  `member.html` (My seat), `report.html`, `verify.html`, shared `assets/` (see `docs/ui-handoff.md`)

## Setup

```bash
npm install
cp .env.example .env   # fill in the values below, never commit .env
npm run css:console    # only after editing public/console.html
npm test               # build + unit and HTTP tests
npm run preflight      # check Hedera, x402, 0G, World ID; add -- --setup, --create-fee-account, --create-council for one-time Hedera setup
npm run demo           # demo rehearsal, 12 scenes
npm start              # HTTP server on :3000 (PORT to change); UI at /
```

`.env` is loaded automatically by `npm start`, `npm run demo` and `npm run preflight`. Node 20.12 or newer.

| Script | What it does |
| --- | --- |
| `npm test` | Build, then every test in `test/` (unit and HTTP level, against fakes for Hedera, 0G and World) |
| `npm run demo` | 12-scene rehearsal, prints `ALL 12 SCENES CORRECT` |
| `npm start` | The server and UI |
| `npm run preflight` | Live checks of every external dependency, one-time Hedera setup |
| `npm run propose -- 0.0.<payee> <hbar> "<purpose>"` | A council member schedules a transfer (real mode) |
| `npm run verify -- <proposalId> [--server URL]` | Replayable audit of one decision |
| `npm run ready` | Submission readiness: PASS / TODO / FAIL |

### Try the whole flow in the browser (simulated)

1. `npm start`, then open `/council.html` and join three DEMO members.
2. `/mandate.html`: write the instruction (or pick an example chip), then compile. The rules appear as a checklist with
   a `SIMULATED 0G` badge.
3. `/council.html`: under **Act as**, pick two members and vote yes. The instruction is adopted, and its hash and
   monthly spend bar show on `/mandate.html`.
4. `/console.html`: submit a payment inside the rules (it signs). Then submit one to a payee outside the instruction's
   list, which shows "waiting for the council". Vote on it on `/council.html` or on a member's `/member.html?seat=…`.
5. `/verify.html`: **Load simulated log** re-checks every hash in your browser.

In simulated mode the demo payee registry (0.0.1001-0.0.1004, 0.0.6666) is enforced *before* the instruction. A
payee outside that registry is refused, not voted on. To show a vote, use a registered payee that the instruction does
not list (the demo uses 0.0.1003).

## API

State-changing routes marked **key** need `COUNCIL_API_KEY` when it is set.

| Route | What it does |
| --- | --- |
| `GET /health` | Mode, what is real and what is simulated, active instruction id and rules hash |
| `POST /check` | The paid check service, protected by x402 (HTTP 402 until paid) |
| `POST /proposals` **key** | Full flow: pay via x402, 0G verdict, mismatch check, payee registry, standing instruction, World ID gate, then sign, refuse, `PENDING_CHALLENGE` or `PENDING_VOTE` |
| `GET /proposals` | Registered proposals, each with `vote` and `mandate` (`{id, within, violations}`) or null |
| `GET /proposals/:id` | Registered proposal, last outcome, approval state |
| `GET /proposals/:id/evidence` | Evidence bundle for the decision (payment, 0G request id, schedule, audit entry, instruction, vote) with a sha256 digest |
| `POST /proposals/:id/execute` **key** | After the challenge window: re-check from scratch, then sign or abort. `425` before the window ends, `409` if challenged |
| `POST /proposals/:id/challenge` **key** | `{reason}` pauses execution (`CHALLENGED`), `{resume: true}` lifts it (`CHALLENGE_RESOLVED`) |
| `POST /proposals/:id/vote` **key** | A ballot on a `PENDING_VOTE` payment: `{choice, idkitResult}`, or in demo mode `{choice, mocked: true, byNullifier}`. `403` not an eligible seat, `409` already voted or vote closed |
| `GET /mandate` | `{active, drafts, spentThisMonthTinybars, monthKey}` |
| `POST /mandate/draft` **key** | `{text}`. 0G (or the SIMULATED parser) compiles it, and a council vote opens over the current seats. `201` draft, `400` empty or over 1000 chars, `409` no seats yet, `422 {error, requestId}` when the rules cannot be compiled |
| `POST /mandate/:id/vote` **key** | A ballot on adopting an instruction (same body as above). On a majority yes: adopted, the previous one is superseded, `MANDATE_ADOPTED` is logged |
| `GET /council/votes` | `{open, closed}` votes on instructions and payments, with violations and tallies |
| `GET /council/members/:seat` | One member: joined, ballots cast, votes awaiting them. Public, no nullifiers |
| `POST /council/join` | Proof of Human council join: one seat per nullifier (`join-council` action). The first seat founds the council; every later seat needs a single-use invite from a current seat holder (24 h expiry) |
| `POST /council/invites` **key** | A seat holder issues a single-use invite (24 h expiry, shown once). Demo: `{mocked: true, byNullifier}`. Real: a World ID proof under the join action, signal `council-invite:<seat>`, one invite per proof |
| `GET /council/seats`, `GET /council/epoch` | Current seats and the revocation epoch |
| `POST /council/revoke` **key** | A current seat holder revokes a seat: epoch +1, the nullifier is blocked from rejoining, pending payments and open payment votes are cancelled, open instruction votes are closed, one `REVOKED` entry |
| `POST /payees/:account/revoke` **key** | Revokes a registry entry at runtime (`PAYEE_REVOKED`) |
| `GET /payees` | The payee registry |
| `GET /policy` | The published agent policy and its hash. The active instruction is a sibling `mandate` field, outside the hashed policy, so adopting one does not change the policy hash |
| `GET /audit`, `GET /audit/verify` | The HCS decision log, and a from-scratch re-check of its hash chain |
| `GET /world/config` | Whether World is configured and whether MOCKED proofs are allowed |
| `POST /world/rp-context` | An RP-signed IDKit request for one server-chosen action: `{join: true}`, `{revoke: true, seat}`, `{vote: true, subject, choice}` or `{proposalId}` |
| `POST /world/verify` | Verifies the owner's World ID for one proposal (per-payment gate, used when no instruction is active) |
| `GET /world/qr.svg`, `GET /vendor/idkit.js` | QR rendering and the IDKit bundle for the pages |
| `GET /`, `/console.html`, `/mandate.html`, `/council.html`, `/member.html?seat=…`, `/report.html?proposal=<id>`, `/verify.html` | The UI |

### Audit events added for instructions and votes

`MANDATE_PROPOSED`, `VOTE` (one per ballot), `MANDATE_ADOPTED`, `MANDATE_REJECTED`, `VOTE_OPENED`, `VOTE_PASSED`,
`VOTE_FAILED`, `REFUSED_OUTSIDE_MANDATE`, `ABORTED_AFTER_VOTE` (a passed vote whose re-check fails). These come on top
of `SIGNED`, `REFUSED_*`, `PROPOSAL_CREATED`, `ABORTED_AT_EXECUTION`, `CHALLENGED`, `REVOKED` and the rest.

### Rules the code enforces

- **Instruction inside or outside** (`evaluateMandate`): the amount is at most the per-payment limit. This month's
  spend plus the amount is at most the cap (UTC calendar month, counting every payment this server signed). The payee
  is registered, or is in the listed ids. The purpose contains a listed keyword. Violations are plain sentences
  shown on the vote.
- **Inside the instruction:** no vote and no per-payment World ID, but the x402 check fee, the 0G verdict, the
  mismatch check and the payee registry still apply. With a challenge window, execution re-checks the instruction:
  it aborts if the instruction was superseded or the monthly cap has since been used up.
- **Outside the instruction:** `PENDING_VOTE`, nothing signed. A passed vote does not pay the check fee again. It
  re-checks the schedule (real mode), the revocation epoch, the mismatch check and the payee registry, then signs or
  enters the challenge window. If the re-check fails: `ABORTED_AFTER_VOTE`. A failed vote is refused.
- **Votes:** the eligible seats are the snapshot when the vote opened, so later joiners cannot vote on it. Needed =
  floor(seats / 2) + 1. A vote fails as soon as the yes side can no longer reach that. One ballot per seat per subject.
- **Concurrency:** decisions that read the monthly spend run one at a time, so two payments cannot both fit under the
  cap on the same reading.
- **Restart:** payment proposals live in server memory. On restart, a payment vote that was still open is marked
  `CANCELLED`. Seats, instructions, votes and spend survive in `.data/state.json`.
- **Limits:** request body 64 kB. Instruction text up to 1000 chars. Payee list 1-50 ids. Up to 20 purpose keywords
  of 1-40 chars. An HCS entry stays under 1000 bytes. A World ID approval lasts 5 minutes and is single use. A 0G call
  times out after 30 s.

## Verifiable by anyone

These make the agent auditable, not just correct. They are Hedera-native and need no extra service.

- **Tamper-evident decision log.** Every decision, ballot and adoption is an HCS message that carries the hash of
  the previous one (`src/auditlog.ts`). `GET /audit/verify` re-reads the topic from the mirror node and re-checks the
  chain from genesis: an edited, dropped, reordered or forged entry is reported with the entry number. The topic is
  created with the agent's submit key, so nobody else can append to it. After a restart the chain continues from the
  topic's latest entry.
- **Check it without trusting our server.** `/verify.html` is a static page that reads the topic straight from a
  Hedera mirror node and re-computes every hash in your own browser (`public/assets/chain-verify.js`, no
  dependencies). Open `/verify.html?topic=0.0.1234&network=testnet`. Each entry turns green as it is re-checked, and
  a break shows the entry number. In simulated mode, **Load simulated log** reads this agent's `/audit` instead.
- **Adopted rules are anchored.** `MANDATE_ADOPTED` carries `rulesHash` = sha256 of the canonical JSON of the rules
  (`auditlog.ts` `canonical`) and `textHash` = sha256 of the owner's words. Compare them with `GET /mandate` or
  `GET /policy`. No script recomputes `rulesHash` yet: that comparison is manual.
- **Published policy.** `GET /policy` is the rule set the agent signs under (`src/policy.ts`). Its hash is inside
  every audit entry, so each decision commits to the policy in force when it was made.
- **Evidence bundle per decision.** `GET /proposals/:id/evidence` gathers the transfer actually checked and where it
  was read from, the check, the x402 payment, the 0G request id, the schedule, the instruction result, the vote and
  the audit entry. In real mode it includes HashScan links, plus a digest over the whole bundle.
- **Replayable audit.** `npm run verify -- <proposalId> [--server http://127.0.0.1:3000]` (`src/verify.ts`) fetches the
  evidence bundle and policy. It re-computes the bundle digest, the proposal hash and World ID signal, re-reads the
  audit topic, re-checks the whole hash chain, and confirms the decision's entry and policy hash. In real mode the
  topic comes from a Hedera mirror node, not from our server. In simulated mode it reads the server log and prints
  `SIMULATED: no mirror node, reading the server log`. Any `FAIL` exits 1.
- **Discoverable paid check.** `POST /check` declares an x402 Bazaar discovery extension (`@x402/extensions`).

Considered and left out: World AgentKit. Its documented networks are World Chain and Base, not Hedera.

## Real-mode council setup

```bash
npm run preflight -- --setup --create-fee-account --create-council
# set X402_PAY_TO from the output; the treasury and member are saved to .data/council.json
npm run propose -- 0.0.<payee> 0.1 "Pay the venue deposit"   # a member schedules the transfer
# POST the printed JSON to /proposals: the agent reads the schedule back from Hedera,
# compares it to the description, pays for the check over x402, checks the instruction, and co-signs or opens a vote.
```

The treasury needs two signatures (agent and member), so a proposal does nothing until the agent signs. The agent
never signs a schedule whose on-chain transfer differs from its description, even when the request body says it
matches. A proposal without a `scheduleId` makes the server act as the member and schedule it, which keeps the demo
to one command.

Authorization rules the tests enforce: a client-supplied World ID "check" in the request body is ignored; only
approvals the server verified itself count. An approval is bound to one proposal id, expires after 5 minutes, and is
spent on the first signing. A proposal id is bound to its content on first submission. A ballot proof must carry the
signal for that subject, its exact bytes and the choice, and its nullifier must be an eligible seat. The World
environment comes from server config, so a client cannot pick `staging` or `sandbox`. With World configured, every
mock is refused. Set `COUNCIL_API_KEY` before exposing the server.

## Env vars

| Var | What it is |
| --- | --- |
| `HEDERA_NETWORK` | `testnet` (default) or `mainnet` |
| `HEDERA_ACCOUNT_ID` | Agent's Hedera account id, e.g. `0.0.123456`, from portal.hedera.com |
| `HEDERA_PRIVATE_KEY` | Its private key. Raw hex is read as ECDSA (required for x402). DER keeps its own type. `HEDERA_KEY_TYPE=ed25519` for raw ED25519 |
| `HEDERA_TREASURY_ACCOUNT_ID` | Account the proposals pay out of. `--create-council` makes a 2-of-2 treasury and saves it. The agent refuses schedules that pay out of any other account |
| `COUNCIL_PROPOSER_ACCOUNT_ID`, `COUNCIL_PROPOSER_PRIVATE_KEY` | The council member that schedules proposals. Default: read from `.data/council.json` (written by `--create-council`) |
| `HEDERA_TOPIC_ID` | HCS topic for the audit log. Created on first audit if unset (printed in the log) |
| `X402_PAY_TO` | Account that receives check fees. Defaults to the agent, which then pays itself: use `npm run preflight -- --create-fee-account` |
| `X402_PRICE_USDC` | Price of one check, default `0.01` |
| `CHECK_SERVICE_URL` | Paid check service the agent calls, default this server's `/check` |
| `AGENT_SPEND_CAP_USDC` | Agent spending cap for check fees per run, default `0.10` |
| `LARGE_PROPOSAL_TINYBARS` | Large threshold, default `50000000` (0.5 HBAR). With no instruction active, World ID is required at or above it. Inside an adopted instruction, the instruction is the approval |
| `PAYEE_REGISTRY` | Payee accounts the council may pay: JSON array of `{account, label, validFrom?, validUntil?}` or a comma list of `0.0.x`. Non-empty turns enforcement on |
| `PAYEE_REGISTRY_FILE` | Same, read from a JSON file. A runtime revocation is written back to this file. Env and demo registries are revoked in memory only |
| `REQUIRE_REGISTERED_PAYEE` | `true` enforces the registry even when it is empty (refuses every payee) |
| `CHALLENGE_WINDOW_SECONDS` | Default `0` (off). Above 0, a passing proposal is `PENDING_CHALLENGE` and signs only through `POST /proposals/:id/execute` after the window, once a re-check passes. Part of the published policy |
| `COUNCIL_API_KEY` | When set, every **key** route above needs `Authorization: Bearer <key>` or `x-api-key`. Unset: open (`auth: "open (demo)"` in `/health` and `/policy`, plus a startup warning) |
| `ALLOW_NO_0G` | `true` lets the agent sign without a 0G verdict. Default off: no verdict, no signature |
| `ZERO_G_API_KEY` | 0G Private Computer API key, `sk-` key from pc.0g.ai. Unset: SIMULATED instruction parser and template verdicts |
| `ZERO_G_BASE_URL` | Default `https://router-api.0g.ai/v1` |
| `ZERO_G_MODEL` | Default `0gm-1.0-35b-a3b` |
| `WORLD_RP_ID` | World ID RP id (`rp_...`), server only, from developer.world.org |
| `WORLD_APP_ID` | World ID app id (`app_...`), public |
| `WORLD_SIGNING_KEY` | World signing key, server only, never exposed to the client |
| `WORLD_ENVIRONMENT` | `production` (default), `staging` or `sandbox`. Server-side only |
| `X402_FACILITATOR_URL` | Default `https://x402.org/facilitator` (Official) |
| `STATE_FILE` | Seats, epoch, used approvals, instructions, votes and monthly spend. Default `.data/state.json`. Use a fresh path for a clean demo recording |
| `DEMO_PAYEE_ACCOUNT_ID`, `DEMO_NEW_PAYEE_ACCOUNT_ID` | Real-mode `npm run demo` only: the payee for in-instruction scenes, and the "new payee" for scene 11 |

How to get Hedera testnet credentials: register at portal.hedera.com, choose Testnet, create an ECDSA account. It
gives an account ID, a private key and 1,000 test HBAR. This needs a browser login: there is no verified portal API
or CLI for account creation.

Hedera SDK: the current package is `@hiero-ledger/sdk`. `@hashgraph/sdk` is the legacy name. Do not install both.

Real x402: `POST /check` is protected by `@x402/express` paymentMiddleware, with the Official facilitator, network
`hedera:testnet` and a price of $0.01 in testnet USDC `0.0.429274`. The resource server must `initialize()` first.
Verified live 2026-11-06: an unpaid `POST /check` returns HTTP 402 with a `PAYMENT-REQUIRED` header. A paid request
has not settled yet. The paying account must be associated with the token. Testnet USDC comes from faucet.circle.com.
The agent pays through `src/x402Client.ts` (`@x402/fetch` + `@x402/hedera` Exact scheme). It stays under the USDC
spending cap and never offers more than the configured price. It pays only an offer whose `payTo` is the registered
check service (`REFUSED_PAYEE_SWAP` otherwise).

0G: a key is created at pc.0g.ai after a wallet login (Dashboard, API Keys). The auditable request id is
`x_0g_trace.request_id` in the response body. It is stored on each instruction draft and each verdict, and written
to HCS.

## What is simulated / not yet verified

- **Nothing has run against real Hedera, 0G or World yet.** No credentials were available at build time. Every
  integration is written and tested against fakes (`test/`). `npm run preflight` shows what is missing, and
  `npm run ready` lists what is left.
- **Hedera:** no real x402 payment has settled, and no real Scheduled Transaction or HCS message has been written by
  this agent. The real-mode paths (schedule admin key set to the proposer, `ScheduleDeleteTransaction` on seat
  revocation, re-reading the schedule at execution and after a vote) are unit-tested against a fake chain port only.
- **0G:** instruction compiling and verdicts have run only against a stubbed endpoint. The real model's JSON output
  for `MandateRules` is unverified. Invalid output fails closed (422, no draft).
- **World ID:** proofs are verified only against a fake verifier. Joining, revoking and every ballot use the same
  `join-council` action, because nullifiers are per person, app and action. The signal (`council-join`,
  `council-revoke:<seat>`, `council-vote:<subject>:<hash>:<choice>`) keeps one proof from being replayed as another.
  **Requirement to configure, unverified:** the World Developer Portal action `join-council` must allow more than one
  verification per person. Otherwise a member can join but cannot vote or revoke.
- **`npm run demo` scenes 9-12** compile, tally and resolve votes in-process with MOCKED members (3 seats, 2 ballots).
  The HTTP routes run the same functions and are covered by `test/mandate.test.ts`. The new pages have static checks
  in `test/ui-council-pages.test.ts`. They still need a pass in a browser.
- **State is on one server.** Payment proposals are in memory, and seats, instructions, votes and spend are in a JSON
  file. Only the audit log (HCS) and the schedules are on Hedera. See `docs/judge-qa.md` for the honest limits.

## Demo rehearsal

`npm run demo` runs 12 scenes and prints `ALL 12 SCENES CORRECT` when every one behaves:

1. Routine proposal, paid check, agent signs.
2. Mismatched proposal (payee and amount differ), paid check, agent refuses.
3. Large proposal, World ID approved (MOCKED), agent signs.
4. Large proposal, World ID denied (MOCKED), agent does not sign.
5. Reuse of yesterday's World approval is refused: an approval signs one payment and is spent.
6. Swapped recipient in the 402: refused before paying, nothing spent.
7. 0G unavailable: the agent fails closed.
8. Challenge window (fake clock): the payee is revoked in the window, so execution prints
   `re-checked at execution: payee revoked, ABORTED`. A second proposal signs after the window.
9. The owner's instruction ("Pay 0.0.1001 or 0.0.1002 up to 50 HBAR each, at most 100 HBAR a month. Anything else
   goes to the council.") is compiled (SIMULATED unless keyed) and adopted 2 of 3 by MOCKED members. `MANDATE_ADOPTED`
   is logged with the rules hash.
10. A 50 HBAR payment inside it is signed with no vote and no World ID check.
11. 30 HBAR to 0.0.1003 (registered, but not in the instruction's list) opens a council vote. Two yes votes, then it
    is signed after a re-check, with no second check fee.
12. 40 HBAR to 0.0.1002 would bring the month to 120 of 100 HBAR, so a vote opens. Two no votes: refused.

The video script is in `docs/demo-script.md`. Judges' hard questions are in `docs/judge-qa.md`.

## Hedera transaction IDs

Fill with real links only after a real payment settles on testnet.
Do not put simulated ids here.

- Check payment: tx id: (none yet), HashScan: (none yet)
- HCS audit topic (MANDATE_ADOPTED entry): tx id: (none yet), HashScan: (none yet)
- Scheduled Transaction co-signed inside the instruction: (none yet)
- Scheduled Transaction co-signed after a council vote: (none yet)

## Challenge window, revocation and votes: limits

- No limit ladder was built: revoking only bumps the epoch, blocks the nullifier, cancels pending payments and
  payment votes, and closes open instruction votes.
- A World ID approval lasts 5 minutes. With a window longer than that, a large payment with no instruction active
  needs a fresh approval before execution.
- A council of one seat adopts an instruction alone (needed = 1). The quorum is a majority of the seats when the vote
  opened, not a minimum council size.
- Admission is by invite, not open: the first seat founds the council, and every later seat needs a single-use invite
  from a current seat holder (24 h expiry, shown once, `/council.html` "Invite a member"). World ID stops one person
  taking two seats; the invite decides *which* humans sit on the council. Removing another seat is a council vote
  (subject `R-<n>`, target excluded from voters, majority), never a single signature; self-removal stays immediate.
- A payment to a payee the instruction does not name goes to a council vote, including a payee with no registry
  entry at all (under an active instruction an unregistered payee is a new recipient, not a proven-bad one).
  With no instruction active, an unregistered payee is refused outright by the registry with no vote. Revoked or
  expired payees stay hard refusals, and the post-vote re-check still refuses them.
- The audit log is verified from a Hedera mirror node in real mode, never from the server's local log. The audit
  topic is created with a submit key the agent holds and an admin key the council holds (`HEDERA_TOPIC_ADMIN_KEY`,
  optional); with no admin key set the topic has no admin key and is immutable. Decision entries made under an
  instruction carry its `rulesHash`, checked against the `MANDATE_ADOPTED` entry by `npm run verify`.
- World ID nullifiers are one-time-use per action, and the store is per action, not one global set: join, ballots
  and removals all prove under the `join-council` action so the same nullifier identifies the seat, while single use
  is enforced per proof (ballot signals bind subject and choice, approvals are consumed per proposal, invites per
  proof nonce). A member who joined can still vote; a second ballot from the same seat is a 409.

## What is not in scope

No tokenization (Tokenize Anything dropped). No robot (Physical AI dropped). No earning loop (Agents That Pay for
Themselves dropped). No Continuity tracks: this is a new-project-only submission.
