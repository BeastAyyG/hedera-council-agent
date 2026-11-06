# ETHGlobal Mumbai 2026 submission draft

Project: hedera-council-agent
Repo: https://github.com/BeastAyyG/hedera-council-agent
Deadline: Saturday Nov 7, 09:00 IST, via the Hacker Dashboard

## Short description
An AI agent holds one signing seat on a Hedera treasury council. It pays for a check of each proposal and signs routine ones itself. It refuses any proposal whose actual transfer does not match its description, and it needs its owner's fresh World ID before signing a large one.

## Long description
A treasury proposal is a transfer plus a description of that transfer. Most agents trust the description. This agent does not. It pays $0.01 in testnet USDC over x402 for an independent check, 0G Private Computer writes the plain-language verdict, and a deterministic checker compares the exact payee, amount, and token against the description. If they differ, the agent refuses, even though it already paid for the check.

Optional challenge window (`CHALLENGE_WINDOW_SECONDS`, off by default): a proposal that passes every check waits, and executes only after a re-check at execution (mismatch check, payee registry, seat-revocation epoch, World ID approval still unexpired). A council seat holder can be revoked, which cancels every pending proposal. These are simulated in the demo (fake clock); the real Hedera ScheduleDelete has not been run.

Two more refusals: the agent pays only an x402 offer whose payTo is the registered check service wallet (the 402 response is untrusted, so a swapped recipient is refused before anything is paid), and it signs only to payees in the council's own payee registry (this project's list, not ERC-8004 or ERC-8478). It fails closed without a 0G verdict, and every logged decision anchors the proposal hash, the 0G request id and a hash of the verdict.

Proposals are Hedera Scheduled Transactions plus HCS, with no smart contracts. A council member schedules the exact transfer out of a 2-of-2 treasury, the agent reads it back from the mirror node and checks what it will really execute, and its ScheduleSign is the second signature. Every decision, sign or refuse, is logged to an HCS topic.

Every decision is a hash-chained HCS entry that commits to the agent's published policy, and anyone can re-verify the whole log from the mirror node at /audit/verify. The paid check is discoverable by other agents through x402 Bazaar.

Large proposals, at or above 0.5 HBAR, need a fresh World ID check tied to that exact proposal id, validated on the backend. Approved, the agent signs. Denied or expired, it does not sign.

## Partner prizes to select, exactly 3 partners
- Hedera: AI Agents That Pay: x402 on Hedera ($6,500), "No Solidity Allowed": Build with Hedera SDKs ($2,000)
- World: World ID Agent Pass ($5,000), Best Use of IDKit ($2,500, if time allows)
- 0G: Build with 0G Private Computer ($5,000)

## Demo video
2-3 minutes, 720p or better, human voiceover, no TTS, no sped-up footage, no phone recording, intro under 20 seconds. Script in docs/demo-script.md. Scenes: 1 routine signs, 2 mismatch refuses, 3 large with World ID approved signs, 4 large with World ID denied refuses, 5 yesterday's World approval refused, 6 swapped 402 recipient refused before paying, 7 0G unavailable fails closed. Lead with the refusal, not the payment.

## What is real vs simulated
Fill this in at submission time, honestly. At build time the demo ran in simulated mode, no real Hedera payment had settled, because no testnet credentials were available. If a real payment settles before submission, paste its Hedera transaction ID and HashScan link in the README "Hedera transaction IDs" section and in the submission form, and re-record the demo in real mode. Do not present SIM-PAY, SIM-SCHED, or SIM-HCS ids as real.

## Before you submit

Run `npm run ready`. It prints PASS / TODO / FAIL by group and exits 1 only on FAIL.

| Command | What it tells you |
| --- | --- |
| `npm run ready` | Git clean and pushed, credentials present (names only), HashScan links in README, no SIM- ids, World debrief filled, unchecked items below, demo reminders |
| `npm run preflight` | Live checks of Hedera, x402 facilitator, 0G, World ID (needs credentials) |
| `npm test` | Unit and HTTP tests |
| `npm run demo` | The eight demo scenes |

## Submission checklist
- [x] UI: `original-console/` (CODE_TANTRAFEST console, copied in Oct 25) was REMOVED in the cleaned sync to BeastAyyG (Nov 6, 21:30 IST) for the From Scratch rule. It stays on the AgastyaPandey side only.
- [x] UI: the Atlas and report pages are the fresh-drawn versions (commit 688204b), not the original CODE_TANTRAFEST designs. The original pages were reverted in the cleaned sync to BeastAyyG (Nov 6, 21:30 IST).
- [x] Repo public, README complete, .env never committed
- [x] `npm test` all passing, `npm run demo` 8/8 scenes correct
- [x] `npm run preflight` has no FAIL lines
- [ ] `npm run verify -- <id>` has no FAIL lines for a demo proposal (real mode: read from the mirror node). Simulated mode: 0 FAIL for a signed and a refused proposal; re-run once credentials are set
- [ ] Real x402 payment settled, HashScan link in README (or simulated mode stated plainly)
- [ ] 0G request ids shown in the demo
- [ ] World ID approved and denied paths both shown
- [ ] Demo video uploaded, 2-4 minutes, under 3 minutes for 0G
- [ ] 3 partner prizes selected on the submission form: Hedera, World, 0G
- [ ] Project submitted before Sat Nov 7, 09:00 IST
