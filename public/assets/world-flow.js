// The World ID approval / council-join / ballot flow, UI-agnostic.
// Needs <script src="/vendor/idkit.js"></script> loaded before this module.
// The server signs the request, verifies the proof, pins the environment
// and spends the approval once. This file only shows a QR and waits.
//
//   const r = await runWorldFlow({ proposalId, onQr: (url, qrSvgUrl) => ..., onStatus: (text) => ... });
//   // join the council instead: runWorldFlow({ join: true, ... })
//   // cast a council ballot: runWorldBallot({ kind, subject, choice, onQr, onStatus })
//   // r = { ok, status, data }  data from /world/verify, /council/join or the vote route
//
// Events on bus: world:qr, world:waiting, world:approved, world:denied, council:joined, council:ballot.

import { api, bus, emit } from "./api.js";

// Server picks action + signal; the browser only relays the proof.
async function prove(context, { onQr, onStatus }) {
  const ctx = await api.rpContext(context);
  if (!ctx.ok) return { error: fail(ctx.data.error, ctx) };
  const request = await window.IDKit.request({
    app_id: ctx.data.appId,
    action: ctx.data.action,
    rp_context: ctx.data.rpContext,
    allow_legacy_proofs: true,
    environment: ctx.data.environment,
  }).preset(window.IDKit.proofOfHuman(ctx.data.signal ? { signal: ctx.data.signal } : undefined));
  onQr(request.connectorURI, api.qrUrl(request.connectorURI));
  emit("world:qr", { action: ctx.data.action });
  onStatus(`Scan with World App to prove you are human for "${ctx.data.action}".`);
  emit("world:waiting", { action: ctx.data.action });
  const done = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 180000 });
  if (!done.success) return { error: fail(`World ID did not complete: ${done.error}. Nothing was recorded.`, { ok: false, status: 0, data: {} }) };
  onStatus("Verifying the proof on the server…");
  return { result: done.result };
}

export async function runWorldFlow({ proposalId, join = false, onQr = () => {}, onStatus = () => {} }) {
  const proof = await prove(join ? { join: true } : { proposalId }, { onQr, onStatus });
  if (proof.error) return proof.error;
  const res = join
    ? await api.join({ idkitResult: proof.result })
    : await api.verifyWorld({ proposalId, idkitResult: proof.result });
  if (res.ok) emit(join ? "council:joined" : "world:approved", { proposalId, ...res.data });
  else emit("world:denied", { proposalId, error: res.data.error });
  return res;
}

// A council ballot under the join action, bound to the subject's exact bytes and the choice.
export async function runWorldBallot({ kind, subject, choice, onQr = () => {}, onStatus = () => {} }) {
  const proof = await prove({ vote: true, subject, choice }, { onQr, onStatus });
  if (proof.error) return proof.error;
  const res = await api.vote(kind, subject, { choice, idkitResult: proof.result });
  if (res.ok) emit("council:ballot", { kind, subject, choice, source: "world", ...res.data });
  else emit("world:denied", { subject, error: res.data.error });
  return res;
}

// Demo mode (World not configured): MOCKED approval, clearly labelled by the server.
export async function runMockedFlow({ proposalId, join = false }) {
  const nullifier = `demo-${crypto.randomUUID()}`;
  const res = join
    ? await api.join({ mocked: true, nullifier })
    : await api.verifyWorld({ proposalId, mocked: true });
  // The server stores mocked nullifiers with a "mock:" prefix and echoes it back; keep it for demo ballots.
  if (res.ok && join && typeof res.data.nullifier !== "string") res.data.nullifier = `mock:${nullifier}`;
  if (res.ok) emit(join ? "council:joined" : "world:approved", { proposalId, mocked: true, ...res.data });
  else emit("world:denied", { proposalId, error: res.data.error });
  return res;
}

function fail(error, res) {
  emit("world:denied", { error });
  return { ...res, ok: false, data: { ...res.data, error } };
}

export { bus };
