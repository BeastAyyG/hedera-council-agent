# ETHGlobal Mumbai 2026 submission draft

Project: hedera-council-agent
Repo: https://github.com/BeastAyyG/hedera-council-agent
Deadline: Saturday Nov 7, 09:00 IST, via the Hacker Dashboard (the dashboard time wins if it differs)

## Short description
Tell it once. It guards the treasury. The owner writes a standing instruction in plain words. 0G compiles it into
rules that code can check, and a council of World-ID-verified humans adopts them by vote, anchored on Hedera. The
agent co-signs payments inside the rules automatically and sends everything else to a council vote.

## Long description
An AI agent that holds a treasury key is a liability. A bad prompt, a dishonest colleague or a prompt injection, and
the money is gone. Asking a human to approve every payment defeats the point of an agent. This project sits between
the two.

**Tell it once.** The owner writes a standing instruction: "Pay registered vendors up to 50 HBAR each, at most 200 HBAR
a month. Anything else goes to the council." 0G Private Computer compiles it into five fields of `MandateRules`
(per-payment limit, monthly cap, payees, purposes, what to do outside). The output is validated strictly, and invalid
output fails closed. The rules are shown back as a plain checklist written by code, not by the model. The AI never
signs and never decides a payment. It only turns words into rules that humans read.

**The council adopts it.** Council seats are one per human, joined with World ID Proof of Human. The instruction is
adopted by majority vote, and every ballot is a World ID proof whose signal binds it to the exact rules hash and to the
choice. The adopted rules hash is written to the Hedera HCS audit log (`MANDATE_ADOPTED`).

**It guards the treasury.** A council member schedules each payment as a Hedera Scheduled Transaction out of a 2-of-2
treasury, so the exact transfer is fixed on chain before anyone signs. The agent reads it back from the mirror node,
pays a $0.01 x402 check fee in testnet USDC, gets a 0G verdict, and runs fixed checks: the transfer must match its
description, the payee must be in the council registry, and the payment must be inside the adopted rules. Inside the
rules, the agent adds the second signature, with no vote. Outside them (over the limit, over the monthly cap, or a
payee the instruction does not name), the payment waits for a council vote. A majority of verified humans decides. A
passed vote re-checks everything without paying the fee again, then signs.

**This fixes the old hole.** The first version compared a transfer only with the proposer's own description, so a
dishonest proposer who wrote both passed. Now the amount and the recipient are checked against the owner's adopted
rules, which the proposer cannot change.

**Anyone can check it.** Every decision, ballot and adoption is a hash-chained HCS entry that commits to the
published policy. `/verify.html` re-checks the chain in your own browser from a Hedera mirror node, and
`npm run verify -- <id>` replays one decision. Safety nets from the first version still apply: a refusal on any
mismatch, fail-closed 0G, an x402 payee-swap refusal, an optional challenge window with a re-check at execution, and
seat revocation that cancels pending payments.

## Partner prizes to select, exactly 3 partners
- Hedera: AI Agents That Pay: x402 on Hedera ($6,500), "No Solidity Allowed": Build with Hedera SDKs ($2,000)
- World: World ID Agent Pass ($5,000), Best Use of IDKit ($2,500, if time allows)
- 0G: Build with 0G Private Computer ($5,000)

### Hedera: what is used and why it is load-bearing
- **Scheduled Transactions** (`src/chain.ts`, `src/hedera.ts`): the treasury is a 2-of-2 threshold key. A member
  schedules the exact transfer, and the agent's `ScheduleSign` is the second signature. The agent checks the transfer
  read back from the mirror node (`src/mirror.ts`), not the one in the request. Without the agent's signature, nothing
  moves.
- **HCS** (`src/auditlog.ts`): the hash-chained audit log, including the `MANDATE_ADOPTED` anchor (rules hash and text
  hash), every ballot (`VOTE`), and every sign or refusal. The topic has the agent's submit key. `/verify.html` reads
  it from a mirror node.
- **x402 on Hedera** (`src/x402Client.ts`, `src/payment.ts`, `POST /check` with `@x402/express`, Official
  facilitator): the agent pays $0.01 testnet USDC (HTS) for a check of each payment, with no human approving. It stays
  under a USDC cap, refuses offers above the price, and refuses an offer whose `payTo` is not the registered check
  service. A passed council vote does not pay again.
- `@hiero-ledger/sdk`, no Solidity anywhere.
- Status: written and tested against fakes. No real payment has settled yet (README "Hedera transaction IDs").

### World: what is used and why it is load-bearing
- **Proof of Human council seats** (`POST /council/join`, `src/world.ts`): one seat per nullifier, verified on the
  server with the v4 verify API and the environment pinned server-side. Votes are majorities of humans, so World ID is
  what makes them mean anything.
- **Ballots are World ID proofs** (`src/server.ts` `authBallot`, `src/mandate.ts` `voteSignal`): action
  `join-council`, so the nullifier matches the seat. The signal is
  `council-vote:<subject>:<sha256(fingerprint) prefix>:<choice>`, so a proof cannot be moved to another payment,
  other rules, or the other choice.
- **Human-in-the-loop for the agent** (Agent Pass): the agent signs out-of-rules payments only after a majority of
  verified humans approves that exact transfer. With no instruction active, a large payment needs the owner's
  per-payment World ID approval (`council-sign:<proposalId>`, 5 minutes, single use).
- **Revocation** (`POST /council/revoke`): a seat holder's proof under the same action, with signal
  `council-revoke:<seat>`.
- **Requirement, unverified:** the `join-council` action must allow more than one verification per person in the
  Developer Portal, because join, ballots and revocation share it. Not yet tried against World. Debrief:
  `docs/world-debrief.md`.

### 0G: what is used and why it is load-bearing
- **Compiles the owner's instruction** (`src/mandate.ts` `compileMandate`): one Private Computer call at temperature
  0 returns `MandateRules` JSON. The `x_0g_trace.request_id` is stored on the draft and in the `MANDATE_PROPOSED`
  entry. Strict validation (`validateRules`): exactly five fields and ranges. Invalid output is a 422 and no draft
  is created. 0G turns intent into rules. Humans adopt them, and code applies them.
- **Writes the verdict for each payment check** (`src/zeroG.ts`). The agent fails closed without it (real mode, or
  whenever a key is set and the call fails).
- Without a key: a deterministic SIMULATED parser and template verdicts, labelled everywhere. Not yet run with a real
  key.

## Demo video
2-3 minutes, 720p or better, human voiceover, no TTS, no sped-up footage, no phone recording, intro under 20 seconds.
The script is in docs/demo-script.md: problem, the owner writes the instruction, 0G compiles it, the council adopts
it with World ID, a payment inside it signs with no vote, a payment outside it goes to a council vote and signs, a
payment over the monthly cap goes to a vote and is refused, then the public verify page.

## What is real vs simulated
Fill this in at submission time, honestly. At build time everything ran in simulated mode. No real Hedera payment
had settled, no real 0G call or World proof had run, and no credentials were available. If a real payment settles
before submission, paste its Hedera transaction ID and HashScan link in the README "Hedera transaction IDs" section
and in the submission form, then re-record the demo in real mode. Do not present SIM-PAY, SIM-SCHED or SIM-HCS ids as
real. Say on screen that 0G is SIMULATED and that World identities are MOCKED when they are.

## Before you submit

Run `npm run ready`. It prints PASS / TODO / FAIL by group and exits 1 only on FAIL.

| Command | What it tells you |
| --- | --- |
| `npm run ready` | Git clean and pushed, credentials present (names only), HashScan links in README, no SIM- ids, World debrief filled, unchecked items below, demo reminders |
| `npm run preflight` | Live checks of Hedera, x402 facilitator, 0G, World ID (needs credentials) |
| `npm test` | Unit and HTTP tests |
| `npm run demo` | The twelve demo scenes |

## Submission checklist
- [x] UI: `original-console/` (CODE_TANTRAFEST console) was REMOVED in the cleaned syncs to BeastAyyG (Nov 6, 21:30 and 23:00 IST). It stays on the AgastyaPandey side only.
- [ ] UI: the Atlas and report pages are the original CODE_TANTRAFEST designs (Oct 25, before the event). Confirm with ETHGlobal that this satisfies From Scratch, or revert the UI merge (docs/ui-handoff.md)
- [x] Repo public, README complete, .env never committed
- [x] `npm test` all passing, `npm run demo` 12/12 scenes correct
- [x] `npm run preflight` has no FAIL lines
- [ ] `npm run verify -- <id>` has no FAIL lines for a demo proposal (real mode: read from the mirror node). Simulated mode: 0 FAIL for a signed and a refused proposal; re-run once credentials are set
- [ ] Real x402 payment settled, HashScan link in README (or simulated mode stated plainly)
- [ ] 0G request ids shown in the demo
- [ ] World ID approved and denied paths both shown
- [ ] Demo video uploaded, 2-4 minutes, under 3 minutes for 0G
- [ ] 3 partner prizes selected on the submission form: Hedera, World, 0G
- [ ] Project submitted before Sat Nov 7, 09:00 IST
