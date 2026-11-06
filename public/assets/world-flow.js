// The World ID approval / council-join flow, UI-agnostic.
// Needs <script src="/vendor/idkit.js"></script> loaded before this module.
// The server signs the request, verifies the proof, pins the environment
// and spends the approval once. This file only shows a QR and waits.
//
//   const r = await runWorldFlow({ proposalId, onQr: (url, qrSvgUrl) => ..., onStatus: (text) => ... });
//   // join the council instead: runWorldFlow({ join: true, ... })
//   // r = { ok, status, data }  data from /world/verify or /council/join
//
// Events on bus: world:qr, world:waiting, world:approved, world:denied, council:joined.

import { api, bus, emit } from "./api.js";

export async function runWorldFlow({ proposalId, join = false, onQr = () => {}, onStatus = () => {} }) {
  const ctx = await api.rpContext(join ? { join: true } : { proposalId });
  if (!ctx.ok) return fail(ctx.data.error, ctx);
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
  if (!done.success) return fail(`World ID did not complete: ${done.error}. The agent does not sign.`, { ok: false, status: 0, data: {} });
  onStatus("Verifying the proof on the server…");
  const res = join
    ? await api.join({ idkitResult: done.result })
    : await api.verifyWorld({ proposalId, idkitResult: done.result });
  if (res.ok) emit(join ? "council:joined" : "world:approved", { proposalId, ...res.data });
  else emit("world:denied", { proposalId, error: res.data.error });
  return res;
}

// Demo mode (World not configured): MOCKED approval, clearly labelled by the server.
export async function runMockedFlow({ proposalId, join = false }) {
  const res = join
    ? await api.join({ mocked: true, nullifier: `demo-${crypto.randomUUID()}` })
    : await api.verifyWorld({ proposalId, mocked: true });
  if (res.ok) emit(join ? "council:joined" : "world:approved", { proposalId, mocked: true, ...res.data });
  else emit("world:denied", { proposalId, error: res.data.error });
  return res;
}

function fail(error, res) {
  emit("world:denied", { error });
  return { ...res, ok: false, data: { ...res.data, error } };
}

export { bus };
