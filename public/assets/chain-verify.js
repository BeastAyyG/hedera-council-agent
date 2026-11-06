// Server-independent verifier for the agent's HCS decision log.
// Plain ES module, no imports: runs in the browser and in Node 20+.
// canonical() and the entry hash mirror src/auditlog.ts exactly.

export const GENESIS = "0".repeat(64);

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(str) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function entryHashAsync(entry) {
  const { hash: _hash, ...body } = entry;
  return sha256Hex(canonical(body));
}

export function isChainedEntry(e) {
  return (
    !!e &&
    typeof e === "object" &&
    e.v === 1 &&
    Number.isSafeInteger(e.seq) &&
    typeof e.prev === "string" &&
    typeof e.hash === "string" &&
    typeof e.proposalId === "string" &&
    typeof e.event === "string" &&
    typeof e.detail === "string" &&
    typeof e.at === "string" &&
    typeof e.policy === "string"
  );
}

// Check one entry against the head so far. Returns a reason string, or null if it holds.
export async function checkEntry(m, head) {
  if ((await entryHashAsync(m)) !== m.hash) return `Entry ${m.seq} does not match its own hash, so it was altered.`;
  if (m.seq !== head.seq + 1) return `Entry ${m.seq} follows entry ${head.seq}: an entry is missing or out of order.`;
  if (m.prev !== head.hash) return `Entry ${m.seq} does not link to the entry before it.`;
  return null;
}

// Same contract and reason texts as verifyChain in src/auditlog.ts.
export async function verifyChainAsync(messages) {
  let head = { seq: 0, hash: GENESIS };
  let checked = 0;
  let ignored = 0;
  for (const m of messages) {
    if (!isChainedEntry(m)) {
      ignored += 1;
      continue;
    }
    const reason = await checkEntry(m, head);
    if (reason) return { ok: false, checked, ignored, head: checked ? head : null, brokenAt: m.seq, reason };
    head = { seq: m.seq, hash: m.hash };
    checked += 1;
  }
  return { ok: true, checked, ignored, head: checked ? head : null, brokenAt: null, reason: null };
}

export const MIRROR = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
};

function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Read every message of a topic in consensus order. Non-JSON messages become null.
export async function fetchTopic(network, topicId, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = (opts.baseUrl ?? MIRROR[network] ?? "").replace(/\/$/, "");
  if (!base) throw new Error(`Unknown network "${network}".`);
  if (!/^\d+\.\d+\.\d+$/.test(topicId)) throw new Error(`"${topicId}" is not a topic id like 0.0.1234.`);
  const messages = [];
  let url = `${base}/api/v1/topics/${topicId}/messages?order=asc&limit=100`;
  while (url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Mirror node answered ${res.status} for ${url}`);
    const page = await res.json();
    for (const m of page.messages ?? []) {
      let parsed = null;
      try {
        parsed = JSON.parse(decodeBase64Utf8(m.message));
      } catch {
        parsed = null;
      }
      messages.push(parsed);
    }
    opts.onPage?.(messages.length);
    const next = page.links?.next;
    url = next ? (next.startsWith("http") ? next : base + next) : null;
  }
  return messages;
}
