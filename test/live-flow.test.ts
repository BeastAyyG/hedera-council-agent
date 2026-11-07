import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), "public", path), "utf8");
const PAGES = ["index.html", "console.html", "report.html", "verify.html", "mandate.html", "council.html", "member.html", "audit.html", "audit-verify.html"];

test("live pages poll every 5s: council, member, audit log and audit check", () => {
  assert.match(read("council.html"), /poll\(refresh, 5000\);/, "council polls every 5s");
  assert.match(read("member.html"), /poll\(refresh, 5000\);/, "member polls every 5s");
  assert.match(read("audit.html"), /poll\(refresh, 5000\);/, "audit log polls every 5s");
  assert.match(read("audit-verify.html"), /poll\(recheck, 5000\);/, "audit check polls every 5s");
  assert.doesNotMatch(read("council.html"), /poll\(refresh, 3000\)/, "council no longer polls at 3s");
  assert.doesNotMatch(read("audit.html"), /poll\(refresh, 10000\)/, "audit log no longer polls at 10s");
});

test("judge-flow progress cue is on every page of the flow", () => {
  for (const file of PAGES) {
    assert.match(read(file), /id="flowProgress"/, `${file} has the progress mount`);
    assert.match(read(file), /mountFlowProgress\(\)/, `${file} mounts the progress cue`);
  }
  const flow = read("assets/flow-progress.js");
  assert.match(flow, /export async function mountFlowProgress/, "progress module exports mountFlowProgress");
  for (const label of ["Atlas", "Console", "Refusal", "World ID", "Instructions", "Council", "Verify"]) {
    assert.ok(flow.includes(`label: "${label}"`), `flow has the ${label} step`);
  }
  assert.match(flow, /aria-current", "step"/, "current step is marked aria-current");
  const css = read("assets/motion.css");
  assert.match(css, /\.flow-progress\s*\{/, "progress strip styles exist");
  assert.match(css, /\.fp-compact\s*\{/, "mobile compact line exists");
  assert.match(css, /@media \(max-width: 720px\) \{\n  \.flow-progress ol \{ display: none; \}/, "full strip hides on mobile");
  assert.match(css, /data-state="current"/, "current step is red");
  assert.match(css, /data-state="done"/, "done steps are green");
});

test("a join slides in and the seat count ticks; a ballot flashes where it lands", () => {
  const council = read("council.html");
  assert.match(council, /const memberRows = new Map\(\)/, "council keeps member rows across polls");
  assert.match(council, /cv-row-new/, "new seat rows slide in");
  assert.match(council, /replay\(\$\("mSeats"\), "cv-count-bump"\)/, "seat count ticks on change");
  assert.match(council, /\.cv-ballots-count/, "ballot counts update in place");
  assert.doesNotMatch(council, /list\.replaceChildren\(\.\.\.seats\.map/, "member list is no longer rebuilt wholesale");
  const shared = read("assets/council-votes.js");
  assert.match(shared, /replay\(ballotsList\.lastElementChild, "m-flash-green", 0\)/, "a new ballot flashes on its card");
  const member = read("member.html");
  assert.match(member, /card\.classList\.add\("cv-leaving"\)/, "a cast ballot slides out of Waiting");
  assert.match(member, /replay\(body\.firstElementChild, "m-flash-green", 0\)/, "the ballot flashes as the newest row in Ballots cast");
  assert.match(member, /replay\(\$\("mWaiting"\), "cv-count-bump"\)/, "waiting count ticks");
  assert.match(member, /replay\(\$\("mBallots"\), "cv-count-bump"\)/, "ballots count ticks");
  const audit = read("audit.html");
  assert.match(audit, /replay\(body\.firstElementChild, "m-flash-green", 0\)/, "a new audit entry flashes");
});

test("mandate adoption and payment signing animate when they land", () => {
  const mandate = read("mandate.html");
  assert.match(mandate, /cv-active m-reveal/, "the adopted instruction card reveals in");
  const consolePage = read("console.html");
  assert.match(consolePage, /const lastDecision = new Map\(\)/, "console tracks the last decision per proposal");
  assert.match(consolePage, /const decidedNow = land && decision/, "a landing decision is detected");
  assert.match(consolePage, /renderFlow\(\{ decision, check, large, approval, o \}, decidedNow\)/, "a landing decision replays the flow packet");
  assert.match(consolePage, /replay\(\$\("mStamp"\), "m-slam", 0\)/, "the stamp slams on a landing decision");
  assert.match(consolePage, /replay\(\$\("alert"\), decision === "SIGNED" \? "m-flash-green" : "m-flash-red", 0\)/, "the alert flashes green on a signing, red on a refusal");
  assert.match(consolePage, /tr\.classList\.add\("cv-row-new"\)/, "a new proposal row slides into the list");
});

test("live animations are quick, theme-only, and off under reduced motion", () => {
  const css = read("assets/motion.css");
  assert.match(css, /@keyframes cv-bump/, "count tick keyframes exist");
  assert.match(css, /@keyframes cv-row-in/, "row slide-in keyframes exist");
  assert.match(css, /\.cv-leaving\s*\{[^}]*transition: opacity \.55s/, "leaving transition is under a second");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.cv-count-bump, \.cv-row-new \{ animation: none !important; \}/, "new animations are off under reduced motion");
  // No new colours or fonts: only the tokens already in the file.
  const allowed = new Set(["#111110", "#3f9b45", "#8b857a", "#9a6b15", "#d8d3c6", "#e23b28", "#f2efe7"]);
  for (const hex of css.match(/#[0-9a-f]{6}/gi) ?? []) assert.ok(allowed.has(hex.toLowerCase()), `motion.css adds a new colour ${hex}`);
});
