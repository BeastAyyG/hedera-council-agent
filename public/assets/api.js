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
  setup: () => call("GET", "/setup"),
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
  // A seat holder issues a single-use invite (24h). Demo: { mocked: true, byNullifier }.
  // Real: { idkitResult, seat } — a World ID proof under the join action, signal "council-invite:<seat>".
  invite: (body) => call("POST", "/council/invites", body),
  qrUrl: (data) => `/world/qr.svg?data=${encodeURIComponent(data)}`,
  // Standing instructions and council votes (docs/mandate-spec.md).
  mandate: () => call("GET", "/mandate"),
  // Audit log and its check, rendered as pages (audit.html, audit-verify.html).
  audit: () => call("GET", "/audit"),
  auditVerify: () => call("GET", "/audit/verify"),
  policy: () => call("GET", "/policy"),
  draftMandate: (text) => call("POST", "/mandate/draft", { text }),
  votes: () => call("GET", "/council/votes"),
  member: (seat) => call("GET", `/council/members/${encodeURIComponent(seat)}`),
  // kind "proposal" or "mandate"; ballot { choice, mocked, byNullifier } or { choice, idkitResult }.
  vote: (kind, subject, ballot) => call("POST", `${kind === "mandate" ? "/mandate" : "/proposals"}/${encodeURIComponent(subject)}/vote`, ballot),
};

export const hbar = (tinybars) =>
  `${(tinybars / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} HBAR`;

export const hashscan = (network, id) =>
  `https://hashscan.io/${network === "mainnet" ? "mainnet" : "testnet"}/transaction/${encodeURIComponent(id)}`;

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

// Mode label for the health mode string ("real", "demo", "setup-required").
export function modeLabel(mode) {
  return mode === "real" ? "Live" : mode === "demo" ? "Simulated" : mode === "setup-required" ? "Setup required" : mode;
}

// Show the setup-required banner when the server has no credentials and no
// DEMO_MODE. Reuses the #toast style from motion.css (fixed, mono, on
// theme), so no new CSS. Returns true when the banner was shown.
export function showSetupBanner(health) {
  if (!health || health.mode !== "setup-required") return false;
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.setAttribute("role", "status");
    document.body.append(toast);
  }
  const missing = (health.missingCredentials ?? []).map((m) => m.name).join(", ");
  toast.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = "SETUP REQUIRED";
  toast.append(
    b,
    document.createTextNode(
      `${missing ? ` Missing: ${missing}. ` : " "}See docs/REAL-MODE-RUNBOOK.md, or restart with DEMO_MODE=1 for the demo.`,
    ),
  );
  toast.classList.add("on");
  return true;
}
