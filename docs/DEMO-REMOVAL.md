# Demo removal

How the demo version of hedera-council-agent is built, how to turn it off
with one switch, and how to delete it for good once the real integration
is verified.

Status: the demo STAYS until the real integration works. This document
describes the kill-switch (implemented, off by default) and the final
removal steps (not yet done).

## The kill-switch: REAL_ONLY=1

One environment variable, off by default.

```
REAL_ONLY=1 npm start
```

With `REAL_ONLY` unset, the app behaves exactly as today: simulated mode
with labelled demo data. With `REAL_ONLY=1`:

Server side (`src/realOnly.ts`, wired into `src/server.ts`):

- Mocked World ID proofs are refused everywhere: joins, invites, ballots,
  approvals, revocations. Every mocked branch already checked one flag
  (`allowMocked`); the switch forces that flag false. The 403 message
  names the switch and the three World credentials to set.
- The demo payee registry is gone: `DEMO_PAYEES` (0.0.1001, 0.0.1002,
  0.0.1003, 0.0.1004, 0.0.6666) is not loaded, so unknown payees are refused.
- State-changing routes fail closed with HTTP 503 and a setup-required
  body when the credentials they need are missing, instead of running on
  demo data: POST /check, POST /proposals, POST /proposals/:id/execute,
  POST /proposals/:id/challenge need HEDERA_ACCOUNT_ID and
  HEDERA_PRIVATE_KEY; POST /mandate/draft needs ZERO_G_API_KEY.
- GET /health reports `realOnly: true` and `setupRequired: { missing: [...] }`,
  where each missing item names the credential and where to get it. The
  server still starts (no crash) and still serves read routes, so the
  setup state itself is visible.
- GET /world/config reports `realOnly: true`, `mockedAllowed: false`,
  `setupRequired: true` while the World credentials are missing.
- `npm run demo` (the 12-scene rehearsal) refuses to run and exits 1.

Client side (`public/assets/real-only.js`, loaded by all nine pages):

- Every `[data-demo-only]` element is hidden: the "Load simulated log"
  button on verify.html is the one demo control that was reachable in
  the UI. The verify page also gates its unhide logic on `!health.realOnly`.
- The console "Approve (MOCKED demo)" label becomes "Approve with World
  ID" whenever mocking is off, so a disabled button never advertises a
  mocked approval.
- The council join/ballot helpers (`public/assets/council-votes.js`)
  report the setup message instead of "demo identities are disabled"
  when the switch is on.
- Judge mode (`public/assets/judge.js`) refuses to start and says so.
- When credentials are missing, a red setup banner is prepended to every
  page, listing each missing credential and where to get it. The banner
  text comes from the /health payload, never from the page.

Credentials and where to get them (also in `src/realOnly.ts`):

- HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY: Hedera Portal
  (portal.hedera.com), Testnet account, ECDSA key. The key is a secret:
  enter it through the Secure Vault (custom.hedera), never in chat.
- ZERO_G_API_KEY: 0G Private Computer console (pc.0g.ai). ETHGlobal
  teams ask at the 0G booth for credits. Secret: Secure Vault
  (custom.0g), never in chat.
- WORLD_RP_ID, WORLD_APP_ID, WORLD_SIGNING_KEY: World Developer Portal
  (developer.world.org). The signing key is server-side only and never
  reaches the browser. Secret: Secure Vault (custom.world), never in chat.
- Optional: X402_PAY_TO, the fee account, from
  `npm run preflight -- --create-fee-account`.

Verification of the switch (`test/real-only.test.ts`, 9 tests):

- /health under REAL_ONLY=1 with no credentials lists all six missing
  keys with a where-to-get line each.
- Mocked join/invite return 403 naming REAL_ONLY; /proposals, /check
  and /mandate/draft return 503 with `setupRequired: true`.
- With all six credentials set, the guards pass and nothing is mocked.
- Default mode is unchanged: a mocked join succeeds and a small
  proposal signs.
- The rehearsal exits 1 under REAL_ONLY=1.
- Headless browser check (`/tmp/realonly-browser-check.mjs`): 18/18.
  Under REAL_ONLY=1 the setup banner renders on console and verify,
  the simulated-log button stays hidden, no demo join button and no
  MOCKED label appear, 0 console errors. In default mode the simulated
  log button appears, demo join works, no banner, 0 console errors.

## Full inventory of demo surfaces

Raw grep counts on the merge6 tree (84fde48): 171 lines mention
SIM-/simulated, 121 mention demo, 175 mention mock (overlapping).
Every surface below is a demo surface; the switch gates the ones
marked [gated], the rest are labelled output that disappears once the
real paths run.

### Server: mode selection and simulated chain

- `src/hedera.ts`: `loadHederaConfig` (lines 34-46) picks simulated mode
  when HEDERA_ACCOUNT_ID or HEDERA_PRIVATE_KEY is missing. `simId`
  (line 96) makes SIM- ids. `verifyPayment` (line 119) accepts SIM-PAY-
  ids in simulated mode. Simulated branches: schedule create (line 168),
  audit log read (line 199), topic create (line 207), schedule delete
  (line 263), `simulateSign` (line 277).
- `src/server.ts`: `buildAgent` (lines 106-145) uses
  `SimulatedCheckPayer`, loads `DEMO_PAYEES`, and sets
  `requireVerdict` false in simulated mode [gated: demo payees off,
  mocked flag off]. `/health` (lines 334-360) labels simulated mode,
  the simulated check seller/buyer, topic, treasury, World and 0G
  [gated: labels change under the switch]. Revocation response
  (line 668) says "simulated: recorded only, no Hedera schedule
  existed". Mocked branches [gated]: revocation (~line 721), world
  verify (~line 961), council join (~line 999), invites (~line 1052),
  ballot auth (~line 1123). `/world/config` (line 876) reports
  `mockedAllowed`.
- `src/payment.ts`: `SimulatedCheckPayer` (line 34), `via: "simulated"`,
  SIM-PAY ids (lines 7, 16-22, 36).
- `src/zeroG.ts`: template verdict `[SIMULATED 0G verdict]` when no
  ZERO_G_API_KEY (lines 21, 48).
- `src/mandate.ts`: simulated deterministic parser fallback for
  `compileMandate` when no 0G key (lines 47, 190, 207).
- `src/council.ts`: `mode: "real" | "simulated"`, `paidVia: "simulated"`,
  simulated 0G source handling (lines 49, 78, 87, 92, 99, 108-134).
- `src/payee.ts`: `DEMO_PAYEES` (lines 33-35), source
  `"demo registry"` (lines 30, 136, 145) [gated].
- `src/world.ts`: demo mode comment (line 22), `mockedAllowed`
  (line 57), `WorldCheck` source `"mocked"` (line 190),
  `mockedWorldCheck` (lines 238-253), the mocked worldGate reason
  (lines 219-220).
- `src/store.ts`: seat source `"mocked"` (line 16).
- `src/verify.ts`: simulated-mode handling (lines 6, 157, 169).
- `src/policy.ts`: "demo registry" label (lines 17-18).
- `src/auth.ts`: "the routes stay open (demo and tests)" (line 4).
- `src/preflight.ts`: "Rerun with --create-council for the full demo"
  (line 73).
- `src/ready.ts`: README SIM- id check (lines 34-35), Demo group
  checking `docs/demo-script.md` (lines 131, 152).

### The rehearsal itself

- `src/demo.ts` (268 lines on this branch): the 12-scene demo rehearsal run by
  `npm run demo`. Uses `mockedWorldCheck`, seats `mock:demo-asha`,
  `mock:demo-bilal`, `mock:demo-chen`, `DEMO_PAYEE_ACCOUNT_ID`,
  `DEMO_NEW_PAYEE_ACCOUNT_ID`, a `demo-unreachable-key` for the
  0G-outage scene, and the SIMULATED parser for scene 9. [gated: the
  whole rehearsal refuses to run under REAL_ONLY=1.]

### Client: demo UI

- `public/assets/council-votes.js` (27 demo hits): `isDemo`, the demo
  identity store (`mock:` nullifiers), auto-invite, "Add a demo member"
  / "Join as a demo member", `runMockedFlow` join, mocked ballots,
  the demo banner [gated: mocked paths are unreachable, messages
  become setup messages under the switch].
- `public/assets/world-flow.js`: `runMockedFlow`, `demo-` nullifiers,
  the `mock:` prefix note.
- `public/assets/judge.js`: the whole file. Judge mode runs the demo
  against the live API; step 3 uses a mocked approval when World is
  not configured [gated: refuses to start under the switch].
- `public/assets/api.js`: demo comments on invite and ballot calls
  (lines 43, 56).
- `public/console.html`: "Approve (MOCKED demo)" (line 488) [gated:
  label fixed], "the request body (simulated)" (line 513), "MOCKED,
  demo only" (line 622), demo join comments and routing (lines
  654-659), footer "mocked" (line 694).
- `public/member.html`: demo browser identities (line 92), "no DEMO
  identity yet" note (line 121), demo-identity fallback (line 97).
- `public/council.html`: "mocked" seat aria-label (line 199).
- `public/mandate.html`: SIMULATED 0G badges (lines 124, 150, 302).
- `public/verify.html` (36 simulated hits): "Load simulated log"
  button (line 213) [gated: hidden under the switch], the simulated
  log note (line 215) and the whole simulated-log flow (lines 300,
  402-580).
- `public/index.html`: Atlas source label, mode 'sim'/'simulated'
  (line 668).
- `public/report.html`: "Source and simulation labels are preserved"
  (line 159).
- `public/audit.html`: "read from this agent (simulated)" (lines 90, 94).
- `public/audit-verify.html`: same (lines 90, 101).
- `public/assets/live-original.js`: one simulated mention.

### Tests that assert demo behavior

These tests prove the demo works; final removal rewrites or deletes
them. The kill-switch adds `test/real-only.test.ts` and does not
change them.

- `test/server.test.ts`: "demo mode: mocked approval signs once, then
  is spent" (line 86), "demo mode: one council seat per nullifier"
  (line 121), "World configured: mocked approvals and joins are
  refused" (line 129).
- `test/mandate.test.ts`: mocked joins and ballots (lines 65, 218,
  462, 524-525).
- `test/payee.test.ts`: DEMO_PAYEES and the demo registry (lines 13,
  73, 194-203, 273-277, 362-375).
- `test/window.test.ts`: demo payee list, SIM-SCHED- ids, mocked
  World approvals, "open (demo)" auth label, mocked revoke routes
  (lines 16, 105-113, 170, 316-326, 362-363, 389-396, 411-418,
  474-485).
- `test/council.test.ts`: 9 simulated hits. `test/ready.test.ts`:
  SIM- id checks (lines 14-21). `test/ui-council-pages.test.ts`:
  demo auto-invite and mocked join assertions (lines 80-109).
  `test/verify.test.ts`: 3 simulated hits.

### Docs

- `README.md`: 42 demo/simulated/mock mentions, including the
  "Hedera transaction IDs" section (still TODO: no real transaction
  id yet) and the simulated-mode description.
- `docs/demo-script.md`: the 2:40 demo video script (22 mentions).
- `docs/mandate-spec.md`: 20 mentions. `docs/submission.md`: 16.
- `docs/HANDOFF.md`: 10. `docs/judge-qa.md`: 9. `docs/ui-handoff.md`:
  7. `docs/world-debrief.md`: 2.
- Demo video (not in the repo):
  `~/workspace/hedera-video/hedera-council-agent-demo-160s.mp4`, 160 s,
  silent, shot on PR #2 state. It shows the simulated flow; it must
  be re-shot (or re-labelled) after removal.

## Final removal steps (do these only after the real integration is verified)

1. Flip the switch on for a full rehearsal first: run the server with
   REAL_ONLY=1 and real credentials, walk Atlas, Console, Instructions,
   Council, My seat, Report, Verify log, Audit log, Audit check end to
   end, and confirm no page shows a setup banner or a demo control.
2. Delete `src/demo.ts` and the `demo` script in package.json. Delete
   the Demo group from `src/ready.ts` (`checkDemo`).
3. Delete `SimulatedCheckPayer` from `src/payment.ts` (keep
   `X402CheckPayer` only) and the simulated branches in `src/hedera.ts`
   (`simId`, `simulateSign`, the simulated returns in `verifyPayment`,
   schedule create, audit log read, topic create, schedule delete).
4. Delete `DEMO_PAYEES` and the `"demo registry"` fallback from
   `src/payee.ts`. Delete `mockedWorldCheck` and `mockedAllowed` from
   `src/world.ts`, and the `mocked` branches in `src/server.ts`
   (revocation, world verify, council join, invites, ballot auth).
   Remove `source: "mocked"` from `src/store.ts` and `src/mandate.ts`
   seat/ballot types, and the simulated parser fallback in
   `src/mandate.ts` plus the `[SIMULATED 0G verdict]` template in
   `src/zeroG.ts`.
5. Delete the demo UI: `public/assets/judge.js` and its init in
   console.html, `runMockedFlow` in `public/assets/world-flow.js`,
   the demo identity store and auto-invite in
   `public/assets/council-votes.js`, the "Load simulated log" button
   and simulated-log flow in `public/verify.html`, the SIMULATED 0G
   badges in `public/mandate.html`, and the simulated source labels in
   `public/index.html`, `public/console.html`, `public/report.html`,
   `public/audit.html`, `public/audit-verify.html`.
6. Delete `src/realOnly.ts` and the REAL_ONLY wiring in `src/server.ts`
   and `public/assets/real-only.js`: with the demo code gone there is
   nothing left to gate, and the setup-required guards stay as plain
   credential checks. Keep `test/real-only.test.ts` only as far as it
   asserts the credential checks; rewrite the demo-behavior tests
   listed above (they assert mocked joins, mocked approvals, the demo
   registry and SIM- ids, all of which stop existing).
7. Update the docs: README (remove the simulated-mode description,
   fill "Hedera transaction IDs" with the real transaction id and
   HashScan link from the first real payment), `docs/submission.md`,
   `docs/HANDOFF.md`, `docs/mandate-spec.md`, `docs/judge-qa.md`,
   `docs/ui-handoff.md`, `docs/world-debrief.md`. Delete
   `docs/demo-script.md` and replace it with the real demo script.
8. Re-shoot the demo video on the real flow (or label the old one as
   the simulated rehearsal and do not submit it). Then delete this
   document's inventory section and keep only the removal log.
9. Note for the sibling work: the real-integration branch adds a
   DEMO_MODE=1 fallback; final removal deletes that fallback too, so
   the demo cannot come back through a second flag.
