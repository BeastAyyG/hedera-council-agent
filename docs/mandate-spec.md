# Standing instructions and council voting: the contract

Status: implementation spec, written 2026-11-06. Backend (`src/`), pages (`public/`) and docs follow this file.
If the code and this file disagree, fix one of them; do not leave both.

## Why

The original check only compared a transfer with the proposer's own description, so a dishonest proposer who
writes both passes. And it asked a human to approve every large payment. The product is the opposite:

1. The owner writes a **standing instruction** once, in plain words:
   "Pay registered vendors up to 50 HBAR each, at most 200 HBAR a month. Anything else goes to the council."
2. **0G compiles** it into rules the code can check (`MandateRules`). The rules are shown back in plain language.
3. The **council adopts** the rules by majority vote. Every ballot is a World ID proof from a seat holder.
   The adopted rules' hash is anchored in the Hedera audit log (HCS).
4. From then on the agent decides alone. A payment **inside** the rules is co-signed with no vote. A payment
   **outside** them opens a **council vote**; a majority of World-ID-verified seats decides. Nobody votes on
   routine payments.

The AI never signs and never decides a payment. It turns words into rules a human council adopts. The deterministic
code applies the rules. Mismatch check, payee registry, x402 check fee, challenge window, re-check at execution,
seat revocation and fail-closed 0G all keep working as before.

**Audit.** Every decision is a hash-chained HCS entry. `npm run verify` reads the audit log from a Hedera
mirror node in real mode, never from the server's local log (in simulated mode there is no mirror node, so it
reads the server log and says so). Decision entries made under an instruction carry its `rulesHash`, checked
against the `MANDATE_ADOPTED` entry. The audit topic is created with a submit key the agent holds and an admin
key the council holds (`HEDERA_TOPIC_ADMIN_KEY`, optional): the agent can append but cannot rewrite history.
With no admin key set, the topic has no admin key at all, so nobody can delete or update it.

**With no active mandate, behaviour is exactly as before** (every existing test keeps passing).

## Data

```ts
// src/mandate.ts
export interface MandateRules {
  maxPerPaymentTinybars: number;          // > 0, integer
  monthlyCapTinybars: number | null;      // null: no monthly cap. Month = UTC calendar month.
  payees: "registered" | "any" | string[]; // "registered": payee registry status "registered". string[]: Hedera ids 0.0.x
  purposes: string[];                     // lowercase keywords; [] = any purpose. Match: purpose (lowercased) contains a keyword
  outsideMandate: "vote" | "refuse";      // what happens to a payment outside the rules
}

export interface MandateDraft {
  id: string;                 // "M-1", "M-2", ... never reused
  text: string;               // the owner's words, <= 1000 chars
  rules: MandateRules;
  summary: string[];          // plain-language lines, generated from rules by code (not by the model)
  source: "0g" | "simulated";
  requestId: string | null;   // 0G x_0g_trace.request_id when source is "0g"
  model: string;
  rulesHash: string;          // sha256(canonical(rules)) using auditlog.ts canonical()
  textHash: string;           // sha256(text)
  createdAt: string;
  status: "open" | "adopted" | "rejected" | "superseded";
  vote: VoteTally;
  adoptedAt?: string;
  adoptedAudit?: { auditSeq: number | null; auditHash: string | null; auditTxId: string | null };
}

export interface VoteTally {
  eligible: string[];   // seat ids that existed when the vote opened (snapshot; later joiners cannot vote on it)
  needed: number;       // floor(eligible.length / 2) + 1
  yes: number;
  no: number;
  ballots: Array<{ seat: string; choice: "yes" | "no"; at: string; source: "world" | "mocked" }>;
  status: "open" | "passed" | "failed";   // failed as soon as `no > eligible.length - needed`
}
```

Persist mandates, ballots and monthly spend in `StateStore` (new optional fields; an old state file still loads).
Spend: every SIGNED payment records `{ proposalId, amountTinybars, at }`; `spentThisMonth(now)` sums the current UTC month.

### Compiling (0G)

`compileMandate(text, zeroG)`:
- Key set: one 0G chat call (same client/headers as `zeroG.ts`, temperature 0) asking for **JSON only** in the
  `MandateRules` shape. Parse and **validate strictly** (`validateRules`). Invalid JSON or invalid rules = fail
  closed: HTTP 422 with the reason, no draft created. Record the request id.
- No key: deterministic parser `parseMandateText(text)`, `source: "simulated"`, labelled SIMULATED everywhere.
  It must handle at least: "up to N HBAR" / "max N HBAR" / "N HBAR each" (per payment), "N HBAR a month" /
  "per month" / "monthly" (cap), "registered vendors|payees" -> "registered", "any payee" -> "any", explicit
  `0.0.x` ids -> list, "for catering, venue" style purpose keywords, "refuse"/"reject anything else" ->
  "refuse", otherwise "vote". No per-payment amount found = 422 "say how much one payment may be".

`summary` is produced by code from the rules, e.g. "One payment: at most 50 HBAR", "Per month: at most 200 HBAR",
"Recipients: registered payees only", "Purposes: any", "Anything else: council vote".

### Evaluating

`evaluateMandate(rules, proposal, { spentThisMonthTinybars, payeeStatus })` -> `{ within: boolean, violations: string[] }`.
Violations are plain sentences: "45 HBAR is over the 40 HBAR per-payment limit", "would bring this month to 230 of
200 HBAR", "0.0.9001 is not a registered payee", "purpose 'party' is not one of: venue, catering".

## Decision flow (council.ts)

Unchanged up to and including the mismatch check, fail-closed 0G and the payee registry check. Then, **only when a
mandate is active**:

- within -> skip the large-amount World ID gate (the human approval is the adopted mandate) -> challenge window or
  sign, as today. Outcome `mandate: { id, rulesHash, within: true, violations: [] }`, reason starts
  `Within standing instruction M-1.`
- outside, `outsideMandate: "refuse"` -> REFUSED, audit event `REFUSED_OUTSIDE_MANDATE`.
- outside, `outsideMandate: "vote"` -> new decision **`PENDING_VOTE`**, audit `VOTE_OPENED`, nothing signed.
  Outcome carries `mandate` (with violations) and `vote: VoteTally`.

No active mandate -> today's path (World gate for large, etc.). `CouncilDecision` gains `"PENDING_VOTE"`.

A vote that passes does **not** pay the x402 fee again. Like `executePending`, it re-runs the deterministic checks
(mismatch, payee registry; in real mode re-reads the schedule) and then follows the challenge window or signs.
Audit `VOTE_PASSED`. A failed vote -> REFUSED, audit `VOTE_FAILED`. Seat revocation cancels PENDING_VOTE proposals
too (as with PENDING_CHALLENGE) and closes open mandate votes as rejected.

## Ballots

One ballot per seat per subject (a proposal id or a mandate id). Second ballot from the same seat: 409.
Only seats in `eligible` may vote: 403.

- Demo mode (`mockedAllowed`): `{ choice, mocked: true, byNullifier }`, `byNullifier` must be a mocked seat's
  stored nullifier (as in `/council/revoke`). The mocked `/council/join` response now also returns `nullifier`
  (the stored, `mock:`-prefixed value) so the browser can remember "who am I" in demo mode.
- World configured: `{ choice, idkitResult }`. Proof under action **`join-council`** (nullifiers are per action, so
  this is the only way the nullifier matches a seat) with signal
  `voteSignal(subject, choice) = "council-vote:" + subject + ":" + sha256(subjectFingerprint).slice(0,16) + ":" + choice`.
  For a proposal the fingerprint is the registered proposal fingerprint; for a mandate it is its `rulesHash`.
  So a ballot is bound to the exact proposal bytes or exact rules, and to the choice.
  Nullifier must equal an eligible seat's nullifier.

Every ballot is audited: event `VOTE`, detail `council-seat:2 voted yes on P-7 (2 of 2 needed)`.

## Admission (invites)

The first seat founds the council and joins freely. Every later seat needs a single-use invite from a current
seat holder: `POST /council/invites` (24 h expiry, audit `SEAT_INVITED`), then `POST /council/join { invite }`
(consumes the code, audit `SEAT_JOINED`). The code is a bearer token: only its public id is ever listed
(`GET /council/members/:seat` shows each invite's id, status open/used/expired, expiry and used-by). An invite
for a seat that no longer holds a seat, an expired invite and a reused invite are all refused.

- Demo mode: `{ mocked: true, byNullifier }` issues the invite; the code is shown once in the UI and never logged.
- World configured: `{ idkitResult, seat }`, a proof under the `join-council` action with signal
  `council-invite:<seat>` (`src/world.ts` `inviteSignal`). One invite per proof: the proof nonce is consumed
  (`invite:<nonce>`), so one proof cannot issue two invites.
- UI (`/council.html`, "Invite a member"): a seat holder creates an invite, sees and copies the code once,
  and sees their past invites with status. A browser that follows an invite link (`/council.html?invite=<code>`)
  joins with it. In demo mode "Add a demo member" auto-invites: the demo identity in the browser invites first,
  then the new member joins with that code in one click, so the demo join keeps working after the first seat.

## One proof, one use (World ID nullifiers)

A World ID nullifier is one-time-use per action: the same person, app and action always produce the same
nullifier, and each proof can only be verified once for that action. The nullifier store is therefore per
action, never one global set, or a member who joined could never vote. The design uses that on purpose:

- Join, ballots and removals all prove under the **`join-council`** action, so the same nullifier identifies
  the seat in each case (`src/world.ts`: "A World ID nullifier is per (person, app, action)").
- Single use is enforced per proof, not per nullifier: a ballot's signal binds it to the exact subject bytes
  and the choice, so a ballot cannot be replayed on another subject or flipped to the other choice; a per-payment
  approval is consumed under the key `<action>:<nullifier>` where the action names the proposal
  (`council-sign:<proposalId>`); an invite consumes `invite:<nonce>`, one invite per proof.
- One seat still means one ballot per subject: a second ballot from the same seat is a 409
  (`src/mandate.ts` `recordBallot`), and a replayed join proof is a 409 because the nullifier already holds a seat.

## HTTP

All POST routes below use `auth.require` (API key when configured), like the other write routes.

| Route | Body | Response |
| --- | --- | --- |
| `GET /mandate` | | `{ active: MandateDraft \| null, drafts: MandateDraft[] (newest first), spentThisMonthTinybars, monthKey: "2026-11" }` |
| `POST /mandate/draft` | `{ text }` | 201 `MandateDraft` (status open, vote opened over current seats). 400 empty/too long, 409 no seats ("Join the council first"), 422 rules could not be compiled |
| `POST /mandate/:id/vote` | ballot | `{ recorded: true, vote: VoteTally, mandate: MandateDraft }`. On pass: status adopted, previous active becomes superseded, audit `MANDATE_ADOPTED` with rulesHash and textHash |
| `POST /proposals/:id/vote` | ballot | `{ recorded: true, vote: VoteTally, outcome: CouncilOutcome }` (outcome is the resolved one when the vote closed) . 409 if the proposal is not PENDING_VOTE |
| `GET /council/votes` | | `{ open: VoteItem[], closed: VoteItem[] }`, `VoteItem = { subject, kind: "proposal" \| "mandate", title, amountTinybars?, payee?, violations?, vote: VoteTally, decision? }` |
| `GET /council/members/:seat` | | `{ seat, source, joinedAt, ballots: [{ subject, kind, choice, at }], awaiting: VoteItem[], invites: [{ id, createdAt, expiresAt, status: "open" \| "used" \| "expired", usedBy }] }` (404 unknown seat). Public: a council's votes are public |
| `POST /council/invites` | `{ mocked: true, byNullifier }` or `{ idkitResult, seat }` | 201 `{ code, id, expiresAt, by, link: "/council.html?invite=<code>" }`. One invite per proof (nonce consumed, 409 on reuse); mocked: the inviter must be a mocked seat (403). Real: unknown seat 404, proof not the seat holder's 403 |
| `POST /council/join` | `{ mocked: true, nullifier }` or `{ idkitResult }`, plus `invite` after the founder | `{ joined: true, seat }`. Founder needs no invite; later joins consume a single-use invite (403 when no invite, or the invite is invalid, already used, expired, or its issuing seat is gone; 409 when the nullifier already holds a seat) |
| `POST /world/rp-context` | `{ vote: true, subject, choice }` | `{ action: "join-council", signal: voteSignal(...) }` + rp context, 404 unknown subject |

`GET /proposals` items gain `vote` (VoteTally or null) and `mandate` (`{ id, within, violations }` or null).
`GET /policy` and `GET /health` mention the active mandate id and rulesHash (or none).

## Pages

Nav on every page: Atlas, Console, **Instructions** (`/mandate.html`), **Council** (`/council.html`),
**My seat** (`/member.html`), Report, Policy, Audit.

- `/mandate.html`: write the instruction (example chips), compile, see the rules as a plain checklist with the
  0G request id or a SIMULATED badge, the adoption vote with live tally, the active mandate with its hash and a
  monthly spend bar.
- `/council.html`: members, open votes (why each needs the council: the violations), animated yes/no tally
  against `needed`, Vote yes / Vote no (World ID QR, or the demo identity), closed votes. "Invite a member":
  a seat holder creates a single-use invite (shown once, with a copy button and the invite link) and sees their
  past invites with status; a browser that follows an invite link joins with it. Demo mode: "Act as"
  picker over this browser's mocked seats, clearly labelled DEMO, so one person can show several voters, and
  "Add a demo member" auto-invites so the demo join works after the first seat.
- `/member.html?seat=…`: one member's page: seat, joined, ballots cast, votes awaiting them (vote inline).
  Without `?seat`, use this browser's demo identity, or ask to join.
- Console and report: `PENDING_VOTE` is shown as "Waiting for the council", never as refused, with a link to
  `/council.html`.

## Demo scenes (npm run demo)

Existing 8 scenes unchanged, then:
9. Owner instruction compiled (simulated 0G unless keyed) and adopted 2 of 3 by mocked members.
10. A payment inside the instruction is signed with no vote.
11. A payment to a payee not named in the instruction opens a vote; 2 yes -> signed, without a second check fee.
12. A payment over the monthly cap opens a vote; 2 no -> refused.
