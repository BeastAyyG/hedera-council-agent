// Judge mode: a fixed panel that runs the whole demo against the real API for a clean recording.
// J (outside inputs) or ?judge=1 toggles it, ?speed=0.2 scales every pause, Esc stops. It drives the
// console's own functions (submit via api, select, approve) and never fakes a decision.
// Mocked approval is used only when /world/config says World ID is not configured and mocking is allowed.

const STEPS = [
  ["Routine proposal", "A routine proposal, 0.1 HBAR, description matches. The agent pays for the check and signs."],
  ["Mismatch", "Same kind of proposal, but the transfer goes to another account for more. The agent refuses."],
  ["Large proposal", "0.8 HBAR, description matches, but it is large: blocked at the World ID gate."],
  ["Approve", "The owner approves this exact proposal with World ID (mocked here, and labelled so)."],
  ["Resubmit", "Same proposal again, now with a fresh approval. The agent signs."],
  ["Process strip", "The agent paid for the check and still refused."],
];
const FINAL = "The agent paid for the check and still refused.";
const STOP = Symbol("stop");
const toTiny = (h) => Math.round(h * 1e8);

export function initJudge(ctx) {
  const params = new URLSearchParams(location.search);
  const speed = Math.max(0.01, Number(params.get("speed")) || 1);
  const $ = (id) => document.getElementById(id);
  const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

  // Page-owned responsive rules: on narrow screens the panel participates in
  // document flow, so it can never sit on top of submit or approval controls.
  const style = mk("style");
  style.textContent = `
    .judge-head-actions{display:flex;align-items:baseline;gap:10px}
    .judge-hide{border:0;border-bottom:1px solid var(--m-hair);background:transparent;padding:0;color:var(--m-muted);font:inherit;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}
    .judge-hide:hover{color:var(--m-red);border-color:var(--m-red)}
    .judge-start:focus-visible,.judge-hide:focus-visible{outline:2px solid var(--m-red);outline-offset:3px}
    @media(max-width:640px){
      body.judge-open{padding-bottom:0}
      .judge-panel{position:relative;inset:auto;width:auto;max-height:none;margin:20px 12px calc(20px + env(safe-area-inset-bottom));overflow:visible;box-shadow:3px 3px 0 var(--m-ink)}
      .judge-head{align-items:flex-start}
      .judge-head-actions{flex-direction:column;align-items:flex-end;gap:4px}
      .judge-cap{min-height:0}
    }
  `;
  document.head.append(style);

  const panel = mk("aside", undefined, "judge-panel"); panel.id = "judgePanel"; panel.hidden = true;
  panel.setAttribute("aria-label", "Judge mode");
  const head = mk("div", undefined, "judge-head");
  const headActions = mk("div", undefined, "judge-head-actions");
  headActions.append(mk("span", "J hides · Esc stops"));
  const hide = mk("button", "Hide", "judge-hide"); hide.type = "button"; hide.setAttribute("aria-label", "Hide judge mode");
  headActions.append(hide); head.append(mk("b", "Judge mode"), headActions);
  const list = mk("ol", undefined, "judge-steps");
  const items = STEPS.map(([name]) => { const li = mk("li", name); li.dataset.state = "pending"; list.append(li); return li; });
  const cap = mk("p", "Runs the full demo against the live API: sign, refuse, block, approve, sign.", "judge-cap"); cap.id = "judgeCaption"; cap.setAttribute("role", "status"); cap.setAttribute("aria-live", "polite");
  const start = mk("button", "Start", "judge-start"); start.type = "button";
  panel.append(head, list, cap, start);
  document.body.append(panel);

  let running = false, aborted = false, wake = () => {};
  const setBody = (v) => { document.body.dataset.judge = v; };
  setBody("idle");
  const mark = (i, state) => { items[i].dataset.state = state; };
  const say = (t, tone = "") => { cap.textContent = t; cap.dataset.tone = tone; };
  const pause = (ms) => {
    const t = ctx.reduced() ? Math.min(300, ms * speed) : ms * speed;
    return new Promise((res, rej) => { wake = () => rej(STOP); if (aborted) return rej(STOP); setTimeout(res, t); });
  };
  const alive = () => { if (aborted) throw STOP; };
  const toggle = (on) => {
    panel.hidden = on === undefined ? !panel.hidden : !on;
    document.body.classList.toggle("judge-open", !panel.hidden);
  };
  hide.onclick = () => toggle(false);

  const uid = Date.now().toString(36).toUpperCase();
  const mkProposal = (suffix, purpose, d, t) => ({
    id: `J-${uid}-${suffix}`,
    description: { payee: d[0], amountTinybars: toTiny(d[1]), token: "HBAR", purpose },
    transfer: { payee: t[0], amountTinybars: toTiny(t[1]), token: "HBAR" },
  });

  async function submit(proposal) {
    const res = await ctx.whileWorking($("workingBar"), () => ctx.api.submit(proposal), 1500 * speed);
    alive();
    if (res.status >= 400) throw new Error(res.data?.error ?? `submit failed (${res.status})`);
    const d = res.data.decision;
    ctx.status(d === "SIGNED" ? `Agent signed. Scheduled tx ${res.data.scheduledTxId}.` : d === "PENDING_CHALLENGE" ? `Passed every check. Waiting out the challenge window until ${res.data.challengeUntil}.` : `Agent refused: ${res.data.reason}`, d === "SIGNED" ? "ok" : d === "PENDING_CHALLENGE" ? "" : "bad");
    await ctx.refreshList(); alive();
    await ctx.select(proposal.id, { land: true }); alive();
    $("folio")?.scrollIntoView({ behavior: ctx.reduced() ? "auto" : "smooth", block: "start" });
    return res.data;
  }
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

  async function run() {
    running = true; aborted = false; start.disabled = true; start.textContent = "Running…"; setBody("running");
    $("judgeProcessNote")?.remove();
    items.forEach((li) => { li.dataset.state = "pending"; });
    const routine = mkProposal("R", "Pay the venue deposit", ["0.0.1001", 0.1], ["0.0.1001", 0.1]);
    const mismatch = mkProposal("M", "Pay the caterer", ["0.0.1001", 0.1], ["0.0.6666", 0.9]);
    const large = mkProposal("L", "Fund the community grant", ["0.0.1001", 0.8], ["0.0.1001", 0.8]);
    let step = 0;
    try {
      const go = async (i, fn) => {
        step = i; mark(i, "active"); say(STEPS[i][1]); await pause(2200);
        const done = await fn(); mark(i, "done"); if (done) say(done, "ok"); await pause(6500);
      };
      await go(0, async () => {
        const o = await submit(routine);
        expect(o.decision === "SIGNED" || o.decision === "PENDING_CHALLENGE", `Routine proposal was ${o.decision}, expected SIGNED.`);
        return o.decision === "SIGNED" ? "Signed. The check passed, nothing needed approval." : "The check passed. It waits out the challenge window, then is re-checked before signing.";
      });
      await go(1, async () => {
        const o = await submit(mismatch);
        expect(o.decision === "REFUSED", `Mismatch was ${o.decision}, expected REFUSED.`);
        return "Refused. Payee and amount differ from the description.";
      });
      await go(2, async () => {
        const o = await submit(large);
        expect(o.decision === "REFUSED" && o.worldGateReason, "The large proposal was not stopped at the World ID gate.");
        return "Blocked at the World ID gate. The transfer matches, but there is no approval yet.";
      });
      step = 3; mark(3, "active"); say(STEPS[3][1]); await pause(2200);
      const wc = (await ctx.api.worldConfig()).data; alive();
      if (wc.configured || !wc.mockedAllowed) {
        mark(3, "needs-scan"); await ctx.select(large.id);
        say("World ID needs a real scan. Approve this proposal in the console with World App, then submit it again. The agent will not sign without it.", "warn");
        setBody("needs-scan"); finish(); return;
      }
      await ctx.approve(large.id); alive();
      const chk = (await ctx.api.proposal(large.id)).data; alive();
      expect(chk.approval, "The approval was not recorded.");
      await ctx.select(large.id); mark(3, "done"); say("Approved (mocked, demo only). Single use, five minutes.", "ok"); await pause(6500);
      await go(4, async () => {
        const o = await submit(large);
        expect(o.decision === "SIGNED" || o.decision === "PENDING_CHALLENGE", `Large proposal was ${o.decision} after approval, expected SIGNED.`);
        return o.decision === "SIGNED" ? "Signed. The approval is spent." : "Approved and waiting out the challenge window. The approval is spent at execution.";
      });
      step = 5; mark(5, "active"); say(STEPS[5][1]); await pause(1800);
      await ctx.select(mismatch.id); alive();
      const proc = $("process");
      const note = mk("p", FINAL, "judge-process-note"); note.id = "judgeProcessNote";
      proc.before(note);
      proc.scrollIntoView({ behavior: ctx.reduced() ? "auto" : "smooth", block: "center" });
      mark(5, "done"); say(FINAL, "bad"); await pause(7000);
      setBody("done"); say(`Done. ${FINAL}`, "ok");
    } catch (e) {
      if (e === STOP) { mark(step, "stopped"); say("Stopped.", "warn"); setBody("stopped"); }
      else { mark(step, "failed"); say(`Failed at step ${step + 1}: ${e.message}`, "bad"); setBody("failed"); }
    }
    finish();
  }
  function finish() { running = false; start.disabled = false; start.textContent = "Run again"; }

  start.onclick = () => { if (!running) run(); };
  addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === "Escape") {
      if (running) { aborted = true; say("Stopping…", "warn"); wake(); } else if (!panel.hidden) toggle(false);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "J") toggle();
  });
  if (params.get("judge") === "1") toggle(true);
  window.__judge = { start: () => (running ? Promise.resolve() : run()), toggle };
}
