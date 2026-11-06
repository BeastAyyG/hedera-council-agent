# Demo video script, 2-3 minutes

Target: 2 min 30 sec, 720p or better, screen recording, human voiceover, no TTS, no sped-up footage, no phone recording. Intro under 20 seconds.

Record with real credentials if they arrive. If not, record the simulated rehearsal and say so on screen, do not present SIM ids as real.

## 0:00-0:15, intro
"An AI agent holds one signing seat on a Hedera treasury council. It pays for a check of every proposal, signs the honest ones, and refuses the ones that lie about where the money goes."
Show the repo README and the proposal list.

## 0:15-0:50, Scene 1, routine proposal signs
Run `npm run demo`, show Scene 1 only, or run the server and POST a routine proposal.
Say: "Proposal P-001, 0.1 HBAR to the venue. The agent pays $0.01 for the check, 0G writes the verdict, the transfer matches, the agent signs."
Show on screen: the 402 payment, the 0G request id, the Scheduled Transaction id, and the HashScan link if real. If simulated, say "simulated, no real chain ids yet" out loud.

## 0:50-1:20, Scene 2, mismatch refuses
Show Scene 2.
Say: "Proposal P-002 says pay the caterer, but the transfer goes to a different account for nine times the amount. The agent paid for the check, and still refused. That is the whole point, the check is not a rubber stamp."
Show the exact mismatch fields on screen.

## 1:20-2:05, Scenes 3 and 4, World ID gate
Show Scene 3, then Scene 4.
Say: "Large proposals need the owner's fresh World ID, tied to that exact proposal. Approved, the agent signs. Denied or expired, the agent does not sign, even though the transfer itself matches."
Show the World ID verify call and the denied path.

## 2:05-2:30, close
Say: "Hedera x402 pays for the check, Scheduled Transactions fix the transfer, HCS logs every decision, World ID gates the large ones, 0G writes the verdict. One agent seat, three partners, five tracks."
Show the repo URL, https://github.com/BeastAyyG/hedera-council-agent, and the track list.

## Checklist before recording
- `npm test` green, 10/10
- `npm run demo` green, all 4 scenes correct
- If real mode: .env filled, one real x402 payment settled, HashScan link copied into the README "Hedera transaction IDs" section
- Close other windows, use a clean terminal, 720p or better
- Record in one take if possible, human voice, normal speed
