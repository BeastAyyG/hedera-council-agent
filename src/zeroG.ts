// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// 0G Private Computer client (OpenAI-compatible API).
// Verified 2026-11-06 against docs.0g.ai and compute.0g.ai:
// base URL https://router-api.0g.ai/v1, endpoint POST /v1/chat/completions,
// auth Bearer sk- key, model slug 0gm-1.0-35b-a3b (the prize page's
// "0gm-1.0" is shorthand, not the wire slug). The auditable request id
// is in the response BODY as x_0g_trace.request_id, not a header.
// The 0G verdict is load-bearing: it is the plain-language verdict for
// the proposal check, and the sign/refuse decision is recorded alongside
// it. The deterministic mismatch check still decides refusal; 0G writes
// the human-readable explanation, and its request id is logged per check.
// With a key set, or in real Hedera mode, a missing verdict means the
// agent refuses (fails closed); see council.ts.
// Real mode only when ZERO_G_API_KEY is set. Otherwise SIMULATED mode
// with a clearly labelled template verdict, never pretending to be 0G.

export interface ZeroGVerdict {
  text: string;
  requestId: string | null;
  model: string;
  source: "0g" | "simulated" | "unavailable";
  // Why the call failed, when source is "unavailable".
  error?: string;
}

export interface ZeroGConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function loadZeroGConfig(env: NodeJS.ProcessEnv): ZeroGConfig {
  return {
    apiKey: (env.ZERO_G_API_KEY ?? "").trim(),
    baseUrl: (env.ZERO_G_BASE_URL ?? "https://router-api.0g.ai/v1").trim(),
    model: (env.ZERO_G_MODEL ?? "0gm-1.0-35b-a3b").trim(),
  };
}

export async function zeroGVerdict(
  config: ZeroGConfig,
  input: { proposalId: string; checkVerdict: string; matches: boolean; amountTinybars: number; payee: string },
): Promise<ZeroGVerdict> {
  const template = input.matches
    ? `Proposal ${input.proposalId}: the transfer of ${input.amountTinybars} tinybars to ${input.payee} matches its description. ${input.checkVerdict}`
    : `Proposal ${input.proposalId}: the transfer does NOT match its description. ${input.checkVerdict} Do not sign.`;
  if (!config.apiKey) {
    return { text: `[SIMULATED 0G verdict] ${template}`, requestId: null, model: config.model, source: "simulated" };
  }
  const prompt = `You are a treasury council checker. Write a short plain-language verdict (2-3 sentences) for this proposal check. Do not invent numbers. Check result: ${input.checkVerdict}`;
  // An outage is reported as source "unavailable". The council fails
  // closed on it (src/council.ts): no verdict, no signature, unless
  // ALLOW_NO_0G=true.
  try {
    return await callZeroG(config, prompt, template);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { text: `[0G verdict unavailable: ${error}] ${template}`, requestId: null, model: config.model, source: "unavailable", error };
  }
}

async function callZeroG(config: ZeroGConfig, prompt: string, template: string): Promise<ZeroGVerdict> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "X-0G-Provider-Trust-Mode": "verified",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`0G Private Computer request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    id?: string;
    x_0g_trace?: { request_id?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim() || template;
  // Auditable request id lives in the body as x_0g_trace.request_id.
  return { text, requestId: data.x_0g_trace?.request_id ?? data.id ?? null, model: config.model, source: "0g" };
}
