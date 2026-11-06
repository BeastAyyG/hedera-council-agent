import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path: string) => readFileSync(join(process.cwd(), "public", path), "utf8");
const NAV = [["/", "Atlas"], ["/console.html", "Console"], ["/mandate.html", "Instructions"], ["/council.html", "Council"], ["/member.html", "My seat"], ["/report.html", "Report"], ["/verify.html", "Verify log"]];
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

test("invite member UI: create once, copy, past invites, ?invite= join", async () => {
  const council = read("council.html");
  assert.match(council, /id="invite"/, "council has the Invite a member section");
  assert.match(council, /Create an invite/, "create button");
  assert.match(council, /Shown once — copy it now/, "once-only warning");
  assert.match(council, /qs\("invite"\)/, "?invite= is read");
  assert.match(council, /Join with this invite/, "invite-link join button");
  assert.match(council, /joinCouncil\(\{ world, fb, invite: code \}\)/, "invite-link join consumes the code");
  assert.match(council, /createInvite\(\{ world, identity, fb \}\)/, "create goes through the shared helper");
  assert.match(council, /api\.member\(identity\.seat\)/, "past invites come from the member endpoint");
  const shared = read("assets/council-votes.js");
  assert.match(shared, /export async function autoInvite/, "auto-invite helper exists");
  assert.match(shared, /export async function createInvite/, "create-invite helper exists");
  assert.match(shared, /api\.invite\(\{ mocked: true, byNullifier: me\.nullifier \}\)/, "demo auto-invite uses the current demo identity");
  assert.match(shared, /runWorldInvite\(\{ seat: identity\.seat/, "real invites prove under the join action");
  assert.match(shared, /runMockedFlow\(\{ join: true, invite \}\)/, "demo join carries the invite code");
  assert.match(shared, /runWorldFlow\(\{ join: true, invite/, "real join carries the invite code");
  assert.match(read("assets/api.js"), /invite: \(body\) => call\("POST", "\/council\/invites", body\)/, "api.invite");
  const flow = read("assets/world-flow.js");
  assert.match(flow, /export async function runWorldInvite/, "real invite proof helper");
  assert.match(flow, /invite: true, seat/, "invite proof signal is council-invite:<seat>");
  assert.match(flow, /runMockedFlow\(\{ proposalId, join = false, invite = null \}\)/, "mocked flow takes an invite");
  // The demo join no longer fails once a seat exists: console.html routes its mocked
  // join through the same auto-invite path as the council page.
  assert.match(read("console.html"), /joinCouncil\(\{ world, fb: \{/, "console mocked join uses joinCouncil");
  assert.match(read("console.html"), /const invite = qs\("invite"\)/, "console passes an invite link through");
  // No new colours or fonts: the invite UI uses only existing classes and tokens.
  assert.match(read("assets/council-pages.css"), /\.cv-invite-once\{margin-top:14px;border:1px solid var\(--hair\)/, "once box uses the hairline token");
  const { autoInvite } = await import(pathToFileURL(join(process.cwd(), "public/assets/council-votes.js")).href);
  assert.equal(typeof autoInvite, "function");
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
