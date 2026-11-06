import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path: string) => readFileSync(join(process.cwd(), "public", path), "utf8");
const NAV = [["/", "Atlas"], ["/console.html", "Console"], ["/mandate.html", "Instructions"], ["/council.html", "Council"], ["/member.html", "My seat"], ["/report.html", "Report"], ["/policy", "Policy"], ["/audit/verify", "Audit"]];
const PAGES: Array<[string, string | null]> = [
  ["index.html", "/"], ["console.html", "/console.html"], ["report.html", "/report.html"], ["verify.html", null],
  ["mandate.html", "/mandate.html"], ["council.html", "/council.html"], ["member.html", "/member.html"],
];

test("every page carries the full nav with the right aria-current", () => {
  for (const [file, current] of PAGES) {
    const html = read(file);
    for (const [href, label] of NAV) {
      assert.match(html, new RegExp(`<a href="${href.replace(/[/.]/g, "\\$&")}"[^>]*>${label}</a>`), `${file} links ${label}`);
    }
    const marked = [...html.matchAll(/<a href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
    if (current) assert.ok(marked.length >= 1 && marked.every((href) => href === current), `${file} marks only ${current}: ${marked}`);
  }
  // The app-shell pages have a desktop and a mobile nav, both complete.
  for (const file of ["console.html", "mandate.html", "council.html", "member.html"]) {
    const html = read(file);
    for (const cls of ["app-nav", "app-mobile-nav"]) {
      const nav = html.match(new RegExp(`<nav class="${cls}"[^>]*>([\\s\\S]*?)</nav>`))?.[1] ?? "";
      assert.equal([...nav.matchAll(/<a /g)].length, NAV.length, `${file} ${cls}`);
    }
  }
});

test("PENDING_VOTE is a waiting state on the journey, never a refusal", async () => {
  const { decisionModel } = await import(pathToFileURL(join(process.cwd(), "public/assets/council-scene.js")).href);
  const record = {
    proposal: { id: "P-V", description: { payee: "0.0.9001", amountTinybars: 1, token: "HBAR" }, transfer: { payee: "0.0.9001", amountTinybars: 1, token: "HBAR" } },
    check: { matches: true, mismatches: [] }, large: false,
    lastOutcome: { decision: "PENDING_VOTE", mandate: { id: "M-1", within: false, violations: ["0.0.9001 is not a registered payee"] } },
  };
  const model = decisionModel(record);
  assert.equal(model.pose, "wait");
  assert.equal(model.stages[2].note, "Council vote open");
  assert.equal(model.stages[2].state, "wait");
  assert.equal(model.stages[3].state, "wait");
  assert.ok(model.stages.every((s: { state: string }) => s.state !== "fail"));
  const within = decisionModel({ ...record, lastOutcome: { decision: "SIGNED", mandate: { id: "M-1", within: true, violations: [] } } });
  assert.equal(within.stages[2].note, "Standing instruction");
});

test("council pages share one module and label waiting decisions as the council", async () => {
  const { decisionLabel } = await import(pathToFileURL(join(process.cwd(), "public/assets/council-votes.js")).href);
  assert.deepEqual(decisionLabel("PENDING_VOTE"), { label: "Waiting for the council", tone: "warn" });
  assert.equal(decisionLabel("REFUSED").tone, "danger");
  for (const file of ["mandate.html", "council.html", "member.html"]) {
    assert.match(read(file), /from "\/assets\/council-votes\.js"/, file);
    assert.match(read(file), /aria-live="polite"/, file);
  }
  const shared = read("assets/council-votes.js");
  assert.match(shared, /mocked: true, byNullifier/);
  assert.match(shared, /DEMO identities/);
  assert.match(read("assets/world-flow.js"), /vote: true, subject, choice/);
  assert.match(read("console.html"), /PENDING_VOTE[\s\S]*Waiting for the council[\s\S]*\/council\.html/);
  assert.match(read("report.html"), /PENDING_VOTE[\s\S]*Waiting for the council/);
  assert.match(read("assets/scroll-companion.js"), /PENDING_VOTE"\) flash\("wait", "Council vote"\)/);
  assert.match(read("assets/council-pages.css"), /prefers-reduced-motion:reduce/);
});
