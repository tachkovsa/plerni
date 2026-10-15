#!/usr/bin/env node
/**
 * commit-policy gate (spec §12, CONTRIBUTING.md): every commit offered for
 * merge must have a Conventional Commits subject and — if present — a
 * role-only `AI-assisted: yes` trailer (never development-tool or model
 * identities, AGENTS.md §0). Human DCO sign-off is not required at the
 * current stage; the CI step in `.github/workflows/p0-gates.yml` runs this
 * script and therefore does not require `Signed-off-by`.
 *
 * The author, the committer, and the full message are all checked, including
 * merge commits (only the conventional-subject rule is skipped for those).
 * An `AI-assisted:` line must be exactly `AI-assisted: yes`. Other URLs are
 * allowed. A URL or other text fails when it matches a forbidden identity
 * rule. CI always loads the committed list `commit-identities.txt` next to
 * this script. A rule is either a generic regex or `sha256:` plus the hex
 * digest of a lowercase forbidden substring, so the list can name an identity
 * without spelling it. `--identities <file>` adds more rules. A git-history
 * run also loads the gitignored `.private-markers.local` at the repository
 * root. None of those files may spell private vendor or model names.
 *
 * Modes:
 *   (default)     check `git log <base>..HEAD`; base = --base, else origin/dev
 *                 when it exists, else HEAD (an empty range passes vacuously —
 *                 enforcement happens on PRs in CI).
 *   --file <path> check records from a file; records separated by a line
 *                 containing only `===`. A record may start with `author:`
 *                 and `committer:` lines; the rest is the message.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    base: { type: "string" },
    identities: { type: "string" },
    cwd: { type: "string" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const GOVERNED_IDENTITIES = join(here, "commit-identities.txt");

const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S.*/;
const AI_TRAILER = /^AI-assisted:.*$/gim;

const loadIdentityRules = (path) => {
  const patterns = [];
  const hashes = [];
  if (!path || !existsSync(path)) return { patterns, hashes };
  readFileSync(path, "utf8").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const hash = /^sha256:([0-9a-f]{64})$/i.exec(line);
    if (hash) {
      hashes.push(hash[1].toLowerCase());
      return;
    }
    if (line.toLowerCase().startsWith("sha256:")) {
      console.error(`commit-policy: invalid identity hash at ${path}:${i + 1} — FAIL CLOSED`);
      process.exit(1);
    }
    try {
      patterns.push(new RegExp(line, "i"));
    } catch (err) {
      console.error(`commit-policy: invalid identity pattern at ${path}:${i + 1} (${err.message}) — FAIL CLOSED`);
      process.exit(1);
    }
  });
  return { patterns, hashes };
};

const digest = (text) => createHash("sha256").update(text).digest("hex");

// Hashes are of short identity fragments. A window cap keeps the scan bounded.
const HASH_WINDOW = 160;

const parseFileRecord = (chunk) => {
  const lines = chunk.trim().split("\n");
  let author = "";
  let committer = "";
  let start = 0;
  while (start < lines.length) {
    const authorLine = /^author:\s*(.*)$/i.exec(lines[start]);
    const committerLine = /^committer:\s*(.*)$/i.exec(lines[start]);
    if (authorLine) {
      author = authorLine[1].trim();
      start++;
      continue;
    }
    if (committerLine) {
      committer = committerLine[1].trim();
      start++;
      continue;
    }
    break;
  }
  if ((author || committer) && lines[start]?.trim() === "") start++;
  return { author, committer, message: lines.slice(start).join("\n").trim() };
};

const identityPatterns = [];
const identityHashes = new Set();
const addIdentityRules = (path) => {
  const loaded = loadIdentityRules(path);
  identityPatterns.push(...loaded.patterns);
  for (const hash of loaded.hashes) identityHashes.add(hash);
};
addIdentityRules(GOVERNED_IDENTITIES);
if (identityPatterns.length + identityHashes.size === 0) {
  console.error(`commit-policy: governed identity list ${GOVERNED_IDENTITIES} is missing or empty — FAIL CLOSED`);
  process.exit(1);
}
addIdentityRules(values.identities);
if (!values.file) {
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: values.cwd, encoding: "utf8" }).trim();
  } catch {
    top = "";
  }
  if (top) addIdentityRules(`${top}/.private-markers.local`);
}

const matchesIdentity = (text) => {
  if (!text) return false;
  if (identityPatterns.some((pattern) => pattern.test(text))) return true;
  if (identityHashes.size === 0) return false;
  const value = text.toLowerCase();
  const max = Math.min(value.length, HASH_WINDOW);
  for (let len = 1; len <= max; len++) {
    for (let i = 0; i + len <= value.length; i++) {
      if (identityHashes.has(digest(value.slice(i, i + len)))) return true;
    }
  }
  return false;
};

const records = [];
if (values.file) {
  const body = readFileSync(values.file, "utf8");
  body.split(/^===$/m).forEach((chunk, i) => {
    const rec = parseFileRecord(chunk);
    if (rec.message || rec.author || rec.committer) records.push({ id: `record-${i + 1}`, ...rec });
  });
} else {
  let base = values.base;
  if (!base) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/dev"], { cwd: values.cwd, stdio: "pipe" });
      base = "origin/dev";
    } catch {
      base = "HEAD";
    }
  }
  let out;
  try {
    out = execFileSync(
      "git",
      ["log", "--format=%h%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", `${base}..HEAD`],
      { cwd: values.cwd, encoding: "utf8" },
    );
  } catch (err) {
    console.error(`commit-policy: cannot read git history for ${base}..HEAD (${err.message}) — FAIL CLOSED`);
    process.exit(1);
  }
  for (const rec of out.split("\x1e")) {
    const trimmed = rec.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\x1f");
    if (parts.length < 6) {
      console.error(`commit-policy: malformed git record — FAIL CLOSED`);
      process.exit(1);
    }
    records.push({
      id: parts[0],
      author: `${parts[1]} <${parts[2]}>`,
      committer: `${parts[3]} <${parts[4]}>`,
      message: parts.slice(5).join("\x1f").trim(),
    });
  }
}

const violations = [];
for (const { id, author = "", committer = "", message } of records) {
  const subject = message.split("\n")[0];
  // Merge subjects are not Conventional Commits. Identity metadata is still checked.
  if (!subject.startsWith("Merge ") && !SUBJECT.test(subject)) {
    violations.push(`${id}: non-conventional subject "${subject.slice(0, 60)}"`);
  }
  for (const [label, text] of [
    ["author", author],
    ["committer", committer],
    ["message", message],
  ]) {
    if (matchesIdentity(text)) {
      violations.push(`${id}: ${label} matches a forbidden identity`);
    }
    for (const m of text.matchAll(AI_TRAILER)) {
      if (m[0].trim() !== "AI-assisted: yes") {
        violations.push(
          `${id}: identity-bearing ${label} "${m[0].trim()}" — role-only \`AI-assisted: yes\` (AGENTS.md §0)`,
        );
      }
    }
  }
}

if (violations.length) {
  console.error("commit-policy: FAIL\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log(`commit-policy: OK (${records.length} commit message(s) checked)`);
