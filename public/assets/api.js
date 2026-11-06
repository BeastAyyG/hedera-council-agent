// UI <-> backend seam. Every page talks to the server ONLY through this
// module, so the visual layer can be rebuilt freely. Do not re-implement
// World ID verification in the UI: call runWorldFlow() in world-flow.js.
//
// Animation hooks: every state change fires a CustomEvent on `bus` and
// mirrors itself into document.body.dataset (see docs/ui-handoff.md).

export const bus = new EventTarget();

export function emit(name, detail = {}) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
  document.body.dataset.lastEvent = name;
}

async function call(method, path, body) {
  // State-changing routes need the API key when the server has one (stored by the console on a 401).
  const key = sessionStorage.getItem("councilKey");
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const api = {
  health: () => call("GET", "/health"),
  proposals: () => call("GET", "/proposals"),
  proposal: (id) => call("GET", `/proposals/${encodeURIComponent(id)}`),
  seats: () => call("GET", "/council/seats"),
  worldConfig: () => call("GET", "/world/config"),
  // Submit a proposal to the agent. Fires proposal:submitted and proposal:decision.
  async submit(proposal) {
    emit("proposal:submitted", { id: proposal.id });
    const r = await call("POST", "/proposals", { proposal });
    if (r.ok) emit("proposal:decision", { id: proposal.id, outcome: r.data });
    return r;
  },
  rpContext: (body) => call("POST", "/world/rp-context", body),
  verifyWorld: (body) => call("POST", "/world/verify", body),
  join: (body) => call("POST", "/council/join", body),
  qrUrl: (data) => `/world/qr.svg?data=${encodeURIComponent(data)}`,
};

export const hbar = (tinybars) =>
  `${(tinybars / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} HBAR`;

export const hashscan = (network, id) =>
  `https://hashscan.io/${network === "mainnet" ? "mainnet" : "testnet"}/transaction/${encodeURIComponent(id)}`;

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
