#!/usr/bin/env node
/**
 * commit-policy gate (spec §12, CONTRIBUTING.md): every commit offered for
 * merge must have a Conventional Commits subject and — if present — a
 * role-only `AI-assisted: yes` trailer (never development-tool or model
 * identities, AGENTS.md §0). Human DCO sign-off is not required at the
 * current stage. `.github/workflows/commit-policy.yml` runs this script from
 * the base revision and therefore does not require `Signed-off-by`. The
 * secret is not loaded by the pull_request workflow.
 *
 * The author, the committer, and the full message are all checked, including
 * merge commits (only the conventional-subject rule is skipped for those).
 * An `AI-assisted:` line must be exactly `AI-assisted: yes`. Other URLs are
 * allowed. A URL or other text fails when it matches a forbidden identity
 * regex. CI reads those regexes from the `COMMIT_IDENTITY_PATTERNS`
 * environment variable, one per line. Nothing in the repository stores the
 * patterns or their digests. A push, or a pull request whose head repository
 * is this repository (or is not identified), fails closed when the variable
 * is unset or blank. A pull request from a fork — the event is
 * `pull_request` or `pull_request_target`, and `PR_HEAD_REPO` differs from
 * `GITHUB_REPOSITORY` — logs a skip notice and does not fail. A run outside
 * GitHub Actions still checks subjects and the gitignored
 * `.private-markers.local` file. A git-history run loads that file from the
 * repository root. `--head` selects a fetched commit without checking it
 * out. History records are separated by NUL (`git log -z` and `%x00`);
 * commit objects cannot contain that byte, so a message cannot split a
 * record. The secret value is never printed.
 *
 * Modes:
 *   (default)     check `git log <base>..<head>`; head = --head, else HEAD.
 *                 base = --base, else origin/dev
 *                 when it exists, else HEAD (an empty range passes vacuously —
 *                 enforcement happens on PRs in CI).
 *   --file <path> check records from a file; records separated by a line
 *                 containing only `===`. A record may start with `author:`
 *                 and `committer:` lines; the rest is the message.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    base: { type: "string" },
    head: { type: "string" },
    cwd: { type: "string" },
  },
});

const IDENTITY_SECRET = "COMMIT_IDENTITY_PATTERNS";

const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: \S.*/;
const AI_TRAILER = /^AI-assisted:.*$/gim;

const identityPatterns = [];

const addPatterns = (text, origin) => {
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      identityPatterns.push(new RegExp(line, "i"));
    } catch {
      console.error(`commit-policy: invalid identity pattern in ${origin} at line ${i + 1} — FAIL CLOSED`);
      process.exit(1);
    }
  });
};

const secret = process.env[IDENTITY_SECRET];
const secretMissing = typeof secret !== "string" || secret.trim() === "";
const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const baseRepo = process.env.GITHUB_REPOSITORY ?? "";
const headRepo = process.env.PR_HEAD_REPO ?? "";
const pullRequestEvent = eventName === "pull_request" || eventName === "pull_request_target";
const forkPullRequest =
  pullRequestEvent && headRepo !== "" && baseRepo !== "" && headRepo !== baseRepo;
const upstreamEvent = eventName === "push" || pullRequestEvent;

if (!secretMissing) {
  addPatterns(secret, IDENTITY_SECRET);
} else if (forkPullRequest) {
  console.log(
    `commit-policy: ${IDENTITY_SECRET} is not set — skipping forbidden-identity checks (pull request from a fork; repository secrets are not available)`,
  );
} else if (upstreamEvent) {
  console.error(
    `commit-policy: ${IDENTITY_SECRET} is not set on this repository (${eventName}) — FAIL CLOSED`,
  );
  process.exit(1);
}

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

if (!values.file) {
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: values.cwd, encoding: "utf8" }).trim();
  } catch {
    top = "";
  }
  if (top && existsSync(`${top}/.private-markers.local`)) {
    addPatterns(readFileSync(`${top}/.private-markers.local`, "utf8"), ".private-markers.local");
  }
}

const matchesIdentity = (text) => Boolean(text) && identityPatterns.some((pattern) => pattern.test(text));

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
  const headRev = values.head || "HEAD";
  let out;
  try {
    out = execFileSync(
      "git",
      ["log", "-z", "--format=%h%x00%an%x00%ae%x00%cn%x00%ce%x00%B", `${base}..${headRev}`],
      { cwd: values.cwd, encoding: "utf8" },
    );
  } catch (err) {
    console.error(`commit-policy: cannot read git history for ${base}..${headRev} (${err.message}) — FAIL CLOSED`);
    process.exit(1);
  }
  const parts = out.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length % 6 !== 0) {
    console.error("commit-policy: malformed git record — FAIL CLOSED");
    process.exit(1);
  }
  for (let i = 0; i < parts.length; i += 6) {
    records.push({
      id: parts[i],
      author: `${parts[i + 1]} <${parts[i + 2]}>`,
      committer: `${parts[i + 3]} <${parts[i + 4]}>`,
      message: parts[i + 5].trim(),
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
