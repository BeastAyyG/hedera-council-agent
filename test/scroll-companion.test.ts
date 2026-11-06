import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), "public", path), "utf8");

test("console mounts the scroll companion on the journey's decision", () => {
  const html = read("console.html");
  assert.match(html, /import \{ mountCompanion \} from "\/assets\/scroll-companion\.js"/);
  assert.match(html, /mountCompanion\(\{ decisionHost: \$\("journey"\) \}\)/);
});

test("scroll companion is presentation-only and honours reduced motion", () => {
  const js = read("assets/scroll-companion.js");
  const css = read("assets/council-scene.css");
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|localStorage/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.sc-ground/);
  for (const decision of ["SIGNED", "REFUSED", "CANCELLED", "PENDING_CHALLENGE"]) assert.ok(js.includes(decision));
});
