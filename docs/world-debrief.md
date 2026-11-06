# World ID integration debrief

Fill this in after the first real integration attempt. World requires this debrief for the Agent Pass and IDKit tracks.

## Time to first success
TODO: minutes from starting the World ID integration to the first verified proof, in real mode.

## Friction encountered
TODO: what was slow, confusing, or broken in the docs, the Agent Pass flow, IDKit, or the v4 verify API.

## Missing capability or documentation
TODO: the one thing World does not provide, or does not document, that this project needed.

## One improvement with the greatest impact
TODO: the single change that would help the next builder most.

## What was verified
- Backend verify: POST https://developer.world.org/api/v4/verify/{rp_id}
- Checks: success, action `council-sign:<proposalId>`, environment, results[0].success
- An unvalidated client response is never treated as authorization.
- Proofs are mocked by World for this event; no sandbox app is needed for the demo wiring.

## Status at build time
Template only. No real World RP ID, app ID, or signing key was available on the build machine, so the demo World ID proofs are labelled MOCKED.
