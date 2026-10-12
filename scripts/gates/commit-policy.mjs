#!/usr/bin/env node
/**
 * commit-policy gate (spec §12, CONTRIBUTING.md): every commit offered for
 * merge must have a Conventional Commits subject, a human DCO sign-off, and —
 * if present — a role-only `AI-assisted: yes` trailer (never development-tool
 * or model identities, AGENTS.md §0).
 *
 * Modes:
 *   (default)     check `git log <base>..HEAD`; base = --base, else origin/main
 *                 when it exists, else HEAD (an empty range passes vacuously —
 *                 enforcement happens on PRs in CI).
 *   --file <path> check messages from a file; records separated by a line
 *                 containing only `===`.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { file: { type: "string" }, base: { type: "string" } } });

const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S.*/;
const SIGNOFF = /^Signed-off-by: .+ <[^<>]+@[^<>]+>$/m;
const AI_TRAILER = /^AI-assisted:.*$/gim;

const records = [];
if (values.file) {
  const body = readFileSync(values.file, "utf8");
  body.split(/^===$/m).forEach((chunk, i) => {
    const message = chunk.trim();
    if (message) records.push({ id: `record-${i + 1}`, message });
  });
} else {
  let base = values.base;
  if (!base) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: "pipe" });
      base = "origin/main";
    } catch {
      base = "HEAD";
    }
  }
  let out;
  try {
    out = execFileSync("git", ["log", "--format=%h%x1f%B%x1e", `${base}..HEAD`], { encoding: "utf8" });
  } catch (err) {
    console.error(`commit-policy: cannot read git history for ${base}..HEAD (${err.message}) — FAIL CLOSED`);
    process.exit(1);
  }
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("\x1f");
    records.push({ id: trimmed.slice(0, sep), message: trimmed.slice(sep + 1).trim() });
  }
}

const violations = [];
for (const { id, message } of records) {
  const subject = message.split("\n")[0];
  if (!subject.startsWith("Merge ") && !SUBJECT.test(subject)) {
    violations.push(`${id}: non-conventional subject "${subject.slice(0, 60)}"`);
  }
  if (!SIGNOFF.test(message)) violations.push(`${id}: missing human DCO sign-off (Signed-off-by: Name <email>)`);
  for (const m of message.matchAll(AI_TRAILER)) {
    if (m[0].trim() !== "AI-assisted: yes") {
      violations.push(`${id}: identity-bearing trailer "${m[0].trim()}" — role-only \`AI-assisted: yes\` (AGENTS.md §0)`);
    }
  }
}

if (violations.length) {
  console.error("commit-policy: FAIL\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log(`commit-policy: OK (${records.length} commit message(s) checked)`);
