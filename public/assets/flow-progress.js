// Judge-flow progress: one cue on every page of the demo flow, so the story
// reads as Atlas -> Console sign -> mismatch refusal -> large payment World ID
// -> mandate -> council vote -> verify. The current step comes from the page
// itself; done steps come from server state (a proposal exists, a refusal
// happened, a large payment was gated, a draft exists, a vote closed, the
// audit log has entries). Links only, no decoration, off under reduced motion
// (the strip is static; only the state changes).
import { api } from "./api.js";
import { reduced } from "./motion.js";

const STEPS = [
  { n: 1, label: "Atlas", sub: "See the story", href: "/", page: "atlas" },
  { n: 2, label: "Console", sub: "Sign a payment", href: "/console.html", page: "console" },
  { n: 3, label: "Refusal", sub: "Mismatch refused", href: "/console.html", page: "console" },
  { n: 4, label: "World ID", sub: "Large payment gated", href: "/console.html", page: "console" },
  { n: 5, label: "Instructions", sub: "Write the rules", href: "/mandate.html", page: "mandate" },
  { n: 6, label: "Council", sub: "Council votes", href: "/council.html", page: "council" },
  { n: 7, label: "Verify", sub: "Verify the log", href: "/verify.html", page: "verify" },
];

// Pages that share step 6 or 7.
const PAGE_STEP = { atlas: 1, console: 2, mandate: 5, council: 6, member: 6, report: 7, verify: 7, audit: 7, "audit-verify": 7 };

export async function mountFlowProgress(host = document.getElementById("flowProgress")) {
  if (!host) return null;
  const page = document.body.dataset.page ?? "";
  const current = PAGE_STEP[page] ?? 1;
  // Done flags from server state. Any one fetch failing leaves that step undone.
  const [proposals, mandate, votes, audit] = await Promise.all([
    api.proposals().catch(() => ({ ok: false })),
    api.mandate().catch(() => ({ ok: false })),
    api.votes().catch(() => ({ ok: false })),
    api.audit().catch(() => ({ ok: false })),
  ]);
  const list = proposals.ok ? (proposals.data.proposals ?? []) : [];
  const done = new Set();
  if (list.length) done.add(2);
  if (list.some((p) => p.decision === "REFUSED")) done.add(3);
  if (list.some((p) => p.large)) done.add(4);
  if (mandate.ok && (mandate.data.active || (mandate.data.drafts ?? []).length)) done.add(5);
  if (votes.ok && (votes.data.closed ?? []).length) done.add(6);
  if (audit.ok && (audit.data.entries ?? []).length) done.add(7);

  const nav = document.createElement("nav");
  nav.className = "flow-progress";
  nav.setAttribute("aria-label", "Demo flow progress");
  const ol = document.createElement("ol");
  for (const step of STEPS) {
    const li = document.createElement("li");
    const state = step.n === current ? "current" : done.has(step.n) ? "done" : "todo";
    li.dataset.state = state;
    const num = document.createElement("span");
    num.className = "fp-num";
    num.textContent = done.has(step.n) && step.n !== current ? "✓" : String(step.n).padStart(2, "0");
    const words = document.createElement("span");
    words.className = "fp-words";
    words.append(Object.assign(document.createElement("b"), { textContent: step.label }));
    const sub = document.createElement("span");
    sub.className = "fp-sub";
    sub.textContent = step.sub;
    words.append(sub);
    if (step.n === current) {
      li.setAttribute("aria-current", "step");
      const here = document.createElement("span");
      here.className = "fp-here";
      here.append(num, words);
      li.append(here);
    } else {
      const a = document.createElement("a");
      a.href = step.href;
      a.append(num, words);
      li.append(a);
    }
    ol.append(li);
  }
  nav.append(ol);
  const compact = document.createElement("p");
  compact.className = "fp-compact";
  const doneCount = [...done].filter((n) => n < current).length;
  compact.textContent = `Step ${current} of 7 · ${STEPS[current - 1].label}: ${STEPS[current - 1].sub}${doneCount ? ` · ${doneCount} earlier step${doneCount === 1 ? "" : "s"} done` : ""}`;
  nav.append(compact);
  host.replaceChildren(nav);
  if (!reduced()) {
    // One quiet reveal; the strip itself never moves again.
    nav.classList.add("m-reveal");
  }
  return { current, done: [...done].sort((a, b) => a - b) };
}
