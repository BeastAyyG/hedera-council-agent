# Demo video script, 2-3 minutes

Target: 2 min 45 sec, 720p or better, screen recording, human voiceover, no TTS, no sped-up footage, no phone recording. Intro under 20 seconds.

Record with real credentials if they arrive. If not, record the simulated rehearsal and say so on screen, do not present SIM ids as real.

## 0:00-0:15, intro (lead with the refusal)
Open on the refusal, not the payment: a terminal already showing Scene 2's `Decision: REFUSED` line.
Say: "An AI agent holds one signing seat on a Hedera treasury council. It pays for a check of every proposal and signs the honest ones. Watch what it refuses."
Then show the repo README and the proposal list.

## 0:15-0:35, Scene 1, routine proposal signs
Run `npm run demo`, show Scene 1 only, or run the server and POST a routine proposal.
Say: "Proposal P-001, 0.1 HBAR to the venue. The agent pays $0.01 for the check, 0G writes the verdict, the transfer on Hedera matches, the agent signs."
Show on screen: the 402 payment, the 0G request id, the Scheduled Transaction id, and the HashScan link if real. If simulated, say "simulated, no real chain ids yet" out loud.

## 0:35-1:00, Scene 2, mismatch refuses
Show Scene 2.
Say: "Proposal P-002 says pay the caterer, but the transfer goes to a different account for nine times the amount. The agent paid for the check, and still refused. That is the whole point, the check is not a rubber stamp."
Show the exact mismatch fields on screen.

## 1:00-1:30, Scenes 3 and 4, World ID gate
Show Scene 3, then Scene 4.
Say: "Large proposals need the owner's fresh World ID, tied to that exact proposal. Approved, the agent signs. Denied or expired, the agent does not sign, even though the transfer itself matches."
Show the console approval (QR for World App, or the labelled MOCKED button), the server verification, and the denied path.

## 1:30-1:45, Scene 5, yesterday's approval is refused
Show Scene 5 (the setup line, then the refusal).
Say: "That approval signed one payment and is spent. Presenting it again for the same proposal gets nothing: the World ID gate refuses."

## 1:45-2:10, Scene 6, the recipient was a lie
Show Scene 6, side by side with Scene 1 (same amount, same description).
Say: "The 402 response is untrusted input. Here it names a different wallet than the registered check service. The agent refuses before paying: nothing is spent, and the refusal is logged. The amount was right. The recipient was a lie."
Point out that the council's payee registry is the project's own list on Hedera, not ERC-8004 or ERC-8478.

## 2:10-2:30, Scene 7, 0G unavailable fails closed
Show Scene 7.
Say: "If 0G cannot write the verdict, the agent does not carry on without it. No verdict, no signature. Every logged decision carries the 0G request id and a hash of the verdict and the proposal."

## Optional beat, Scene 8, the re-check at execution (15 seconds, only if the video stays under 3 minutes)
Show Scene 8.
Say: "A proposal that passes every check does not sign straight away. It waits out a challenge window. Here the payee is revoked inside the window, so at execution the agent re-checks and prints: re-checked at execution, payee revoked, aborted."
The demo uses a fake clock, so say "ten minute window, simulated clock" out loud. Skip this beat rather than cut the refusal scenes.

## 2:30-2:45, close
Say: "Hedera x402 pays for the check, Scheduled Transactions fix the transfer, HCS logs every decision, World ID gates the large ones, 0G writes the verdict. One agent seat, three partners, five tracks."
Show the repo URL, https://github.com/BeastAyyG/hedera-council-agent, and the track list.

Shortcut: press J on the console (or open `/console.html?judge=1`) to run the whole demo.

## Checklist before recording
- `npm test` green, 109/109
- `npm run demo` green, all 8 scenes correct (`ALL 8 SCENES CORRECT`)
- If real mode: .env filled, one real x402 payment settled, HashScan link copied into the README "Hedera transaction IDs" section
- Close other windows, use a clean terminal, 720p or better
- Record in one take if possible, human voice, normal speed
