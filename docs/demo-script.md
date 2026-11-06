# Demo video script, 2-3 minutes

Target: 2 min 40 sec. 720p or better, screen recording, human voiceover (no TTS), normal speed, no phone recording.
Intro under 20 seconds.

**Honesty rule.** Every shot marked *SIMULATED unless keyed* shows simulated output when the keys are missing. In that
case, keep the on-screen `SIMULATED` / `MOCKED` / `DEMO` badges visible and say it out loud once in the intro. Never
present `SIM-` ids as real.

| Without this key | What is simulated on screen |
| --- | --- |
| `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` | Payment, schedule and HCS ids are `SIM-…`. `/verify.html` reads the agent's log (Load simulated log), not a mirror node |
| `ZERO_G_API_KEY` | The instruction is compiled by the deterministic parser (`SIMULATED 0G` badge, no request id). Verdicts are templates |
| `WORLD_RP_ID`, `WORLD_APP_ID`, `WORLD_SIGNING_KEY` | Members are DEMO identities with MOCKED proofs. The "Act as" picker plays several voters |

## Before recording

```bash
npm test && npm run demo          # expect: ALL 12 SCENES CORRECT
STATE_FILE=.data/video-state.json npm start   # a fresh state file: empty council, no spend this month
```

Open `/council.html` and join three members ("Join as a demo member", then "Add a demo member" twice). Real World mode
needs three people with World App instead. Leave the Instructions page empty: the video drafts the instruction live.

The demo registry (simulated mode) is enforced before the instruction. Use 0.0.1001 and 0.0.1002 as the instruction's
payees and 0.0.1003 as the "new" payee (registered, but not named in the instruction). A payee outside the registry
is refused outright, with no vote.

## 0:00-0:18 Problem (intro)
Shot: the Atlas page (`/`), then `/council.html` showing three members.
Say: "Give an AI agent your company's treasury key, and one bad prompt or one dishonest colleague can empty it. Make
a human approve every payment, and you don't need an agent. Here, you tell it once, and it guards the treasury. This
recording is in simulated mode: the badges say so."

## 0:18-0:40 The owner writes the instruction, 0G compiles it
Shot: `/mandate.html`. Type or paste:
> Pay 0.0.1001 or 0.0.1002 up to 50 HBAR each, at most 100 HBAR a month. Anything else goes to the council.

Press compile. The rules appear as a checklist: one payment at most 50 HBAR, per month at most 100 HBAR, recipients
only 0.0.1001 and 0.0.1002, purposes any, anything else goes to a council vote.
*SIMULATED unless keyed* (`SIMULATED 0G` badge; with a key, the 0G request id is shown).
Say: "The owner writes it once, in plain words. 0G compiles it into five rules that code can check. The AI never signs
and never decides a payment. If the model's output is not valid rules, nothing is created."

## 0:40-1:00 The council adopts it with World ID
Shot: `/council.html`. Under **Act as**, pick the first member and vote yes on the instruction, then the second. The
tally reaches 2 of 2 needed and the instruction becomes active. Cut to `/mandate.html`: active instruction, rules hash,
empty monthly spend bar.
*SIMULATED unless keyed* (DEMO identities and MOCKED proofs; with World keys each ballot is a World App scan).
Say: "Each council seat is one verified human. Each ballot is a World ID proof bound to these exact rules and to this
choice, so it can't be reused on anything else. A majority adopts it, and the rules hash goes into the Hedera audit
log."

## 1:00-1:20 A payment inside the rules: signed, no vote
Shot: `/console.html`. Submit payee 0.0.1001, 50 HBAR, purpose "Pay the venue balance", with the transfer the same.
The result: signed, "Within standing instruction M-1".
*SIMULATED unless keyed* (`SIM-` payment, schedule and HCS ids).
Say: "Fifty HBAR to a named vendor. The agent pays a one-cent x402 check fee, the transfer matches, the payee is
registered, and it's inside the rules. It co-signs the Hedera Scheduled Transaction. Nobody voted, and nobody had to."

## 1:20-1:50 A payment outside the rules: council vote, then signed
Shot: `/console.html`. Submit 0.0.1003, 30 HBAR, "Pay the new AV vendor". The result: waiting for the council, with
the reason "0.0.1003 is not one of the allowed payees". Cut to `/council.html`: the open vote shows that violation.
Act as two members and vote yes. The payment is signed. Optionally show `/member.html?seat=council-seat:1` with the
ballots cast.
*SIMULATED unless keyed.*
Say: "A vendor the instruction doesn't name. The agent doesn't refuse it and doesn't guess. It asks the council. Two
yes votes, the agent re-checks everything, and signs, without paying for the check a second time."

## 1:50-2:15 Monthly cap exceeded: vote, refused
Shot: `/console.html`. Submit 0.0.1002, 40 HBAR, "Pay the caterer". Waiting for the council: "would bring this month
to 120 of 100 HBAR". On `/council.html`, two members vote no, and the payment is refused. Cut to the spend bar on
`/mandate.html` (80 of 100 HBAR).
*SIMULATED unless keyed.*
Say: "This vendor is allowed, but this payment would break the monthly cap. The council says no, so the agent doesn't
sign. A dishonest proposer can't write their way around this: the rules belong to the owner and the council, not to
whoever submits the payment."

## 2:15-2:40 Anyone can verify it, close
Shot: `/verify.html`. Simulated: **Load simulated log**; real: enter the HCS topic id. The entries turn green one by
one: MANDATE_PROPOSED, VOTE, MANDATE_ADOPTED, SIGNED, VOTE_OPENED, VOTE_PASSED, VOTE_FAILED. Optionally show
`npm run verify -- <proposalId>` in a terminal.
*SIMULATED unless keyed* (the simulated log comes from the agent. Real mode reads a Hedera mirror node in your
browser).
Say: "Every instruction, ballot and payment is a hash-chained entry on Hedera, and this page re-checks the whole chain
in your browser. Hedera holds the money and the record, World ID makes each vote one human, and 0G turns words into
rules. Tell it once. It guards the treasury."
Show the repo URL: https://github.com/BeastAyyG/hedera-council-agent

## Fallback: terminal only
If the UI misbehaves, record `npm run demo` and narrate scenes 9-12 with the same lines. Scene 9: compile and adopt.
Scene 10: inside, signed. Scene 11: new payee, 2 yes, signed with "Check fee paid during the vote: $0.00". Scene 12:
over the cap, 2 no, refused. Finish on the `/verify.html` shot.

## Optional beats (only if under 3 minutes)
- Scene 2 of `npm run demo` (10 s): a transfer that does not match its description is refused, even after paying for
  the check.
- Scene 7 (10 s): 0G unavailable, so the agent fails closed.

## Checklist before recording
- `npm test` green, `npm run demo` prints `ALL 12 SCENES CORRECT`
- A fresh `STATE_FILE`, three members joined, no instruction yet
- Real mode: `.env` filled, one real x402 payment settled, and its HashScan link copied into the README "Hedera
  transaction IDs" section
- Clean browser window, 720p or better, one take if possible, human voice, normal speed
