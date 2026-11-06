# ETHGlobal Mumbai 2026 submission draft

Project: hedera-council-agent
Repo: https://github.com/BeastAyyG/hedera-council-agent
Deadline: Saturday Nov 7, 09:00 IST, via the Hacker Dashboard (the dashboard time wins if it differs)

## Short description
Tell it once. It guards the treasury. An AI agent holds one signing seat on a Hedera treasury council. The owner writes a spending instruction in plain words; 0G compiles it into checkable rules and a World-ID-verified council adopts them by vote. Payments inside the rules co-sign automatically; anything outside goes to a council vote. Every decision is hash-chained on HCS. Built and tested in simulated mode: 151 tests pass, demo 12/12, no real payment settled yet.

## Long description
An AI agent with a treasury key is a liability. One bad prompt, one dishonest proposer, one prompt injection, and the money is gone. Making a human approve every payment defeats the point of having an agent. This project sits between the two.

The owner writes a standing instruction once, in plain words: "Pay registered vendors up to 50 HBAR each, at most 100 HBAR a month. Anything else goes to the council." 0G Private Computer compiles it into five checkable rules. The output is validated strictly, and invalid output creates nothing. The rules are shown back as a plain checklist written by code, not by the model. A council of World-ID-verified humans adopts the rules by majority vote, and every ballot is a World ID proof bound to the exact rules hash and the choice. The adopted hash is anchored in the Hedera audit log.

After that, the agent decides alone. A payment inside the rules is co-signed with no vote. A payment outside them waits for a council vote. Before any signature, fixed code checks the transfer read back from Hedera against its description, checks the payee against the council registry, and checks the payment against the adopted rules. The agent pays a one-cent x402 check fee per payment, under a spending cap, and refuses an offer whose recipient is not the registered check service.

The AI never signs and never decides a payment. It turns words into rules that humans adopt. Code applies them. Every decision, ballot and adoption is a hash-chained HCS entry anyone can re-check in their browser or with `npm run verify`.

Honest status: everything is written and tested against fakes, 151 tests and 12 demo scenes green. No real Hedera payment has settled, no real 0G call or World ID proof has run, and no credentials were available at build time. The demo is labelled simulated wherever it is simulated, and no simulated id is presented as real.

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
The script is in docs/demo-script.md: it opens with a mismatch refusal and the World ID gate on a large payment,
then the owner writes the instruction, 0G compiles it, the council adopts it with World ID, a payment inside it signs
with no vote, a payment outside it goes to a council vote and signs, then the public verify page.

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
- [ ] UI: `original-console/` is the CODE_TANTRAFEST console, copied in at the owner's instruction (Oct 25, partly other authors, no Solidity included). Confirm with ETHGlobal or delete the folder and the `/original-console` link
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
