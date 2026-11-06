# UI handoff

> **The original paper-and-red pages are in use on this branch.** `public/index.html` (Atlas) and
> `public/report.html` (report poster) are the original files from BeastAyyG/CODE_TANTRAFEST
> (`public/ecosystem.html`, `public/report-editorial.html`): markup, CSS, SVG scenery and animation are
> unchanged. Only the copy and links were edited (Aegis / IntentLock / AIP-042 became this project's), the fake
> random metrics and the external price fetch were removed, and `public/assets/live-original.js` fills in live
> data. `console.html` uses the original console's own stylesheet and components: `design/aegis-console.css` is the
> original `console/app/globals.css`, unmodified, compiled with `npm run css:console` (Tailwind CLI) into
> `public/assets/console-original.css`, and the page is built on its `app-shell`, `app-header`, `app-rail`,
> `doc-title`, `panel`, `btn`, `chip` and `mono-label` classes and the StatusPill, KeyValue and HashLine markup from
> its `ui.tsx`. After changing `console.html`, rerun `npm run css:console`. What is not copied is the original
> Next.js app itself (React, viem, ethers, Ledger, its API routes and its contract data): it is a different
> project's EVM app and cannot run against this Hedera backend.
>
> **Rule check before submitting.** Those files were written on Oct 25 2026, before the event (Nov 5-7), and
> ETHGlobal's From Scratch rule says prior project-specific "code, designs, or assets are not allowed" in
> projects entering partner prizes. They were merged here on the owner's explicit instruction (merge commit
> `6e252e7`). To go back to the redrawn pages, run `git revert -m 1 6e252e7`. The earlier redrawn
> pages are also still in history (commit `688204b`).

## The original console app is in this repo

`original-console/` is the original Next.js console, copied verbatim from CODE_TANTRAFEST (commit `a6c8497`) with only the
Solidity contracts, Hardhat config and contract tests left out (it builds and runs without them). Run it with
`npm run console:install` once, then `npm run console` (http://localhost:3380/council). Its own screens show that project's data; the added `/council` screen (original components, `console/app/council/`) shows
this project's live proposals, decisions, hashes and log verification from this server. `/original-console` redirects to it. The project's own screens (`public/`) use the same
stylesheet and component markup.

## Animations, each tied to the logic of its page

Shared layer: `public/assets/motion.css` and `motion.js` (count-up, typewriter, stagger, the agent-working run, the flow packet).
Every effect is off under `prefers-reduced-motion`, and the final state is shown instead.

| Page | What animates | What it means |
| --- | --- | --- |
| Atlas (`index.html`) | Replay timeline driven by the real proposals. A refused mismatch severs the council bridge, a large proposal waiting on World ID darkens the World ID shore. Polls every 4s: a new decision flashes the dot, shows a toast, updates the counts and replays to the new state | The map is the council's real history, and it stays live |
| Report (`report.html`) | Numerals count up to the described and actual amounts, the actual one shakes on a mismatch, the stamp scrambles in (green when signed). A decision-path strip runs a packet from the claim and stops at the stage that decided it, with a pulsing red ring on a failure | You can see where and why the agent stopped |
| Console (`console.html`) | Submitting runs an "agent working" strip in the server's real step order (read transfer, pay check, 0G verdict, compare, World ID and sign; at least 1.5s so it is readable when the simulated agent answers instantly). The decision then lands in order: record rows, each stage in turn with its score counting up, the stage that decided it flashes (red and shaking, or green), then the alert wipes in, the stamp slams and mismatched fields shake | The decision is replayed in the order it was made |
| `/council` (original console app) | The original `fade-up` stagger, plus live refresh every 5s: a decision made in the project console appears with no reload | The original design showing this project's live state |

Also: the original Atlas never applied its polygon fill (its `poly()` helper dropped the argument, so every island rendered black); that is fixed in one line.

### Judge mode and replay

On the console, a proposal that already has a decision shows a **Replay decision** button (and `window.__replay()` for tests). It re-runs the landing animation from the stored outcome: the agent-working strip runs around a no-op, then `choreograph()` lands the same data again. Nothing is resubmitted and no proposal is created.

**Judge mode** is a fixed bottom-right panel for recording the demo (`public/assets/judge.js`, styles at the end of `motion.css`). Press `J` outside an input, or open `/console.html?judge=1`, then press Start. It submits a routine proposal (signs), a mismatch (refused), and a large 0.8 HBAR proposal (blocked at the World ID gate), approves the large one, resubmits it (signs), and ends on the mismatch's Process strip with the caption "The agent paid for the check and still refused." Every step uses the console's own `api.submit`, `select` and `approve`. `?speed=0.2` scales every pause (default 1, about a minute at 1x); under `prefers-reduced-motion` no pause exceeds 300ms. `Esc` stops it. The approval is mocked only when `/world/config` says `configured:false` and `mockedAllowed:true`; otherwise it stops with "World ID needs a real scan" and the owner approves with World App. State is mirrored in `document.body.dataset.judge` (`idle`, `running`, `done`, `stopped`, `failed`, `needs-scan`).

## Where to work

The paper-and-red design is implemented on every page, matched against the rendered reference
pages: paper `#f2efe7` (the page is cream, white is only the giant "ghost" numerals `#ffffff`),
red `#e23b28`, ink `#111110`, muted `#8b857a`, hairlines `#d8d3c6`, Helvetica Neue / Arial for
type and the system mono for labels (the originals load no web fonts), full-bleed sheet with a
vertical rail, `+` registration marks and a double-hairline ticker. Everything
visual lives in `public/`; nothing outside it needs to change.

| File | Role | Reference look |
| --- | --- | --- |
| `public/assets/theme.css` | Tokens and all components (frame, rail, ticker, poster, record, process strip) | all three |
| `public/index.html` | Atlas: treasury island plus one island per proposal, bridges, legend, timeline | The Archipelago poster |
| `public/report.html` | Poster: *described* vs *actual* numerals, pixel island, stamp, red verdict | AIP-042 report poster |
| `public/console.html` | Console: headline, record table, claim/check/gate/sign strip, new proposal, join | Console, paper and red |
| `public/assets/scene.js` | SVG scenery generators: `island`, `pixelIsland`, `bridge`, `sky` | |
| `public/assets/rail.js` | Top meta row (menu and status columns) and the bottom ticker | |

Do not touch: `public/assets/api.js` and `public/assets/world-flow.js`. They are the
seam to the server. Restyle the markup around them, keep calling them.

Animation hooks already in the markup: `.packet` (the red dot on each bridge, ready to
travel), `.island` groups (`data-proposal`, `data-decision`, `data-large`), `.stamp`,
`.ticker .run` (CSS marquee, off under `prefers-reduced-motion`), `.timeline .fill`, and
the `.step[data-state]` strip (`pass`, `fail`, `wait`).

## From Scratch rule (important)

ETHGlobal's From Scratch rule says prior project-specific "code, designs, or assets are
not allowed" in a project entering partner prizes. The reference designs live in
CODE_TANTRAFEST, created Oct 25 2026, before the event (Nov 5-7), with commits by several
people and no license. So no file from it is in this repo. The look was rebuilt from a
screenshot in new code: the HTML, CSS and SVG here are all written for this project.
Replacing them with the originals would put pre-event designs in the submission, which is
the thing the rule forbids. If the look is judged too close, ask ETHGlobal before submitting.

## Server contract

All JSON. Base URL is the same origin. Use `api` from `assets/api.js`.

| Call | Returns |
| --- | --- |
| `api.health()` | `{ mode, network, x402Seller, x402Buyer, checkPrice, spendCapRemaining, zeroG, world, councilSeats, note }` |
| `api.proposals()` | `{ proposals: [{ id, purpose, amountTinybars, large, matches, decision, scheduledTxId }] }` |
| `api.proposal(id)` | `{ proposal, large, check: { matches, mismatches[], verdict }, lastOutcome, approval }` |
| `api.submit(proposal)` | the outcome below (200), or `{ error }` (400/409) |
| `GET /policy` | `{ policy, hash }` the published rules; show the hash as a "policy" chip |
| `GET /audit/verify` | `{ ok, checked, head: {seq, hash}, brokenAt, reason, source, topicId, hashscan }` re-checks the log on every call: a good "verified" badge |
| `GET /audit` | `{ report, entries[] }` the hash-chained decision log, newest last; each entry has `seq`, `prev`, `hash`, `event`, `detail` |
| `GET /proposals/:id/evidence` | one decision's evidence bundle with `digest`, payment/schedule/audit HashScan links (real mode) |
| `api.seats()` | `{ count, seats[] }` |
| `api.worldConfig()` | `{ configured, appId, environment, mockedAllowed }` |

Outcome: `{ auditSeq, auditHash, proposal, transferSource: "request"|"hedera-mirror-node", decision: "SIGNED"|"REFUSED", reason, checkMatches, paidVia, paidTxId, paidHashscan, auditTxId, scheduledTxId, scheduleAction, zeroGSource, zeroGRequestId, zeroGVerdictText, worldGateReason, approveUrl?, mode }`.
`outcome.proposal` is the proposal as checked (real mode: with the transfer read from Hedera and its `scheduleId`); show that, not what was typed. `mode: "simulated"` means ids start with `SIM-`: the UI must label them SIMULATED, never present them as real.
`zeroGSource: "simulated"` and World `source: "mocked"` must likewise be labelled.

Money: amounts are tinybars; `hbar()` in `api.js` formats them.

World ID signal: `POST /world/rp-context` for a proposal also returns `signal`, a hash of the exact transfer bytes. `world-flow.js` passes it to `IDKit.proofOfHuman({ signal })`, so the owner's approval covers this transfer only. The server recomputes the signal from its own registered proposal when verifying; the UI never supplies it.

## State machine for animation

Animation can be built entirely from events and attributes, no server changes.

Events on `bus` (`import { bus } from "/assets/api.js"`), `event.detail` in brackets:

- `proposal:submitted` [id]
- `proposal:decision` [id, outcome], the moment the agent signs or refuses
- `world:qr`, `world:waiting`, `world:approved`, `world:denied`, `council:joined`

Attributes: `document.body.dataset.state` (`loading`, `ready`, `error`),
`dataset.lastEvent`, `dataset.decision`. Rows and panels carry `data-proposal` and
`data-decision` (`SIGNED`, `REFUSED`, `PENDING`), so CSS-only animation works.

The four story beats to animate: routine proposal signs; mismatch refuses (the two
numbers diverge); large proposal waits for World ID; denied or expired, no signature.

`/verify.html` is the public, server-independent log verifier (reads the mirror node in the browser via
`/assets/chain-verify.js`; `?topic=&network=` prefill, `?mirror=http://127.0.0.1:PORT` for a local stub only).

## Run it

```bash
npm install && npm start      # http://localhost:3000, simulated mode, no keys needed
```

Demo mode shows MOCKED approvals; with the World env vars set it shows the real QR.
Edit `public/` and refresh: it is served statically, no build step.
