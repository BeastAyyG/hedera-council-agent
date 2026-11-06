// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Submission-readiness report: `npm run ready`.
// PASS = done, TODO = still needs the owner, FAIL = something is wrong.
// Exit code 1 only when a FAIL exists. Never prints secret values.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export type Status = "PASS" | "TODO" | "FAIL";
export interface Line {
  status: Status;
  text: string;
}
const line = (status: Status, text: string): Line => ({ status, text });

export function checkEnvNames(env: Record<string, string | undefined>, names: string[]): Line[] {
  return names.map((n) =>
    (env[n] ?? "").trim() ? line("PASS", `${n} is set`) : line("TODO", `${n} is not set`),
  );
}

function section(text: string, heading: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

export function checkReadme(text: string): Line[] {
  const body = section(text, /^#{1,3}\s+Hedera transaction IDs\s*$/i);
  if (body === null) return [line("FAIL", "README.md has no 'Hedera transaction IDs' section")];
  const out: Line[] = [];
  const sim = body.match(/\bSIM-[A-Z]+-[A-Za-z0-9]+/g);
  if (sim) out.push(line("FAIL", `README 'Hedera transaction IDs' contains simulated ids: ${[...new Set(sim)].join(", ")}`));
  const links = body.match(/https:\/\/hashscan\.io\/[^\s)>\]]+/g) ?? [];
  if (links.length) out.push(line("PASS", `README lists ${links.length} HashScan link(s)`));
  else out.push(line("TODO", "README 'Hedera transaction IDs' has no https://hashscan.io link yet (needs a real testnet payment)"));
  return out;
}

export function checkDebrief(text: string): Line[] {
  const todos = text.split(/\r?\n/).filter((l) => /\bTODO:/.test(l));
  return todos.length
    ? [line("TODO", `docs/world-debrief.md has ${todos.length} unfilled 'TODO:' line(s)`)]
    : [line("PASS", "docs/world-debrief.md has no TODO: lines")];
}

export function checkChecklist(text: string): Line[] {
  const items = text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (!items.length) return [line("FAIL", "docs/submission.md has no checklist items")];
  const open = items.filter((m) => m[1] === " ");
  const out: Line[] = [];
  for (const m of open) {
    const t = m[2]!;
    const special = /\bUI:|From Scratch|original-console|original (CODE_TANTRAFEST|console)/i.test(t);
    out.push(line("TODO", `${special ? "[FROM SCRATCH RULE] " : ""}${t}`));
  }
  out.push(
    open.length
      ? line("TODO", `${open.length} of ${items.length} checklist items unchecked`)
      : line("PASS", `all ${items.length} checklist items checked`),
  );
  return out;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Hedera DER private key", /(?:302e0201|3030020100)[0-9a-fA-F]{40,}/],
  ["sk- API key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["WORLD_SIGNING_KEY value", /WORLD_SIGNING_KEY\s*[=:]\s*["']?0x[0-9a-fA-F]{64}\b/],
];

export function scanForSecrets(files: Array<{ path: string; text: string }>): Line[] {
  const out: Line[] = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((l, i) => {
      for (const [kind, re] of SECRET_PATTERNS) {
        if (re.test(l)) out.push(line("FAIL", `possible ${kind} committed at ${f.path}:${i + 1} (value not shown)`));
      }
    });
  }
  return out.length ? out : [line("PASS", `no secret-looking values in ${files.length} tracked file(s)`)];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function checkGit(): Line[] {
  try {
    git(["rev-parse", "--git-dir"]);
  } catch {
    return [line("TODO", "git is not available here; check the working tree and push by hand")];
  }
  const out: Line[] = [];
  const dirty = git(["status", "--porcelain"]).split("\n").filter((l) => l && !l.startsWith("?? node_modules"));
  out.push(dirty.length ? line("TODO", `working tree has ${dirty.length} uncommitted change(s)`) : line("PASS", "git working tree is clean"));
  try {
    const ahead = Number(git(["rev-list", "--count", "@{u}..HEAD"]).trim());
    out.push(ahead ? line("TODO", `${ahead} commit(s) not pushed to upstream`) : line("PASS", "branch is pushed (nothing ahead of upstream)"));
  } catch {
    out.push(line("TODO", "branch has no upstream: push it"));
  }
  return out;
}

function trackedFiles(): Array<{ path: string; text: string }> {
  try {
    return git(["ls-files", "-z"])
      .split("\0")
      .filter((p) => p && !/\.(png|jpe?g|gif|webp|ico|woff2?|lock)$/i.test(p) && !p.endsWith("package-lock.json"))
      .flatMap((p) => {
        try {
          return [{ path: p, text: readFileSync(p, "utf8") }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const readText = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

export function checkDemo(scriptExists: boolean): Line[] {
  return [
    scriptExists ? line("PASS", "docs/demo-script.md exists") : line("FAIL", "docs/demo-script.md is missing"),
    line("TODO", "Video: 2-3 minutes, human voiceover (no TTS), 720p or better, not sped up, intro under 20 seconds"),
  ];
}

export function buildReport(env: Record<string, string | undefined>): Array<{ group: string; lines: Line[] }> {
  const missing = (p: string) => [line("FAIL", `${p} is missing`)];
  const readme = readText("README.md");
  const debrief = readText("docs/world-debrief.md");
  const checklist = readText("docs/submission.md");
  return [
    { group: "Code", lines: [...checkGit(), ...scanForSecrets(trackedFiles())] },
    {
      group: "Real mode proof",
      lines: [
        ...checkEnvNames(env, ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "ZERO_G_API_KEY", "WORLD_RP_ID", "WORLD_APP_ID", "WORLD_SIGNING_KEY"]),
        ...(readme === null ? missing("README.md") : checkReadme(readme)),
        ...(debrief === null ? missing("docs/world-debrief.md") : checkDebrief(debrief)),
      ],
    },
    { group: "Rules", lines: checklist === null ? missing("docs/submission.md") : checkChecklist(checklist) },
    { group: "Demo", lines: checkDemo(existsSync("docs/demo-script.md")) },
  ];
}

export function render(report: ReturnType<typeof buildReport>): { text: string; fails: number } {
  let fails = 0;
  const rows: string[] = [];
  for (const g of report) {
    rows.push(`\n${g.group}`);
    for (const l of g.lines) {
      if (l.status === "FAIL") fails += 1;
      rows.push(`  ${l.status.padEnd(4)}  ${l.text}`);
    }
  }
  return { text: rows.join("\n"), fails };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text, fails } = render(buildReport(process.env));
  console.log(text);
  console.log(fails ? `\n${fails} FAIL line(s): fix before submitting.` : "\nNo FAIL lines. Resolve the TODO lines before submitting.");
  process.exitCode = fails ? 1 : 0;
}
