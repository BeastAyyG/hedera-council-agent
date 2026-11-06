# Judge Q&A: the hard questions, answered from the code

Every answer points at the code that backs it. Where the answer is "we don't", it says so.
Status for all of it: **written and tested against fakes. Nothing has run against real Hedera, 0G or World yet.**

## Why would a company trust an agent with its treasury?

It doesn't hold the treasury alone. The treasury is a 2-of-2 threshold key (`npm run preflight -- --create-council`).
A council member schedules the exact transfer as a Hedera Scheduled Transaction, and the agent can only add the second
signature (`src/chain.ts` `HederaChain`, `src/council.ts` `processProposal` step 5). Before it signs, fixed code
decides:

1. the transfer read back from the mirror node matches its description (`src/checker.ts` `checkProposal`; in real
   mode the transfer comes from Hedera, never from the request: `processProposal` step 0, `src/chain.ts`
   `scheduleProblem`);
2. a 0G verdict exists, or the agent fails closed (`src/council.ts` `verdictProblem`);
3. the payee is in the council registry (`src/payee.ts` `PayeeRegistry`);
4. the payment is inside the rules the council adopted (`src/mandate.ts` `evaluateMandate`). If it isn't, the payment
   goes to a council vote.

The agent's discretion is zero. What it does have is a standing instruction that humans wrote and adopted, plus a
public log of everything it did.

## What if the AI is wrong, or prompt-injected?

The model never decides a payment. It does two things, and neither one can move money:

- **It compiles the owner's instruction into rules** (`src/mandate.ts` `compileMandate`). The output must be one JSON
  object with exactly five fields, valid ranges and real account ids (`validateRules`). Anything else is a 422 with no
  draft: it fails closed. The plain-language summary that members read is generated **by code from the rules**
  (`summarize`), not by the model, so a model cannot show "50 HBAR" while the rules say 5,000. The council votes on
  those rules, and the ballot signal binds the exact `rulesHash` (`voteSignal`). A wrong compile is visible before
  adoption and does nothing until a majority adopts it.
- **It writes a verdict text for each check** (`src/zeroG.ts` `zeroGVerdict`). The decision reads only whether a
  verdict exists (`verdictProblem` looks at `verdict.source`), never what it says. Text injected through a proposal's
  purpose can change the wording of a verdict, not the decision.

We do not verify 0G attestations ourselves. Requests send `X-0G-Provider-Trust-Mode: verified`, and we record the
`x_0g_trace.request_id`.

## What if the proposer lies?

This was the old hole. The check used to compare a transfer only with the proposer's own description, so a proposer
who wrote both always passed. Now:

- **Transfer vs description:** any difference in payee, amount or token is refused, even after the check fee is paid
  (`checkProposal`, `REFUSED_MISMATCH`). In real mode the transfer is read from the Scheduled Transaction on Hedera.
- **Transfer vs the owner's rules:** `evaluateMandate` uses the *actual transfer's* payee and amount against the
  adopted per-payment limit, the monthly cap and the allowed payees. The proposer cannot change those rules.
- **Splitting a large payment into small ones** is bounded by the monthly cap (`StateStore.spentThisMonth`). Decisions
  that read the spend are serialized, so two payments cannot both fit on the same reading (`src/server.ts`
  `serialized`).
- **Honest limit:** the *purpose* is the proposer's own text. Purpose keywords in an instruction are a weak control,
  so amounts, payees and the cap are the real ones.

## What if a council member is malicious or compromised?

- **One member cannot pass a vote** on a council of three or more. Needed = floor(seats / 2) + 1 (`neededFor`), one
  ballot per seat per subject (`castBallot`), and the eligible voters are the seats when the vote opened (`openTally`).
- **Revocation** (`POST /council/revoke`): a seat holder proves who they are, the epoch goes up, the nullifier can
  never rejoin (`StateStore.revokeSeat`), every pending payment and open payment vote is cancelled, and open
  instruction votes close. A payment voted through earlier is re-checked against the epoch before it signs
  (`src/council.ts` `resolveVote`, `src/challenge.ts` `recheckAtExecution`).
- **Challenge window** (`CHALLENGE_WINDOW_SECONDS`): passing payments wait, can be challenged
  (`POST /proposals/:id/challenge`), and are fully re-checked at execution (`executePending`). For payments inside
  the instruction, that includes "is the instruction still in force, and is the cap still free?"
- **Honest limits:** any *single* seat holder can revoke *any* seat, with no vote, so a compromised member can also
  remove honest ones (each one is a public `REVOKED` entry, and the route needs the API key). On a council of one or
  two seats, the majority is everyone. Revoking a seat does not switch off an instruction that is already adopted.
  It stays active until a new one is adopted, and there is no route to deactivate one without a replacement.

## Sybil: can one person take several seats?

No. A seat is a World ID Proof of Human under the `join-council` action, verified by the server through the v4 API
with the environment pinned server-side (`src/world.ts` `verifyWorldProof`). It takes one seat per nullifier, and a
revoked nullifier stays blocked (`StateStore.addSeat`). MOCKED joins exist only when World is not configured and
never on mainnet (`mockedAllowed`).

**Honest limit:** `POST /council/join` has no invite list. World ID stops one human from taking two seats, but it
does not decide *which* humans sit on the council. A production version needs an admission rule, for example the
owner or a council vote admitting each seat.

## What if a majority colludes?

Then they control the treasury, within what the agent can see. A majority can adopt any instruction and approve any
out-of-rules payment. That is what a council is. What we add is that it cannot happen quietly. Every draft, ballot,
adoption and payment is a hash-chained HCS entry (`src/auditlog.ts` `sealEntry`, `verifyChain`) that anyone can
re-check (`/verify.html`, `npm run verify`). A challenge window gives time to react. A vote cannot override the fixed checks either.
After a passed vote, `resolveVote` re-runs the mismatch check, the payee registry, the epoch and (in real mode) the
on-chain schedule, and aborts with `ABORTED_AFTER_VOTE` if any of them fails.

## Can a ballot be replayed or moved?

Ballots are World ID proofs under `join-council` (nullifiers are per action, so this is the only way the nullifier
matches a seat). The signal is `council-vote:<subject>:<first 16 hex of sha256(fingerprint)>:<choice>`
(`src/mandate.ts` `voteSignal`). The fingerprint is the proposal's registered bytes, or the instruction's `rulesHash`.
The server derives the expected signal itself and checks it (`src/server.ts` `authBallot`). So:

- a "no" proof cannot be cast as "yes";
- a join proof cannot be cast as a ballot;
- a ballot for one payment or one set of rules cannot be used on another;
- a second ballot from the same seat on the same subject is a 409.

All of this is in `test/mandate.test.ts` ("World configured: ballots are World ID proofs…"), against a fake World
verifier.

**Requirement, unverified:** the World Developer Portal must allow more than one verification per person for
`join-council`, because joining, every ballot and revocation share that action.

## What if 0G is down?

- **Compiling an instruction:** the draft is refused (422, no draft). Nothing changes.
- **Paying:** when a key is set and the call fails, or in real Hedera mode with no key, every payment is refused with
  `REFUSED_NO_VERDICT`, inside the instruction or not (`verdictProblem`; demo scene 7). Treasury payments pause until
  0G is back. `ALLOW_NO_0G=true` overrides this, and the override is in the published policy and in each log entry.

## What is on-chain and what is off-chain?

| On Hedera (real mode) | Off-chain, on our one server |
| --- | --- |
| Scheduled Transactions: the exact transfer bytes, and who signed | Payment proposals and their outcomes: **in memory** (a restart loses them, and open payment votes become `CANCELLED`) |
| HCS audit topic: every decision, ballot (`VOTE`), `MANDATE_PROPOSED`, `MANDATE_ADOPTED` (with `rulesHash`, `textHash`), revocation, hash-chained | Seats, epoch, used approvals, instructions (text and rules), vote tallies, monthly spend: `.data/state.json` (`src/store.ts`) |
| x402 check fees in testnet USDC (HTS) | World ID verification (World's API), 0G calls (0G's API) |

The server is trusted to tally votes and apply the rules. The HCS log makes its claims checkable after the fact,
but there are limits:

- The log records that the server accepted a ballot from a seat. It does not contain the World ID proof itself.
- Payment decisions name the instruction id but do not carry its `rulesHash` in the HCS entry (it is in the outcome
  and in the evidence bundle).
- No script recomputes `rulesHash` from `GET /mandate` and compares it with `MANDATE_ADOPTED`. That check is manual.

There are no smart contracts.

## Why Hedera?

Scheduled Transactions plus threshold keys give us a multisig where the exact transfer is fixed on chain before
anyone signs, with no Solidity. HCS gives a cheap, ordered, public log with mirror nodes, so `/verify.html` can
re-check it in a browser. x402 on Hedera lets the agent pay a cent per check with no human involved.

## Why World ID?

A council vote means something only if each seat is a different human. World ID gives one nullifier per person per
action, and the signal lets us bind each proof to one exact payment or rule set and one choice. Without it, "majority
of the council" could be one person with three browsers.

## Why 0G?

The owner's instruction is a company's spending policy. 0G Private Computer compiles it without us running a model,
and each compile and verdict has a traceable request id that we log. The design does not depend on trusting the
model, which is why it is safe to use one: humans adopt its output, and code applies it.

## What is simulated today?

Everything that touches a partner network:

- Hedera: `SIM-` payment, schedule and HCS ids. No real x402 payment has settled.
- 0G: a deterministic parser compiles instructions (`parseMandateText`, labelled `SIMULATED 0G`), and verdicts are
  labelled templates.
- World: MOCKED joins, approvals and ballots. They are labelled, allowed only when World is not configured and not on
  mainnet. The council page's "Act as" picker is DEMO only.

`/health` and every outcome say which parts are real. `npm run ready` lists what is left before submission.

## Known limitations (all of them, in one place)

1. Nothing has run against real Hedera, 0G or World. The real-mode paths are tested against fakes only.
2. State is on one server: proposals are in memory, and the rest is in a JSON file. A restart cancels open payment
   votes, and that cancellation is not written to the audit log.
3. Anyone with World ID can join the council: there is no admission rule.
4. Any single seat holder can revoke any seat, with no vote.
5. A council of one seat adopts an instruction alone. There is no minimum council size.
6. An adopted instruction can only be replaced, not switched off, and revocation does not deactivate it.
7. Purpose keywords are checked against the proposer's own purpose text.
8. The monthly spend is this server's record of payments it signed (UTC calendar month), including payments signed
   before the instruction was adopted.
9. Ballot proofs are not in the audit log, and payment decisions do not anchor the instruction's `rulesHash`.
10. The hashed policy (`src/policy.ts`) still says large payments need a per-payment World ID approval. The instruction
    exception lives in the `mandate` field next to it, which is outside the hash, so the policy hash does not change
    on adoption.
11. In the demo real-mode setup, the agent key and the council member key (`.data/council.json`) are on the same
    server. A real deployment keeps the member key elsewhere.
12. One shared API key (`COUNCIL_API_KEY`) guards the write routes, including ballots. The pages keep it in
    `sessionStorage`.
13. World Developer Portal: `join-council` must allow repeat verifications per person (unverified).
