// Shared by /mandate.html, /council.html and /member.html: who this browser can vote as, joining,
// casting a ballot (World ID or a DEMO identity), and the tally / vote card renderers.
// The server decides everything; this module only relays ballots and draws what it returns.
import { api, emit, hbar, showSetupBanner } from "./api.js";
import { runWorldFlow, runWorldBallot, runWorldInvite, runMockedFlow } from "./world-flow.js";
import { agentMarkup } from "./council-scene.js";
import { reduced, replay } from "./motion.js";

export const $ = (id) => document.getElementById(id);
export function el(tag, text, cls, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, value);
  return node;
}
export const short = (value, n = 12) => (value ? (value.length > n ? `${value.slice(0, n)}…` : value) : "—");
export const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const seatNumber = (seat) => Number(String(seat).split(":").pop()) || 0;

// ---------- identities kept in this browser ----------
// Demo seats carry the stored "mock:" nullifier the server checks on a ballot. A World seat is only
// remembered by id (the proof is made fresh for every ballot).
const ID_KEY = "council.identities";
const ACT_KEY = "council.actAs";
const read = () => { try { const v = JSON.parse(localStorage.getItem(ID_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => x && typeof x.seat === "string") : []; } catch { return []; } };
const write = (list) => { try { localStorage.setItem(ID_KEY, JSON.stringify(list)); } catch { /* storage disabled: identities last for this page only */ } };
export const identities = {
  list: read,
  add(entry) { write([...read().filter((x) => x.seat !== entry.seat), entry]); this.use(entry.seat); },
  current() { const list = read(); const pick = localStorage.getItem(ACT_KEY); return list.find((x) => x.seat === pick) ?? list.at(-1) ?? null; },
  find: (seat) => read().find((x) => x.seat === seat) ?? null,
  use(seat) { try { localStorage.setItem(ACT_KEY, seat); } catch { /* ignore */ } },
  // Drop identities for seats the server no longer has (state reset or revocation).
  prune(seatIds) { const keep = new Set(seatIds); const list = read(); const next = list.filter((x) => keep.has(x.seat)); if (next.length !== list.length) write(next); return next; },
};

let worldCache = null;
export async function loadWorld() {
  if (worldCache) return worldCache;
  const r = await api.worldConfig().catch(() => ({ ok: false }));
  worldCache = r.ok ? r.data : { configured: false, mockedAllowed: false };
  return worldCache;
}
export const isDemo = (world) => !world.configured && Boolean(world.mockedAllowed);
// Under REAL_ONLY=1 there are no demo identities: the message says what to set up instead.
export const noWorldError = (world) =>
  world.realOnly
    ? "Real-only mode: World ID is not configured. Set WORLD_RP_ID, WORLD_APP_ID and WORLD_SIGNING_KEY, or unset REAL_ONLY to restore the demo."
    : "World ID is not configured here and demo identities are disabled.";

// ---------- feedback: status line, QR and API key ----------
export function feedback(statusEl, qrEl) {
  const set = (text, tone = "neutral") => { statusEl.textContent = text; statusEl.dataset.tone = tone; };
  const qr = (svgUrl) => {
    if (!qrEl) return;
    const img = el("img", undefined, undefined, { src: svgUrl, alt: "World ID request: scan with World App", width: "220", height: "220" });
    qrEl.replaceChildren(img); qrEl.hidden = false;
  };
  const clearQr = () => { if (qrEl) { qrEl.replaceChildren(); qrEl.hidden = true; } };
  // A 401 means the server has an API key; ask for it once per session.
  const needKey = (res) => {
    if (res.status !== 401) return false;
    set("This server needs an API key for votes and drafts.", "bad");
    if (statusEl.nextElementSibling?.classList.contains("cv-keybox")) return true;
    const form = el("form", undefined, "cv-keybox");
    const input = el("input", undefined, "cv-input", { type: "password", autocomplete: "off", placeholder: "API key", "aria-label": "API key" });
    form.append(input, el("button", "Use key", "btn", { type: "submit" }));
    form.onsubmit = (e) => { e.preventDefault(); sessionStorage.setItem("councilKey", input.value.trim()); form.remove(); set("API key stored for this session. Try again.", "neutral"); };
    statusEl.after(form); input.focus();
    return true;
  };
  return { set, qr, clearQr, needKey };
}

// ---------- join ----------
// Demo only: once a seat exists, a join needs an invite from a current seat holder.
// The demo identity in this browser invites the newcomer first, so "Add a demo member"
// works in one click. Returns the invite code, null when no invite is needed (the
// founder joins freely), or false when no invite could be made (the error is already shown).
export async function autoInvite({ world, fb }) {
  if (world.configured || !world.mockedAllowed) return null;
  const seats = await api.seats().catch(() => ({ ok: false }));
  if (!seats.ok || seats.data.count === 0) return null;
  const me = identities.current();
  if (!me?.nullifier) {
    fb.set("Joining needs an invite from a current seat holder, and this browser holds no seat to invite with. Join from the link a member shared.", "bad");
    return false;
  }
  const res = await api.invite({ mocked: true, byNullifier: me.nullifier });
  if (!res.ok) {
    if (!fb.needKey(res)) fb.set(res.data?.error || "Could not create an invite.", "bad");
    return false;
  }
  return res.data.code;
}

// A seat holder issues a single-use invite (24 hours). Demo: the current demo identity
// invites. Real: a fresh World ID proof under the join action, signal "council-invite:<seat>".
export async function createInvite({ world, identity, fb }) {
  if (world.configured) {
    if (!identity) return { ok: false, status: 0, data: { error: "Join the council first: only a seat holder can invite." } };
    fb.set("Preparing World ID…", "wait");
    try {
      const res = await runWorldInvite({ seat: identity.seat, onQr: (_u, svg) => fb.qr(svg), onStatus: (t) => fb.set(t, "wait") });
      if (!res.ok && !fb.needKey(res)) fb.set(res.data?.error || "Could not create an invite.", "bad");
      return res;
    } catch {
      fb.set("Could not reach the server. Try again.", "bad");
      return { ok: false, status: 0, data: {} };
    } finally { fb.clearQr(); }
  }
  if (!world.mockedAllowed) return { ok: false, status: 0, data: { error: noWorldError(world) } };
  if (!identity?.nullifier) return { ok: false, status: 0, data: { error: "Pick a demo identity under Act as, or join the council first." } };
  const res = await api.invite({ mocked: true, byNullifier: identity.nullifier });
  if (!res.ok && !fb.needKey(res)) fb.set(res.data?.error || "Could not create an invite.", "bad");
  return res;
}

export async function joinCouncil({ world, fb, invite = null }) {
  // Demo: joining with an invite link uses that code; otherwise, once a seat exists,
  // the demo identity in this browser invites first (see autoInvite).
  if (!world.configured && world.mockedAllowed && invite === null) {
    const code = await autoInvite({ world, fb });
    if (code === false) return { ok: false, status: 0, data: {} };
    invite = code;
  }
  fb.set(world.configured ? "Preparing World ID…" : "Recording a MOCKED council proof (demo only)…", "wait");
  try {
    const res = world.configured
      ? await runWorldFlow({ join: true, invite, onQr: (_u, svg) => fb.qr(svg), onStatus: (t) => fb.set(t, "wait") })
      : world.mockedAllowed ? await runMockedFlow({ join: true, invite })
      : { ok: false, status: 0, data: { error: noWorldError(world) } };
    if (res.ok) {
      identities.add({ seat: res.data.seat, source: world.configured ? "world" : "mocked", nullifier: world.configured ? null : res.data.nullifier, joinedAt: new Date().toISOString() });
      fb.set(`Joined as ${res.data.seat}${world.configured ? " with World ID" : " (DEMO identity, MOCKED proof)"}.`, "ok");
    } else if (!fb.needKey(res)) fb.set(res.data?.error || "Could not join.", "bad");
    return res;
  } catch {
    fb.set("Could not reach the server. Try again.", "bad");
    return { ok: false, status: 0, data: {} };
  } finally { fb.clearQr(); }
}

// ---------- ballots ----------
export async function castBallot({ item, choice, world, identity, fb }) {
  fb.set(world.configured ? "Preparing the World ID ballot…" : `Recording a ${choice.toUpperCase()} ballot as ${identity?.seat ?? "?"} (DEMO)…`, "wait");
  try {
    let res;
    if (world.configured) res = await runWorldBallot({ kind: item.kind, subject: item.subject, choice, onQr: (_u, svg) => fb.qr(svg), onStatus: (t) => fb.set(t, "wait") });
    else if (!world.mockedAllowed) res = { ok: false, status: 0, data: { error: noWorldError(world) } };
    else if (!identity?.nullifier) res = { ok: false, status: 0, data: { error: "Pick a demo identity under Act as, or join the council first." } };
    else {
      res = await api.vote(item.kind, item.subject, { choice, mocked: true, byNullifier: identity.nullifier });
      if (res.ok) emit("council:ballot", { kind: item.kind, subject: item.subject, choice, source: "mocked", ...res.data });
    }
    if (res.ok) {
      const v = res.data.vote;
      fb.set(v && v.status !== "open" ? `Ballot recorded. The vote ${v.status === "passed" ? "passed" : "failed"}: ${v.yes} yes, ${v.no} no.` : `Ballot recorded: ${choice}.`, "ok");
    } else if (!fb.needKey(res)) fb.set(res.data?.error || "The ballot was not recorded.", "bad");
    return res;
  } catch {
    fb.set("Could not reach the server. Nothing was recorded.", "bad");
    return { ok: false, status: 0, data: {} };
  } finally { fb.clearQr(); }
}

// ---------- pixel seat avatar ----------
const HUES = ["#e23b28", "#1f6f8b", "#1c6b45", "#9a6b15", "#6b3fa0", "#b8432f", "#3b3731"];
export function seatAvatar(seat, { pose = "idle", size = 48 } = {}) {
  const node = el("span", undefined, "council-pet cv-avatar", { "aria-hidden": "true", "data-pose": pose });
  node.style.setProperty("--pet-red", HUES[(seatNumber(seat) - 1 + HUES.length) % HUES.length]);
  node.style.width = node.style.height = `${size}px`;
  node.innerHTML = agentMarkup();
  return node;
}
export const sourceBadge = (source) => el("span", source === "world" ? "World ID" : source === "mocked" ? "MOCKED" : source ?? "unknown", "cv-badge", { "data-source": source ?? "unknown" });

// ---------- tally ----------
// Bar: yes grows from the left, no from the right, a mark at `needed`. Reuses its nodes so a poll animates the change.
export function renderTally(host, vote) {
  const total = Math.max(1, vote.eligible.length);
  let bar = host.querySelector(".cv-tally");
  const fresh = !bar;
  if (fresh) {
    bar = el("div", undefined, "cv-tally");
    const track = el("div", undefined, "cv-track", { role: "img" });
    track.append(el("i", undefined, "cv-yes"), el("i", undefined, "cv-no"), el("b", undefined, "cv-need"));
    bar.append(track, el("p", undefined, "cv-nums", { "aria-live": "polite" }));
    host.append(bar);
  }
  bar.dataset.status = vote.status;
  const track = bar.querySelector(".cv-track");
  const yes = bar.querySelector(".cv-yes"), no = bar.querySelector(".cv-no");
  track.setAttribute("aria-label", `${vote.yes} yes and ${vote.no} no of ${vote.eligible.length} eligible; ${vote.needed} needed`);
  bar.querySelector(".cv-need").style.left = `${(vote.needed / total) * 100}%`;
  const apply = () => { yes.style.width = `${(vote.yes / total) * 100}%`; no.style.width = `${(vote.no / total) * 100}%`; };
  if (fresh && !reduced()) { yes.style.width = no.style.width = "0%"; requestAnimationFrame(() => requestAnimationFrame(apply)); } else apply();
  const nums = bar.querySelector(".cv-nums");
  const state = vote.status === "passed" ? "Passed" : vote.status === "failed" ? "Failed" : `${Math.max(0, vote.needed - vote.yes)} more yes to pass`;
  const text = `${vote.yes} yes · ${vote.no} no · ${vote.needed} of ${vote.eligible.length} needed · ${state}`;
  if (nums.textContent !== text) {
    nums.replaceChildren(el("b", String(vote.yes), "cv-y"), ` yes · `, el("b", String(vote.no), "cv-n"), ` no · ${vote.needed} of ${vote.eligible.length} needed · `, el("span", state, "cv-state"));
    if (!fresh) replay(nums, "cv-bump");
  }
  return bar;
}

// ---------- decision wording ----------
// PENDING_VOTE and PENDING_CHALLENGE are waiting states, never refusals.
export function decisionLabel(decision) {
  switch (decision) {
    case "SIGNED": return { label: "Signed", tone: "safe" };
    case "REFUSED": return { label: "Refused", tone: "danger" };
    case "CANCELLED": return { label: "Cancelled", tone: "danger" };
    case "PENDING_CHALLENGE": return { label: "Challenge window", tone: "warn" };
    case "PENDING_VOTE": return { label: "Waiting for the council", tone: "warn" };
    default: return { label: decision ? decision.toLowerCase() : "not decided", tone: "neutral" };
  }
}
export const pill = (tone, label) => el("span", label, "cv-pill", { "data-tone": tone });

// ---------- vote card ----------
// ctx: { world, identity, onVote(item, choice, card), detail?(item) -> Node | null }
export function voteCard(item, ctx) {
  const card = el("article", undefined, "cv-card", { "data-subject": item.subject, "data-kind": item.kind, "aria-label": `${item.kind === "mandate" ? "Instruction" : "Payment"} vote ${item.subject}` });
  const head = el("header", undefined, "cv-card-head");
  const folio = el("span", item.kind === "mandate" ? `Standing instruction · ${item.subject}` : `Payment · ${item.subject}`, "doc-folio");
  head.append(folio, el("span", undefined, "cv-card-pet"));
  head.lastChild.append(seatAvatar(`seat:${item.kind === "mandate" ? 1 : 4}`, { size: 34 }));
  card.append(head, el("h3", item.title, "cv-card-title"));
  if (item.kind === "proposal" && item.amountTinybars !== undefined) {
    const line = el("p", undefined, "cv-amount");
    line.append(el("b", hbar(item.amountTinybars)), " to ", el("code", item.payee ?? "?"));
    card.append(line);
  }
  const why = el("div", undefined, "cv-why");
  if (item.kind === "proposal") {
    why.append(el("span", "Why it needs the council", "doc-folio"));
    const list = el("ul", undefined, "cv-violations");
    (item.violations?.length ? item.violations : ["Outside the standing instruction."]).forEach((v) => list.append(el("li", v)));
    why.append(list);
  } else {
    why.append(el("span", "Adopting these rules", "doc-folio"));
    const extra = ctx.detail?.(item);
    why.append(extra ?? el("p", "The owner's instruction compiled into rules. Once adopted, payments inside them are signed with no vote.", "cv-muted"));
  }
  card.append(why, el("div", undefined, "cv-tally-host"), el("ul", undefined, "cv-ballots", { "aria-label": "Ballots cast" }), el("div", undefined, "cv-actions"));
  const stamp = el("div", undefined, "cv-stamp", { "aria-hidden": "true" }); stamp.hidden = true;
  card.append(stamp);
  updateVoteCard(card, item, ctx);
  return card;
}

export function updateVoteCard(card, item, ctx) {
  const vote = item.vote;
  card.dataset.status = vote.status;
  renderTally(card.querySelector(".cv-tally-host"), vote);
  const prevBallots = Number(card.dataset.ballots ?? 0);
  const ballotsList = card.querySelector(".cv-ballots");
  ballotsList.replaceChildren(...vote.ballots.map((b) => {
    const li = el("li", undefined, "cv-ballot", { "data-choice": b.choice, title: `${b.seat} voted ${b.choice} (${b.source}) at ${when(b.at)}` });
    li.append(el("span", b.choice === "yes" ? "✓" : "✕", "cv-mark", { "aria-hidden": "true" }), `${b.seat.replace("council-seat:", "seat ")} ${b.choice}`);
    return li;
  }));
  // A ballot that arrived since the last render (cast here or in another
  // browser) flashes once, so the tally moving is not the only sign.
  if (vote.ballots.length > prevBallots && ballotsList.lastElementChild && !reduced()) replay(ballotsList.lastElementChild, "m-flash-green", 0);
  card.dataset.ballots = String(vote.ballots.length);
  const actions = card.querySelector(".cv-actions");
  actions.replaceChildren();
  if (vote.status !== "open") {
    const result = item.kind === "proposal" && item.decision ? decisionLabel(item.decision) : { label: vote.status === "passed" ? "Adopted" : "Rejected", tone: vote.status === "passed" ? "safe" : "danger" };
    actions.append(pill(vote.status === "passed" ? "safe" : "danger", vote.status === "passed" ? "Vote passed" : "Vote failed"), pill(result.tone, result.label));
    showStamp(card, vote.status === "passed", false);
    return;
  }
  const { world, identity } = ctx;
  if (ctx.readOnly) {
    actions.append(el("span", ctx.readOnly, "cv-note"));
    return;
  }
  const mine = identity ? vote.ballots.find((b) => b.seat === identity.seat) : null;
  const eligible = identity ? vote.eligible.includes(identity.seat) : false;
  let note = "";
  let disabled = false;
  if (mine) { disabled = true; note = `${identity.seat} voted ${mine.choice}.`; }
  else if (world.configured) note = identity ? `Prove with World ID as ${identity.seat}.` : "Your World ID proof is matched to your seat.";
  else if (!world.mockedAllowed) { disabled = true; note = "World ID is not configured on this server."; }
  else if (!identity) { disabled = true; note = "Join, or pick a DEMO identity under Act as."; }
  else if (!eligible) { disabled = true; note = `${identity.seat} joined after this vote opened, so it cannot vote on it.`; }
  else note = `Voting as ${identity.seat} (DEMO).`;
  for (const choice of ["yes", "no"]) {
    const b = el("button", choice === "yes" ? "Vote yes" : "Vote no", choice === "yes" ? "btn btn-primary cv-vote" : "btn cv-vote", { type: "button", "data-choice": choice });
    b.disabled = disabled;
    b.onclick = async () => {
      actions.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      try { await ctx.onVote(item, choice, card); } finally { if (card.isConnected && card.dataset.status === "open") actions.querySelectorAll("button").forEach((x) => { x.disabled = disabled; }); }
    };
    actions.append(b);
  }
  actions.append(el("span", note, "cv-note"));
}

// "Passed" / "Refused" stamp, and the card's courier hops or stops.
export function showStamp(card, passed, animate = true) {
  const stamp = card.querySelector(".cv-stamp");
  const label = card.dataset.kind === "mandate" ? (passed ? "Adopted" : "Rejected") : (passed ? "Passed" : "Refused");
  const already = !stamp.hidden && stamp.textContent === label;
  stamp.hidden = false; stamp.textContent = label; stamp.dataset.result = passed ? "passed" : "failed";
  const pet = card.querySelector(".cv-card-pet .council-pet");
  if (pet) pet.dataset.pose = passed ? "signed" : "refused";
  if (animate && !already && !reduced()) {
    // m-reveal keeps opacity 0 without its animation; drop it before another animation replaces it.
    card.classList.remove("m-reveal");
    replay(stamp, "m-slam", 0);
    replay(card, passed ? "m-flash-green" : "m-flash-red", 0);
  }
}

// ---------- identity bar ("Act as") ----------
// Renders the DEMO banner + picker, or the World ID note, plus a Join button. Calls onChange(identity) on every change.
export function mountIdentityBar(host, { world, fb, onChange = () => {}, seatIds = null }) {
  const render = () => {
    const list = identities.list();
    const current = identities.current();
    host.replaceChildren();
    host.className = "cv-identity";
    host.dataset.mode = world.configured ? "world" : world.mockedAllowed ? "demo" : "off";
    if (isDemo(world)) {
      const banner = el("p", undefined, "cv-demo-banner", { role: "note" });
      banner.append(el("b", "DEMO identities"), " These seats are MOCKED World ID proofs kept in this browser, so one person can play several voters. Not real proofs.");
      host.append(banner);
      const row = el("div", undefined, "cv-identity-row");
      const label = el("label", undefined, "cv-actas");
      label.append(el("span", "Act as", "doc-folio"));
      const select = el("select", undefined, "cv-select", { id: "actAs" });
      if (!list.length) select.append(el("option", "No demo identity yet", undefined, { value: "" }));
      list.forEach((x) => select.append(el("option", `${x.seat}${x.source === "world" ? " (World ID)" : " · DEMO"}`, undefined, { value: x.seat })));
      select.value = current?.seat ?? "";
      select.disabled = !list.length;
      select.onchange = () => { identities.use(select.value); render(); onChange(identities.current()); };
      label.append(select);
      row.append(label);
      if (current) { const a = el("a", "Open my seat", "btn", { href: `/member.html?seat=${encodeURIComponent(current.seat)}` }); row.append(a); }
      const join = el("button", list.length ? "Add a demo member" : "Join as a demo member", "btn", { type: "button", id: "join-btn" });
      join.onclick = async () => { join.disabled = true; try { const r = await joinCouncil({ world, fb }); if (r.ok) { render(); onChange(identities.current(), { joined: r.data.seat }); } } finally { join.disabled = false; } };
      row.append(join);
      host.append(row);
    } else if (world.configured) {
      const note = el("p", undefined, "cv-world-note");
      note.append(el("b", "World ID"), " Every ballot is a fresh World ID proof from a seat holder, bound to the exact proposal or rules and to your choice.");
      const row = el("div", undefined, "cv-identity-row");
      const join = el("button", "Join the council (World ID)", "btn", { type: "button", id: "join-btn" });
      join.onclick = async () => { join.disabled = true; try { const r = await joinCouncil({ world, fb }); if (r.ok) { render(); onChange(identities.current(), { joined: r.data.seat }); } } finally { join.disabled = false; } };
      row.append(join);
      if (current) row.append(el("a", `My seat: ${current.seat}`, "btn", { href: `/member.html?seat=${encodeURIComponent(current.seat)}` }));
      host.append(note, row);
    } else {
      host.append(el("p", world.realOnly ? "Real-only mode: World ID is not configured on this server, so this browser cannot vote. Set WORLD_RP_ID, WORLD_APP_ID and WORLD_SIGNING_KEY, or unset REAL_ONLY to restore the demo." : "World ID is not configured on this server and demo identities are disabled, so this browser cannot vote.", "cv-world-note"));
    }
  };
  render();
  return {
    render,
    // Re-render only when a stored identity vanished, so polling never resets the picker under the user's hand.
    prune(ids) { const before = identities.list().length; if (identities.prune(ids).length !== before) { render(); return true; } return false; },
  };
}

// ---------- polling ----------
// Runs fn now and every ms while the tab is visible; never overlaps.
export function poll(fn, ms) {
  let busy = false;
  const tick = async () => { if (busy || document.hidden) return; busy = true; try { await fn(); } catch { /* next tick retries */ } finally { busy = false; } };
  const id = setInterval(tick, ms);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  return { tick, stop: () => clearInterval(id) };
}

// Header chain tag, rail and footer, as on the console.
export async function fillChrome() {
  const [h, pol] = await Promise.all([
    api.health().then((r) => (r.ok ? r.data : null)).catch(() => null),
    fetch("/policy").then((r) => r.json()).catch(() => ({})),
  ]);
  if (!h) return null;
  showSetupBanner(h);
  const tag = `${h.mode}, ${h.network}`;
  for (const id of ["chainTag", "railMode"]) { const n = $(id); if (n) n.textContent = tag; }
  const left = $("footLeft"), right = $("footRight");
  if (left) left.textContent = `Council Agent, Mumbai 2026, policy ${pol.hash ? `${pol.hash.slice(0, 12)}…` : "n/a"}`;
  if (right) right.textContent = `${h.councilSeats} seat${h.councilSeats === 1 ? "" : "s"}, World ${String(h.world).startsWith("real") ? "real" : "mocked"}, 0G ${h.zeroG}`;
  return h;
}
