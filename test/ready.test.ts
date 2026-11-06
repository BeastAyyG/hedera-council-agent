// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
import test from "node:test";
import assert from "node:assert/strict";
import { checkChecklist, checkDebrief, checkEnvNames, checkReadme, render, scanForSecrets } from "../src/ready.js";

const st = (lines: Array<{ status: string }>) => lines.map((l) => l.status);

test("env check reports names only, never values", () => {
  const lines = checkEnvNames({ A_KEY: "supersecretvalue", B_KEY: "  " }, ["A_KEY", "B_KEY", "C_KEY"]);
  assert.deepEqual(st(lines), ["PASS", "TODO", "TODO"]);
  assert.ok(!JSON.stringify(lines).includes("supersecretvalue"));
});

test("README: placeholder section is TODO, real link PASS, SIM- id FAIL", () => {
  const wrap = (body: string) => `# T\n\n## Hedera transaction IDs\n\n${body}\n\n## What is not in scope\nSIM-OUTSIDE\n`;
  assert.deepEqual(st(checkReadme(wrap("- tx: (none yet)"))), ["TODO"]);
  assert.deepEqual(st(checkReadme(wrap("Do not put SIM- ids here.\n- tx: (none yet)"))), ["TODO"]);
  assert.deepEqual(st(checkReadme(wrap("- [tx](https://hashscan.io/testnet/transaction/0.0.1-1-2)"))), ["PASS"]);
  const bad = checkReadme(wrap("- tx SIM-PAY-123, https://hashscan.io/testnet/transaction/0.0.1-1-2"));
  assert.ok(st(bad).includes("FAIL"));
  assert.ok(bad[0]!.text.includes("SIM-PAY-123"));
  assert.deepEqual(st(checkReadme("# nothing")), ["FAIL"]);
});

test("debrief: TODO: lines are TODO, none is PASS", () => {
  assert.deepEqual(st(checkDebrief("## a\nTODO: minutes\nTODO: more")), ["TODO"]);
  assert.deepEqual(st(checkDebrief("## a\nIt took 12 minutes.")), ["PASS"]);
});

test("checklist lists every unchecked item and flags From Scratch ones", () => {
  const md = "- [x] done thing\n- [ ] UI: confirm From Scratch\n- [ ] Demo video uploaded\n";
  const lines = checkChecklist(md);
  assert.equal(lines.filter((l) => l.status === "TODO").length, 3);
  assert.ok(lines[0]!.text.startsWith("[FROM SCRATCH RULE]"));
  assert.ok(!lines[1]!.text.startsWith("[FROM SCRATCH RULE]"));
  assert.deepEqual(st(checkChecklist("- [x] a\n- [X] b")), ["PASS"]);
});

test("scanForSecrets flags planted keys without printing them", () => {
  const der = "302e0201" + "ab".repeat(40);
  const sk = "sk-" + "A1b2".repeat(6);
  const world = "WORLD_SIGNING_KEY=0x" + "cd".repeat(32);
  const files = [
    { path: "a.txt", text: `key ${der}` },
    { path: "b.txt", text: `x\n${sk}` },
    { path: "c.env", text: world },
    { path: "ok.md", text: "WORLD_SIGNING_KEY=0x… and sk-short and 302e0201" },
  ];
  const lines = scanForSecrets(files);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.status === "FAIL"));
  assert.ok(lines[1]!.text.includes("b.txt:2"));
  const all = JSON.stringify(lines);
  assert.ok(![der, sk, world.slice(18)].some((s) => all.includes(s)));
  assert.deepEqual(st(scanForSecrets([files[3]!])), ["PASS"]);
});

test("render counts FAIL lines", () => {
  const r = render([{ group: "G", lines: [{ status: "PASS", text: "a" }, { status: "FAIL", text: "b" }] }]);
  assert.equal(r.fails, 1);
  assert.ok(r.text.includes("FAIL  b"));
});
