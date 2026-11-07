# Handoff: hedera-council-agent (ETHGlobal Mumbai)

Written 2026-11-06 ~17:00 UTC. Read this first, then `docs/mandate-spec.md` (the contract) and `docs/judge-qa.md`.

## Where the code is

| What | Where |
| --- | --- |
| Working repo (all code is here) | https://github.com/AagastyaPandey/hedera-council-agent |
| `main` | Verified state, this file included. 151 tests pass, demo 12/12 |
| `hoplite/aspendos-096475b8` | Branch the work was done on; same as `main` after the PR merge |
| `wip/hardening-round2` | **Partial, unverified** snapshot of the hardening round below (10 files in `src/` + `test/mandate.test.ts`). Do not merge as is |
| Submission repo | https://github.com/BeastAyyG/hedera-council-agent: **current with AgastyaPandey main through PR #2** (commit 564ca5b, synced Nov 6). The agent has no push access; the next sync follows PR #3 |
| Fork | https://github.com/BeastAyyG/hedera-council-agent-1 (branch `ui/paper-motion`, older UI work only) |

## Run it

```
npm install
npm test            # 151 tests
npm run demo        # ends "Rehearsal: ALL 12 SCENES CORRECT"
npm run build && npm start   # http://localhost:3000 (PORT to change)
npm run ready       # submission checklist: no FAIL lines today, TODOs listed
npm run preflight   # live checks; needs credentials
npm run verify -- <proposalId>   # replay one decision against the audit log
```

Without keys everything runs in clearly labelled SIMULATED mode (SIM- ids, MOCKED World ID, SIMULATED 0G).

## What the product is

"Tell it once. It guards the treasury."

1. The owner writes a standing instruction in plain words ("Pay registered vendors up to 50 HBAR each, at most 200 HBAR a month. Anything else goes to the council.").
2. 0G compiles it into checkable rules (`src/mandate.ts`); code, not the model, writes the summary humans read. The AI never signs or decides a payment.
3. The council adopts the rules by majority vote. Each ballot is a World ID proof bound to the exact rules hash and the choice. The rules hash is anchored in the Hedera HCS audit log.
4. Payments inside the rules are co-signed automatically (Hedera Scheduled Transactions, x402-paid check). Payments outside open a council vote; majority decides.
5. Every decision is in a hash-chained log anyone can verify (`/verify.html`, `npm run verify`).

## What is done (all on `main`)

Backend (`src/`):
- Mismatch check (transfer vs description), x402 check payment under a spending cap, payee registry with 402 `payTo` check.
- 0G verdict, fail-closed in real mode; verdict hash anchored. 0G compiles standing instructions (`compileMandate`), strict validation, 422 on bad output.
- World ID: IDKit 4 flow, server-side verify, approvals bound to proposal bytes (signal), single use, 5 min TTL, nullifiers persisted. Join / revoke / ballots all use the `join-council` action with distinct signals (nullifiers are per action).
- Council: seats (one per nullifier), standing instructions (draft → vote → adopt → supersede), council votes on out-of-instruction payments (`PENDING_VOTE`), vote resolution without a second check fee, monthly spend tracking, serialized cap decisions.
- Challenge window with re-check at execution, seat revocation epoch (cancels pending work), revoke/execute race fixed, API-key auth on write routes.
- Hedera: scheduled transfers from a 2-of-2 treasury, mirror-node read-back, HCS hash-chained audit log, evidence bundles, `/audit/verify`, published policy hash.
- Demo scenes 1-12 (`src/demo.ts`).

Pages (`public/`): Atlas `/`, Console `/console.html` (scroll companion pet), Instructions `/mandate.html`, Council `/council.html` (votes, members, DEMO "Act as" picker, "Invite a member": single-use invite shown once with copy button and link, past invites with status, `?invite=` join, demo "Add a demo member" auto-invites), My seat `/member.html`, Report `/report.html`, Verify `/verify.html`. Paper/red design, animations, reduced-motion, 390px responsive.

Docs: `README.md`, `docs/submission.md`, `docs/demo-script.md` (2:40 script), `docs/judge-qa.md`, `docs/mandate-spec.md`, `docs/world-debrief.md` (has TODOs for real results).

Verified: 151/151 tests, demo 12/12, preflight no FAIL, ready no FAIL, simulated `npm run verify` 0 FAIL, full flow in headless Chrome with 0 console errors, invite flow in headless Chrome (founder joins, creates an invite, second member joins via auto-invite, third joins with the invite link, reuse refused, 0 console errors).

**Never verified:** anything against real Hedera, real 0G or real World ID (no credentials were ever provided).

## Remaining work

### Hardening items 1-5: DONE

1. **Invites.** Backend: `POST /council/invites`, `POST /council/join {invite}`, 24 h expiry, audit `SEAT_INVITED`/`SEAT_JOINED`, founder joins freely. UI: "Invite a member" on `/council.html` (create, copy once, past invites with status, `?invite=` join); demo "Add a demo member" auto-invites (the demo identity invites first, then the new member joins with that code). Same fix on `/console.html`'s join button.
2. **Removal by vote.** Self-removal stays immediate; removing another seat opens a vote (subject `R-<n>`, target excluded from voters, majority), then applies the existing revocation effects.
3. **New payee under an instruction.** Under an active instruction an unregistered payee is a violation that goes to a vote; revoked/expired payees stay hard refusals; the post-vote re-check accepts it. Demo scene 11 uses a truly new payee (0.0.9001).
4. **Policy text** (`src/policy.ts`) describes instructions, votes, invites and removal votes; large payments no longer always need World ID (an instruction or a council vote stands in).
5. **Audit completeness.** `rulesHash` is in decision entries made under an instruction and `npm run verify` checks it against `MANDATE_ADOPTED`; restart-cancelled votes are logged (`VOTE_CANCELLED_RESTART`); `MANDATE_REJECTED` is logged when a revocation closes an instruction vote.

Two research findings (GTMMAXING completion guide, batch 2) were checked against this code:

- **World ID nullifiers are one-time-use per action, so the store must be per action, not one global set.** Already true: join, ballots and removals all prove under the `join-council` action so the same nullifier identifies the seat, while single use is enforced per proof (ballot signals bind subject and choice, approvals are consumed per proposal, invites per proof nonce). Documented in `docs/mandate-spec.md` ("One proof, one use") and README limits. No code change was needed.
- **Audit topic keys and mirror-node verify.** `npm run verify` already reads from a mirror node in real mode, never the local log. The topic had no admin key: added optional `HEDERA_TOPIC_ADMIN_KEY` (`src/hedera.ts` `createTopic`, `src/keys.ts` `parsePublicKey`, `.env.example`). Submit key is the agent's key, admin key is the council's; with no admin key set the topic is created with no admin key and is immutable. Tested in `test/keys.test.ts`.

### Code still open (small)

- UI audit F-03, F-07 to F-16 (see `docs/ui-handoff.md`): dead `theme.css`, palette/stamp/button consolidation, Atlas drift, inline-fork extraction, small items. F-01, F-02, F-04, F-05, F-06 are done.

### Needs the owner (cannot be done by an agent)

1. **Deadline.** Confirm on the ETHGlobal Hacker Dashboard: one page said Fri Nov 6 19:30 IST, another Sat Nov 7 09:00 IST.
2. **Credentials** in `.env` (never commit): `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY` (ECDSA testnet, portal.hedera.com), `ZERO_G_API_KEY` (pc.0g.ai), `WORLD_RP_ID`, `WORLD_APP_ID`, `WORLD_SIGNING_KEY` (developer.world.org), optional `X402_PAY_TO`, `COUNCIL_API_KEY`. Then `npm run preflight -- --setup --create-fee-account --create-council`, run a real flow, put real HashScan links in README ("Hedera transaction IDs"), fill `docs/world-debrief.md`. Never invent a tx id or link.
3. **World Developer Portal:** the `join-council` action must allow more than one verification per person (joins, ballots and removals reuse it). Unverified.
4. **From Scratch rule:** `original-console/` and the Atlas/report designs come from the earlier CODE_TANTRAFEST project. Get ETHGlobal's OK or remove them (see `docs/submission.md` checklist, `docs/ui-handoff.md`).
5. **Push to the submission repo** `BeastAyyG/hedera-council-agent`.
6. **Video** 2-3 min, human voiceover, follow `docs/demo-script.md`; **submit** with Hedera, World and 0G prizes selected. Tick `docs/submission.md` checklist; `npm run ready` lists what is left.

## Known limits to be honest about (also in `docs/judge-qa.md`)

- Proposal and council state live in one JSON file on one server; Hedera holds schedules and the audit log.
- A majority of colluding seat holders can approve anything outside the instruction.
- Purpose keywords are matched against the proposer's own purpose text.
- Monthly spend counts every signed payment this month, including ones before the instruction was adopted.
- Real-mode schedule deletion on revocation is tested only against a fake chain.
