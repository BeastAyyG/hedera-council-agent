# ETHGlobal Mumbai 2026 submission draft

Project: hedera-council-agent
Repo: https://github.com/BeastAyyG/hedera-council-agent
Deadline: Saturday Nov 7, 09:00 IST, via the Hacker Dashboard

## Short description
An AI agent holds one signing seat on a Hedera treasury council. It pays for a check of each proposal and signs routine ones itself. It refuses any proposal whose actual transfer does not match its description, and it needs its owner's fresh World ID before signing a large one.

## Long description
A treasury proposal is a transfer plus a description of that transfer. Most agents trust the description. This agent does not. It pays $0.01 via x402 for an independent check, 0G Private Computer writes the plain-language verdict, and a deterministic checker compares the exact payee, amount, and token against the description. If they differ, the agent refuses, even though it already paid for the check.

Proposals are Hedera Scheduled Transactions plus HCS, with no smart contracts. The exact transfer is fixed when the proposal is created, and council signatures approve it. Every decision, sign or refuse, is logged to an HCS topic.

Large proposals, at or above 0.5 HBAR, need a fresh World ID check tied to that exact proposal id, validated on the backend. Approved, the agent signs. Denied or expired, it does not sign.

## Partner prizes to select, exactly 3 partners
- Hedera: AI Agents That Pay: x402 on Hedera ($6,500), "No Solidity Allowed": Build with Hedera SDKs ($2,000)
- World: World ID Agent Pass ($5,000), Best Use of IDKit ($2,500, if time allows)
- 0G: Build with 0G Private Computer ($5,000)

## Demo video
2-3 minutes, 720p or better, human voiceover, no TTS, no sped-up footage, no phone recording, intro under 20 seconds. Script in docs/demo-script.md. Scenes: 1 routine signs, 2 mismatch refuses, 3 large with World ID approved signs, 4 large with World ID denied refuses.

## What is real vs simulated
Fill this in at submission time, honestly. At build time the demo ran in simulated mode, no real Hedera payment had settled, because no testnet credentials were available. If a real payment settles before submission, paste its Hedera transaction ID and HashScan link in the README "Hedera transaction IDs" section and in the submission form, and re-record the demo in real mode. Do not present SIM-PAY, SIM-SCHED, or SIM-HCS ids as real.

## Submission checklist
- [ ] Repo public, README complete, .env never committed
- [ ] `npm test` 10/10, `npm run demo` 4/4 scenes correct
- [ ] Real x402 payment settled, HashScan link in README (or simulated mode stated plainly)
- [ ] 0G request ids shown in the demo
- [ ] World ID approved and denied paths both shown
- [ ] Demo video uploaded, 2-4 minutes, under 3 minutes for 0G
- [ ] 3 partner prizes selected on the submission form: Hedera, World, 0G
- [ ] Project submitted before Sat Nov 7, 09:00 IST
