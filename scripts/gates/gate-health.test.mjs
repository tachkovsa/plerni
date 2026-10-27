#!/usr/bin/env node
/**
 * gate-health suite (spec §12, principle 16): proves the gates can fail AND
 * that they pass clean input. Every gate runs against deliberately-bad fixtures
 * (must block with its own diagnostic — a crash is not proof) and against
 * positive controls (must pass). The secrets gate blocks the planted synthetic
 * fixture and accepts clean input (scripts/gates/secrets.mjs). Its negative
 * proof asserts the planted gitleaks finding (see .github/workflows/p0-gates.yml).
 * The approval verifier's four fail-closed cases are artifact missing, digest
 * mismatch, bad signature, and head-key substitution.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

const gate = (script, ...args) => [process.execPath, [join(here, script), ...args]];

const cases = [
  {
    name: "kernel-purity blocks a whole-word domain noun in kernel code",
    cmd: gate("kernel-purity.mjs", "--root", join(fixtures, "kernel-noun")),
    expectExit: 1,
    expectOutput: /domain noun/,
  },
  {
    name: "kernel-purity accepts noun-free kernel code",
    cmd: gate("kernel-purity.mjs", "--root", join(fixtures, "kernel-valid")),
    expectExit: 0,
  },
  {
    name: "license-audit blocks a GPL dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "gpl-dep")),
    expectExit: 1,
    expectOutput: /forbidden license "GPL/,
  },
  {
    name: "license-audit blocks a GPL devDependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "dev-gpl")),
    expectExit: 1,
    expectOutput: /forbidden license "GPL/,
  },
  {
    name: "license-audit blocks the locked child when an older copy is installed",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "pnpm-locked-child")),
    expectExit: 1,
    expectOutput:
      /shared-child@2\.0\.0 \(dependency of fake-absent \(optional dependency of fake-mit-lib\)\), verified from pnpm-lock.yaml: forbidden license "GPL-3.0-only"/,
  },
  {
    name: "license-audit blocks a required peer of a pnpm-locked absent optional package",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "pnpm-peer")),
    expectExit: 1,
    expectOutput:
      /fake-gpl-peer@1\.0\.0 \(peer of fake-absent \(optional dependency of fake-mit-lib\)\), verified from pnpm-lock.yaml: forbidden license "GPL-3.0-only"(?![\s\S]*fake-optional-peer)/,
  },
  {
    name: "license-audit keeps a dependency install when a later peer reuses the name",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "peer-overwrites-dep")),
    expectExit: 1,
    expectOutput: /shared-lib: forbidden license "GPL/,
  },
  {
    name: "license-audit accepts an MIT dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "mit-dep")),
    expectExit: 0,
  },
  {
    name: "license-audit blocks a GPL dependency declared outside the workspace",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-gpl")),
    expectExit: 1,
    expectOutput: /forbidden license "GPL/,
  },
  {
    name: "license-audit rejects a tarball that repeats package/package.json",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-duplicate")),
    expectExit: 1,
    expectOutput: /tarball contains more than one package\/package.json/,
  },
  {
    name: "license-audit accepts an MIT dependency declared outside the workspace",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-mit")),
    expectExit: 0,
  },
  {
    name: "license-audit blocks a forbidden license on an installed optional dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-transitive")),
    expectExit: 1,
    expectOutput:
      /fake-lgpl-lib \(verified optional dependency of fake-mit-lib \(verified dependency of brand\)\): forbidden license "LGPL-3.0-or-later"(?![\s\S]*fake-other-platform)/,
  },
  {
    name: "license-audit blocks a forbidden license on an installed peer dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-peer")),
    expectExit: 1,
    expectOutput:
      /fake-gpl-peer \(verified peer of fake-mit-lib \(verified dependency of brand\)\): forbidden license "GPL-3.0-only"/,
  },
  {
    name: "license-audit blocks a required root peer when the package has no other dependencies",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-root-peer")),
    expectExit: 1,
    expectOutput:
      /fake-gpl-peer \(verified peer of brand\): forbidden license "GPL-3.0-only"(?![\s\S]*fake-optional-peer)/,
  },
  {
    name: "license-audit blocks a forbidden tarball license when the lockfile license field is allowlisted",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-foreign")),
    expectExit: 1,
    expectOutput:
      /fake-darwin-gpl \(verified optional dependency of fake-mit-lib \(verified dependency of brand\)\): forbidden license "GPL-3.0-only"/,
  },
  {
    name: "license-audit blocks a required peer of an absent optional package",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-absent-peer")),
    expectExit: 1,
    expectOutput:
      /fake-gpl-peer \(verified peer of fake-darwin-mit \(verified optional dependency of fake-mit-lib \(verified dependency of brand\)\)\): forbidden license "GPL-3.0-only"(?![\s\S]*fake-optional-peer)/,
  },
  {
    name: "license-audit blocks the locked child version when another version is installed",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-locked-child")),
    expectExit: 1,
    expectOutput:
      /shared-child \(verified dependency of fake-darwin-app \(verified optional dependency of fake-mit-lib \(verified dependency of brand\)\)\): forbidden license "GPL-3.0-only"/,
  },
  {
    name: "license-audit fails closed when an absent optional dependency has no verifiable tarball",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-unverified")),
    expectExit: 1,
    expectOutput:
      /fake-no-tarball \(verified optional dependency of fake-mit-lib \(verified dependency of brand\)\): lockfile entry has no integrity-checked tarball/,
  },
  {
    name: "license-audit blocks an isolated package with no lockfile",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-nolock")),
    expectExit: 1,
    expectOutput: /package-lock.json is missing/,
  },
  {
    name: "license-audit blocks a lockfile version outside the manifest range",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-stale")),
    expectExit: 1,
    expectOutput: /does not satisfy/,
  },
  {
    name: "private-markers blocks machine-local paths/IPs",
    cmd: gate("private-markers.mjs", "--root", join(fixtures, "private-path")),
    expectExit: 1,
    expectOutput: /machine-local|RFC1918/,
  },
  {
    name: "private-markers blocks a maintainer-local pattern (.private-markers.local)",
    cmd: gate("private-markers.mjs", "--root", join(fixtures, "private-local")),
    expectExit: 1,
    expectOutput: /local private pattern/,
  },
  {
    name: "private-markers accepts a clean tree",
    cmd: gate("private-markers.mjs", "--root", join(fixtures, "clean-tree")),
    expectExit: 0,
  },
  {
    name: "commit-policy blocks bad subjects and identity trailers",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "bad-messages.txt")),
    expectExit: 1,
    expectOutput: /non-conventional subject|identity-bearing/,
  },
  {
    name: "commit-policy accepts compliant messages",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "good-messages.txt")),
    expectExit: 0,
  },
  {
    name: "commit-policy blocks a configured identity in the author, committer, or message",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "bad-metadata.txt")),
    env: { COMMIT_IDENTITY_PATTERNS: "forbidden-provider\\.example" },
    expectExit: 1,
    expectOutput:
      /author matches a forbidden identity[\s\S]*committer matches a forbidden identity[\s\S]*message matches a forbidden identity[\s\S]*identity-bearing author/,
  },
  {
    name: "commit-policy checks identity metadata on merge commits",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: { COMMIT_IDENTITY_PATTERNS: "forbidden-provider\\.example" },
    expectExit: 1,
    expectOutput: /^(?![\s\S]*non-conventional subject)[\s\S]*author matches a forbidden identity/,
  },
  {
    name: "commit-policy skips identity checks on a fork pull request when the secret is unset",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/plerni",
      PR_HEAD_REPO: "other/plerni",
    },
    expectExit: 0,
    expectOutput:
      /COMMIT_IDENTITY_PATTERNS is not set — skipping forbidden-identity checks \(pull request from a fork; repository secrets are not available\)/,
  },
  {
    name: "commit-policy fails closed on a push when COMMIT_IDENTITY_PATTERNS is unset",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REPOSITORY: "example/plerni",
    },
    expectExit: 1,
    expectOutput: /COMMIT_IDENTITY_PATTERNS is not set on this repository \(push\) — FAIL CLOSED(?![\s\S]*skipping forbidden-identity checks)/,
  },
  {
    name: "commit-policy fails closed on a same-repo pull request when COMMIT_IDENTITY_PATTERNS is unset",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/plerni",
      PR_HEAD_REPO: "example/plerni",
    },
    expectExit: 1,
    expectOutput:
      /COMMIT_IDENTITY_PATTERNS is not set on this repository \(pull_request\) — FAIL CLOSED(?![\s\S]*skipping forbidden-identity checks)/,
  },
  {
    name: "commit-policy skips identity checks on a fork pull_request_target when the secret is unset",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REPOSITORY: "example/plerni",
      PR_HEAD_REPO: "other/plerni",
    },
    expectExit: 0,
    expectOutput:
      /COMMIT_IDENTITY_PATTERNS is not set — skipping forbidden-identity checks \(pull request from a fork; repository secrets are not available\)/,
  },
  {
    name: "commit-policy fails closed on a same-repo pull_request_target when COMMIT_IDENTITY_PATTERNS is unset",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REPOSITORY: "example/plerni",
      PR_HEAD_REPO: "example/plerni",
    },
    expectExit: 1,
    expectOutput:
      /COMMIT_IDENTITY_PATTERNS is not set on this repository \(pull_request_target\) — FAIL CLOSED(?![\s\S]*skipping forbidden-identity checks)/,
  },
  {
    name: "commit-policy fails closed on a pull request when the head repository is not identified",
    cmd: gate("commit-policy.mjs", "--file", join(fixtures, "commit-policy", "merge-metadata.txt")),
    env: {
      COMMIT_IDENTITY_PATTERNS: "",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "example/plerni",
      PR_HEAD_REPO: "",
    },
    expectExit: 1,
    expectOutput:
      /COMMIT_IDENTITY_PATTERNS is not set on this repository \(pull_request\) — FAIL CLOSED(?![\s\S]*skipping forbidden-identity checks)/,
  },
];

const historyDir = mkdtempSync(join(tmpdir(), "plerni-commit-policy-"));
const historyGit = (args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: historyDir,
    encoding: "utf8",
  });
historyGit(["init", "-q", "-b", "main"]);
writeFileSync(join(historyDir, "README.md"), "one\n");
historyGit(["add", "README.md"]);
historyGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@example.com",
  "commit", "-q",
  "-m", "feat: start\n\nhttps://docs.npmjs.com/cli/v7/configuring-npm/package-json\n\nAI-assisted: yes\n",
]);
const historyBase = historyGit(["rev-parse", "HEAD"]).trim();
writeFileSync(join(historyDir, "note.md"), "two\n");
historyGit(["add", "note.md"]);
historyGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@forbidden-provider.example",
  "commit", "-q",
  "-m", "feat: record a run\n\nhttps://forbidden-provider.example/dashboard/1\n\nAI-assisted: yes\n",
]);
const historyHead = historyGit(["rev-parse", "HEAD"]).trim();
historyGit(["checkout", "-q", historyBase]);
cases.push({
  name: "commit-policy history mode reads a fetched commit without checking it out",
  cmd: gate("commit-policy.mjs", "--cwd", historyDir, "--base", historyBase, "--head", historyHead),
  env: { COMMIT_IDENTITY_PATTERNS: "forbidden-provider\\.example" },
  expectExit: 1,
  expectOutput: /author matches a forbidden identity[\s\S]*message matches a forbidden identity/,
});
historyGit(["checkout", "-q", "-b", "delimiters"]);
writeFileSync(join(historyDir, "delim.md"), "three\n");
historyGit(["add", "delim.md"]);
historyGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@example.com",
  "commit", "-q",
  "-m", "feat: keep record separators in the message\n\nline\x1emore\x1fstill\n\nAI-assisted: yes\n",
]);
const delimClean = historyGit(["rev-parse", "HEAD"]).trim();
writeFileSync(join(historyDir, "inject.md"), "four\n");
historyGit(["add", "inject.md"]);
historyGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@example.com",
  "commit", "-q",
  "-m", "feat: hide a marker past a record separator\n\nAI-assisted: yes\n\x1eforbidden-provider.example\x1f\x1f\x1f\x1f\x1f\n",
]);
const delimBad = historyGit(["rev-parse", "HEAD"]).trim();
historyGit(["checkout", "-q", historyBase]);
cases.push({
  name: "commit-policy history mode keeps a message intact when it contains record separators",
  cmd: gate("commit-policy.mjs", "--cwd", historyDir, "--base", historyBase, "--head", delimClean),
  env: { COMMIT_IDENTITY_PATTERNS: "forbidden-provider\\.example" },
  expectExit: 0,
  expectOutput: /OK \(1 commit message/,
});
cases.push({
  name: "commit-policy history mode still sees an identity placed after an injected record separator",
  cmd: gate("commit-policy.mjs", "--cwd", historyDir, "--base", delimClean, "--head", delimBad),
  env: { COMMIT_IDENTITY_PATTERNS: "forbidden-provider\\.example" },
  expectExit: 1,
  expectOutput: /message matches a forbidden identity/,
});

const standIn = "Marker Example <marker@synthetic-standin.example>";
const standInParts = /^(.*) <([^>]+)>$/.exec(standIn);
if (!standInParts) throw new Error("identity stand-in is malformed");
const identityDir = mkdtempSync(join(tmpdir(), "plerni-commit-identity-"));
writeFileSync(
  join(identityDir, "probe.txt"),
  `author: ${standIn}\ncommitter: ${standIn}\n\nfeat: keep the message clean\n\nAI-assisted: yes\n`,
);
cases.push({
  name: "commit-policy file mode applies a synthetic pattern from the environment",
  cmd: gate("commit-policy.mjs", "--file", join(identityDir, "probe.txt")),
  env: { COMMIT_IDENTITY_PATTERNS: "synthetic-standin\\.example" },
  expectExit: 1,
  expectOutput: /author matches a forbidden identity[\s\S]*committer matches a forbidden identity(?![\s\S]*message matches)/,
});
const identityGit = (args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: identityDir,
    encoding: "utf8",
  });
identityGit(["init", "-q", "-b", "main"]);
writeFileSync(join(identityDir, "README.md"), "one\n");
identityGit(["add", "README.md"]);
identityGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@example.com",
  "commit", "-q",
  "-m", "feat: start\n\nhttps://docs.npmjs.com/cli/v7/configuring-npm/package-json\n\nAI-assisted: yes\n",
]);
const identityBase = identityGit(["rev-parse", "HEAD"]).trim();
identityGit(["checkout", "-q", "-b", "side"]);
writeFileSync(join(identityDir, "note.md"), "two\n");
identityGit(["add", "note.md"]);
identityGit([
  "-c", "user.name=Dev Example",
  "-c", "user.email=dev@example.com",
  "commit", "-q",
  "-m", "docs: note\n\nAI-assisted: yes\n",
]);
identityGit(["checkout", "-q", "main"]);
identityGit([
  "-c", `user.name=${standInParts[1]}`,
  "-c", `user.email=${standInParts[2]}`,
  "merge", "-q", "--no-ff", "-m", "Merge branch 'side'\n\nAI-assisted: yes\n", "side",
]);
writeFileSync(join(identityDir, ".private-markers.local"), "synthetic-standin\\.example\n");
cases.push({
  name: "commit-policy history mode applies a synthetic pattern from the environment",
  cmd: gate("commit-policy.mjs", "--cwd", identityDir, "--base", identityBase),
  env: { COMMIT_IDENTITY_PATTERNS: "synthetic-standin\\.example" },
  expectExit: 1,
  expectOutput: /author matches a forbidden identity[\s\S]*committer matches a forbidden identity/,
});
cases.push({
  name: "commit-policy history mode still loads .private-markers.local when the secret is absent",
  cmd: gate("commit-policy.mjs", "--cwd", identityDir, "--base", identityBase),
  env: { COMMIT_IDENTITY_PATTERNS: "" },
  expectExit: 1,
  expectOutput: /author matches a forbidden identity(?![\s\S]*skipping forbidden-identity checks)/,
});
cases.push({
  name: "commit-policy fails closed when COMMIT_IDENTITY_PATTERNS compiles no patterns",
  cmd: gate("commit-policy.mjs", "--cwd", identityDir, "--base", identityBase),
  env: { COMMIT_IDENTITY_PATTERNS: "# comment only\n" },
  expectExit: 1,
  expectOutput: /contains no effective patterns — FAIL CLOSED(?![\s\S]*author matches a forbidden identity)/,
});

const approvalRoot = mkdtempSync(join(tmpdir(), "plerni-approval-"));
const approvalKeys = mkdtempSync(join(tmpdir(), "plerni-approval-keys-"));
const approvalGit = (cwd, args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
const newApprovalKey = (name) => {
  const file = join(approvalKeys, name);
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", file, "-N", "", "-C", "plerni-gate-approval-test"], {
    stdio: "ignore",
  });
  return file;
};
const approvalKeyA = newApprovalKey("a");
const approvalKeyB = newApprovalKey("b");
const approvalKeyC = newApprovalKey("c");
const commitTree = (dir, message) => {
  approvalGit(dir, ["add", "-A"]);
  approvalGit(dir, [
    "-c", "user.name=Dev Example",
    "-c", "user.email=dev@example.com",
    "commit", "-q", "-m", message,
  ]);
  return approvalGit(dir, ["rev-parse", "HEAD"]).trim();
};
const repoWithBaseKey = (pubFile) => {
  const dir = mkdtempSync(join(approvalRoot, "repo-"));
  approvalGit(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "scripts/gates/approvals"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/p0-gates.yml"), "base\n");
  if (pubFile) writeFileSync(join(dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${pubFile}.pub`));
  return { dir, base: commitTree(dir, "ci: base approval key") };
};
const scopeOf = (dir, base, head) => {
  const out = execFileSync(process.execPath, [
    join(here, "verify-approval.mjs"),
    "--cwd", dir,
    "--base", base,
    "--head", head,
    "--print-scope",
  ], { encoding: "utf8" });
  const hash = out.trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("scope digest was not a sha256");
  return hash;
};
const plainScope = (dir, base, head) => {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  const diff = execFileSync("git", [
    "-c", "core.quotePath=true",
    "-c", "color.ui=false",
    "-c", "color.diff=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.noprefix=false",
    "-c", "diff.context=3",
    "-c", "diff.interHunkContext=0",
    "-c", "diff.indentHeuristic=true",
    "-c", "diff.renames=true",
    "-c", "diff.algorithm=myers",
    "-c", "diff.suppressBlankEmpty=false",
    "diff", base, head, "--",
    ".github/workflows/",
    "scripts/gates/",
    "tools/harness/sql/",
    "tools/spikes/*/bench/.artifacts/",
    ":(exclude)scripts/gates/approvals/*.json",
    ":(exclude)scripts/gates/approvals/*.json.sig",
  ], { cwd: dir, env });
  return createHash("sha256").update(diff).digest("hex");
};
const writeSignedArtifact = (dir, keyFile, scope) => {
  const path = join(dir, "scripts/gates/approvals/2026-10-17-secrets-gate-fix.json");
  writeFileSync(path, `{"approver":"maintainer","scope_sha256":"${scope}","timestamp":"2026-10-17T00:00:00Z"}`);
  execFileSync("ssh-keygen", [
    "-Y", "sign",
    "-f", keyFile,
    "-n", "plerni-gate-approval",
    "-s", `${path}.sig`,
    path,
  ], { stdio: "ignore" });
};
const approvalCmd = (dir, base, head) =>
  gate("verify-approval.mjs", "--cwd", dir, "--base", base, "--head", head);

const missingArtifact = repoWithBaseKey(approvalKeyA);
writeFileSync(join(missingArtifact.dir, ".github/workflows/p0-gates.yml"), "changed\n");
const missingHead = commitTree(missingArtifact.dir, "ci: change workflow without an artifact");
cases.push({
  name: "verify-approval rejects a missing artifact",
  cmd: approvalCmd(missingArtifact.dir, missingArtifact.base, missingHead),
  expectExit: 1,
  expectOutput: /artifact is required for a non-empty scoped diff(?![\s\S]*not a failure)/,
});

const digested = repoWithBaseKey(approvalKeyA);
writeFileSync(join(digested.dir, ".github/workflows/p0-gates.yml"), "v2\n");
const digestedMid = commitTree(digested.dir, "ci: change workflow");
const digestedScope = scopeOf(digested.dir, digested.base, digestedMid);
if (digestedScope !== plainScope(digested.dir, digested.base, digestedMid)) {
  throw new Error("scope digest does not match a plain git diff");
}
writeSignedArtifact(digested.dir, approvalKeyA, digestedScope);
const digestedHead = commitTree(digested.dir, "ci: add approval artifact");
if (scopeOf(digested.dir, digested.base, digestedHead) !== digestedScope) {
  throw new Error("artifact files changed the scope digest");
}
writeFileSync(join(digested.dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${approvalKeyB}.pub`));
const digestedPubHead = commitTree(digested.dir, "ci: replace approval key");
if (scopeOf(digested.dir, digested.base, digestedPubHead) === digestedScope) {
  throw new Error("maintainer.pub was excluded from the scope digest");
}
approvalGit(digested.dir, ["checkout", "-q", digestedHead]);
writeFileSync(join(digested.dir, ".github/workflows/p0-gates.yml"), "v3\n");
const digestedDrift = commitTree(digested.dir, "ci: drift the workflow");
cases.push({
  name: "verify-approval accepts an artifact signed by the base key",
  cmd: approvalCmd(digested.dir, digested.base, digestedHead),
  expectExit: 0,
  expectOutput: /OK \(1 artifact, scope [0-9a-f]{64}\)/,
});
cases.push({
  name: "verify-approval rejects a scope digest mismatch",
  cmd: approvalCmd(digested.dir, digested.base, digestedDrift),
  expectExit: 1,
  expectOutput: /scope digest does not match the scoped diff(?![\s\S]*OK \()/,
});

const badSignature = repoWithBaseKey(approvalKeyA);
writeFileSync(join(badSignature.dir, ".github/workflows/p0-gates.yml"), "v2\n");
const badMid = commitTree(badSignature.dir, "ci: change workflow");
writeSignedArtifact(badSignature.dir, approvalKeyC, scopeOf(badSignature.dir, badSignature.base, badMid));
const badHead = commitTree(badSignature.dir, "ci: add a badly signed artifact");
cases.push({
  name: "verify-approval rejects a bad signature",
  cmd: approvalCmd(badSignature.dir, badSignature.base, badHead),
  expectExit: 1,
  expectOutput: /signature verification failed(?![\s\S]*not a failure)/,
});

const headKey = repoWithBaseKey(approvalKeyA);
writeFileSync(join(headKey.dir, ".github/workflows/p0-gates.yml"), "v2\n");
writeFileSync(join(headKey.dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${approvalKeyB}.pub`));
const headKeyMid = commitTree(headKey.dir, "ci: change workflow and replace the approval key");
writeSignedArtifact(headKey.dir, approvalKeyB, scopeOf(headKey.dir, headKey.base, headKeyMid));
const headKeyHead = commitTree(headKey.dir, "ci: sign with the replacement key");
cases.push({
  name: "verify-approval rejects a head-key substitution",
  cmd: approvalCmd(headKey.dir, headKey.base, headKeyHead),
  expectExit: 1,
  expectOutput: /signature verification failed(?![\s\S]*OK \()/,
});

const noBaseKey = repoWithBaseKey(null);
writeFileSync(join(noBaseKey.dir, ".github/workflows/p0-gates.yml"), "v2\n");
writeFileSync(join(noBaseKey.dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${approvalKeyA}.pub`));
const noBaseKeyMid = commitTree(noBaseKey.dir, "ci: add the approval key only on the head");
writeSignedArtifact(noBaseKey.dir, approvalKeyA, scopeOf(noBaseKey.dir, noBaseKey.base, noBaseKeyMid));
const noBaseKeyHead = commitTree(noBaseKey.dir, "ci: sign with the head key");
cases.push({
  name: "verify-approval fails closed when the base commit has no approval key",
  cmd: approvalCmd(noBaseKey.dir, noBaseKey.base, noBaseKeyHead),
  expectExit: 1,
  expectOutput: /approval key is absent at the base commit(?![\s\S]*OK \()/,
});

const emptyScope = repoWithBaseKey(approvalKeyA);
writeFileSync(join(emptyScope.dir, "README.md"), "notes\n");
const emptyHead = commitTree(emptyScope.dir, "docs: notes outside the approval scope");
cases.push({
  name: "verify-approval accepts an empty scoped diff without an artifact",
  cmd: approvalCmd(emptyScope.dir, emptyScope.base, emptyHead),
  expectExit: 0,
  expectOutput: /OK \(scoped diff empty\)/,
});

const waiverSentence = "The signed approval artifact for gate-config changes is waived at the current stage";
const waived = repoWithBaseKey(approvalKeyA);
mkdirSync(join(waived.dir, "docs/ai"), { recursive: true });
writeFileSync(join(waived.dir, "docs/ai/model-routing.md"), `${waiverSentence}\n`);
const waivedBase = commitTree(waived.dir, "docs: record the waiver on the base");
writeFileSync(join(waived.dir, ".github/workflows/p0-gates.yml"), "changed\n");
const waivedHead = commitTree(waived.dir, "ci: change workflow under the waiver");
cases.push({
  name: "verify-approval does not require an artifact while the waiver sentence is on the base",
  cmd: approvalCmd(waived.dir, waivedBase, waivedHead),
  expectExit: 0,
  expectOutput: /WAIVER scoped diff is non-empty and no approval artifact is present/,
});

const forgedWaiver = repoWithBaseKey(approvalKeyA);
mkdirSync(join(forgedWaiver.dir, "docs/ai"), { recursive: true });
writeFileSync(join(forgedWaiver.dir, "docs/ai/model-routing.md"), `${waiverSentence}\n`);
writeFileSync(join(forgedWaiver.dir, ".github/workflows/p0-gates.yml"), "changed\n");
const forgedWaiverHead = commitTree(forgedWaiver.dir, "ci: forge the waiver on the head");
cases.push({
  name: "verify-approval rejects a waiver sentence added only on the head",
  cmd: approvalCmd(forgedWaiver.dir, forgedWaiver.base, forgedWaiverHead),
  expectExit: 1,
  expectOutput: /artifact is required for a non-empty scoped diff(?![\s\S]*not a failure)/,
});

const waivedBad = repoWithBaseKey(approvalKeyA);
mkdirSync(join(waivedBad.dir, "docs/ai"), { recursive: true });
writeFileSync(join(waivedBad.dir, "docs/ai/model-routing.md"), `${waiverSentence}\n`);
const waivedBadBase = commitTree(waivedBad.dir, "docs: record the waiver on the base");
writeFileSync(join(waivedBad.dir, ".github/workflows/p0-gates.yml"), "v2\n");
const waivedBadMid = commitTree(waivedBad.dir, "ci: change workflow");
writeSignedArtifact(waivedBad.dir, approvalKeyC, scopeOf(waivedBad.dir, waivedBadBase, waivedBadMid));
const waivedBadHead = commitTree(waivedBad.dir, "ci: add a badly signed artifact under the waiver");
cases.push({
  name: "verify-approval still rejects a bad signature while the waiver is on the base",
  cmd: approvalCmd(waivedBad.dir, waivedBadBase, waivedBadHead),
  expectExit: 1,
  expectOutput: /signature verification failed(?![\s\S]*not a failure)/,
});

const harnessScope = repoWithBaseKey(approvalKeyA);
mkdirSync(join(harnessScope.dir, "tools/harness/sql"), { recursive: true });
writeFileSync(join(harnessScope.dir, "tools/harness/docker-compose.yml"), "services: {}\n");
const harnessOutside = commitTree(harnessScope.dir, "ci: change a harness file outside tools/harness/sql");
writeFileSync(join(harnessScope.dir, "tools/harness/sql/001_roles.sql"), "select 1;\n");
const harnessInside = commitTree(harnessScope.dir, "ci: change tools/harness/sql");
const harnessOutsideHash = scopeOf(harnessScope.dir, harnessScope.base, harnessOutside);
const harnessInsideHash = scopeOf(harnessScope.dir, harnessScope.base, harnessInside);
const harnessScopeMatches =
  harnessOutsideHash === plainScope(harnessScope.dir, harnessScope.base, harnessOutside) &&
  harnessOutsideHash === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
  harnessInsideHash !== harnessOutsideHash;
const customDiff = repoWithBaseKey(approvalKeyA);
writeFileSync(join(customDiff.dir, ".github/workflows/p0-gates.yml"), "custom-diff\n");
const customHead = commitTree(customDiff.dir, "ci: change workflow under a custom diff config");
approvalGit(customDiff.dir, ["config", "diff.mnemonicPrefix", "true"]);
approvalGit(customDiff.dir, ["config", "diff.noprefix", "true"]);
approvalGit(customDiff.dir, ["config", "color.ui", "always"]);
const customStable = scopeOf(customDiff.dir, customDiff.base, customHead);
const customDefault = plainScope(customDiff.dir, customDiff.base, customHead);
const customRaw = createHash("sha256")
  .update(execFileSync("git", [
    "diff", customDiff.base, customHead, "--",
    ".github/workflows/",
    "scripts/gates/",
    "tools/harness/sql/",
    "tools/spikes/*/bench/.artifacts/",
    ":(exclude)scripts/gates/approvals/*.json",
    ":(exclude)scripts/gates/approvals/*.json.sig",
  ], { cwd: customDiff.dir }))
  .digest("hex");
const customDiffStable = customStable === customDefault && customStable !== customRaw;
cases.push({
  name: "verify-approval scope digest ignores custom local git diff settings",
  cmd: [
    process.execPath,
    ["-e", customDiffStable ? "console.log('scope digest stable')" : "console.error('scope digest followed local diff settings'); process.exit(1)"],
  ],
  expectExit: 0,
  expectOutput: /scope digest stable/,
});

cases.push({
  name: "verify-approval scope is tools/harness/sql and not the rest of the harness",
  cmd: [
    process.execPath,
    ["-e", harnessScopeMatches ? "console.log('scope paths OK')" : "console.error('scope paths mismatch'); process.exit(1)"],
  ],
  expectExit: 0,
  expectOutput: /scope paths OK/,
});

const sigOnly = repoWithBaseKey(approvalKeyA);
writeFileSync(join(sigOnly.dir, ".github/workflows/p0-gates.yml"), "v2\n");
const sigOnlyMid = commitTree(sigOnly.dir, "ci: change workflow");
writeSignedArtifact(sigOnly.dir, approvalKeyA, scopeOf(sigOnly.dir, sigOnly.base, sigOnlyMid));
const sigOnlyArtifact = commitTree(sigOnly.dir, "ci: add approval artifact");
writeFileSync(join(sigOnly.dir, "scripts/gates/approvals/2026-10-17-secrets-gate-fix.json.sig"), "not-a-signature\n");
const sigOnlyHead = commitTree(sigOnly.dir, "ci: replace only the detached signature");
cases.push({
  name: "verify-approval rejects a signature-only change",
  cmd: approvalCmd(sigOnly.dir, sigOnly.base, sigOnlyHead),
  expectExit: 1,
  expectOutput: /signature verification failed(?![\s\S]*OK \(scoped diff empty\))/,
});
approvalGit(sigOnly.dir, ["checkout", "-q", sigOnlyArtifact]);
execFileSync("git", ["rm", "-q", "scripts/gates/approvals/2026-10-17-secrets-gate-fix.json.sig"], { cwd: sigOnly.dir });
const sigDeletedHead = commitTree(sigOnly.dir, "ci: delete only the detached signature");
cases.push({
  name: "verify-approval rejects deletion of a detached signature",
  cmd: approvalCmd(sigOnly.dir, sigOnly.base, sigDeletedHead),
  expectExit: 1,
  expectOutput: /\.sig is absent(?![\s\S]*OK \(scoped diff empty\))/,
});

const waivedRotation = repoWithBaseKey(approvalKeyA);
mkdirSync(join(waivedRotation.dir, "docs/ai"), { recursive: true });
writeFileSync(join(waivedRotation.dir, "docs/ai/model-routing.md"), `${waiverSentence}\n`);
const waivedRotationBase = commitTree(waivedRotation.dir, "docs: record the waiver on the base");
writeFileSync(join(waivedRotation.dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${approvalKeyB}.pub`));
const waivedRotationHead = commitTree(waivedRotation.dir, "ci: replace the approval key under the waiver");
cases.push({
  name: "verify-approval does not waive an approval-key change",
  cmd: approvalCmd(waivedRotation.dir, waivedRotationBase, waivedRotationHead),
  expectExit: 1,
  expectOutput: /approval key changed; the waiver does not cover a key rotation(?![\s\S]*not a failure)/,
});

const rotationSigned = repoWithBaseKey(approvalKeyA);
mkdirSync(join(rotationSigned.dir, "docs/ai"), { recursive: true });
writeFileSync(join(rotationSigned.dir, "docs/ai/model-routing.md"), `${waiverSentence}\n`);
const rotationSignedBase = commitTree(rotationSigned.dir, "docs: record the waiver on the base");
writeFileSync(join(rotationSigned.dir, "scripts/gates/approvals/maintainer.pub"), readFileSync(`${approvalKeyB}.pub`));
const rotationSignedMid = commitTree(rotationSigned.dir, "ci: replace the approval key");
writeSignedArtifact(
  rotationSigned.dir,
  approvalKeyA,
  scopeOf(rotationSigned.dir, rotationSignedBase, rotationSignedMid),
);
const rotationSignedHead = commitTree(rotationSigned.dir, "ci: sign the key rotation with the incumbent key");
cases.push({
  name: "verify-approval accepts a key rotation signed by the incumbent key under the waiver",
  cmd: approvalCmd(rotationSigned.dir, rotationSignedBase, rotationSignedHead),
  expectExit: 0,
  expectOutput: /OK \(1 artifact, scope [0-9a-f]{64}\)/,
});

cases.push({
  name: "verify-approval fails closed when the base sha is all zeros",
  cmd: approvalCmd(emptyScope.dir, "0000000000000000000000000000000000000000", emptyHead),
  expectExit: 1,
  expectOutput: /base commit is not a revision(?![\s\S]*OK \()/,
});

const secretsDir = mkdtempSync(join(tmpdir(), "plerni-secrets-negative-"));
const plantedReport = join(secretsDir, "planted.json");
const wrongRuleReport = join(secretsDir, "wrong-rule.json");
const wrongFileReport = join(secretsDir, "wrong-file.json");
const emptyReport = join(secretsDir, "empty.json");
writeFileSync(plantedReport, JSON.stringify([{ RuleID: "generic-api-key", File: "/scan/secret.txt" }]));
writeFileSync(wrongRuleReport, JSON.stringify([{ RuleID: "aws-access-token", File: "/scan/secret.txt" }]));
writeFileSync(wrongFileReport, JSON.stringify([{ RuleID: "generic-api-key", File: "/scan/other.txt" }]));
writeFileSync(emptyReport, "[]\n");
cases.push({
  name: "secrets negative proof accepts the planted generic-api-key finding",
  cmd: gate("secrets-negative.mjs", "--report", plantedReport, "--scanner-exit", "1"),
  expectExit: 0,
  expectOutput: /secrets negative proof OK \(rule generic-api-key, file secret\.txt\)/,
});
cases.push({
  name: "secrets negative proof rejects exit 0 when the planted finding is present",
  cmd: gate("secrets-negative.mjs", "--report", plantedReport, "--scanner-exit", "0"),
  expectExit: 1,
  expectOutput: /scanner exit 0 contradicts a planted finding — a leak must exit 1(?![\s\S]*negative proof OK)/,
});
// Report mode (--report and --scanner-exit) is the only coverage of a
// completed scan whose planted finding is missing. These cases do not run
// the live scanner.
cases.push({
  name: "secrets negative proof rejects a completed scan that lacks the planted rule",
  cmd: gate("secrets-negative.mjs", "--report", wrongRuleReport, "--scanner-exit", "1"),
  expectExit: 1,
  expectOutput: /expected finding rule generic-api-key file secret\.txt is absent(?![\s\S]*negative proof OK)/,
});
cases.push({
  name: "secrets negative proof rejects a completed scan that names a different file",
  cmd: gate("secrets-negative.mjs", "--report", wrongFileReport, "--scanner-exit", "1"),
  expectExit: 1,
  expectOutput: /expected finding rule generic-api-key file secret\.txt is absent(?![\s\S]*negative proof OK)/,
});
cases.push({
  name: "secrets negative proof rejects a scanner crash even when a finding report is present",
  cmd: gate("secrets-negative.mjs", "--report", plantedReport, "--scanner-exit", "126"),
  expectExit: 1,
  expectOutput: /scanner failed \(exit 126\) — a crash is not a finding(?![\s\S]*negative proof OK)/,
});
cases.push({
  name: "secrets negative proof rejects a leaks exit that produced no report",
  cmd: gate("secrets-negative.mjs", "--report", join(secretsDir, "missing.json"), "--scanner-exit", "1"),
  expectExit: 1,
  expectOutput: /scanner failed \(exit 1\) — report is missing or not a finding list(?![\s\S]*negative proof OK)/,
});
cases.push({
  name: "secrets negative proof rejects a clean scan with an empty report",
  cmd: gate("secrets-negative.mjs", "--report", emptyReport, "--scanner-exit", "0"),
  expectExit: 1,
  expectOutput: /expected finding rule generic-api-key file secret\.txt is absent(?![\s\S]*negative proof OK)/,
});

const fakeBin = join(secretsDir, "bin");
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, "docker"), `#!/bin/sh
prev=
for arg in "$@"; do
  if [ "$prev" = "-v" ]; then
    case "$arg" in
      *:/out)
        printf '%s\\n' '[{"RuleID":"generic-api-key","File":"/scan/secret.txt"}]' > "\${arg%:*}/report.json"
        ;;
    esac
  fi
  prev=$arg
done
kill -KILL $$
`, { mode: 0o755 });
cases.push({
  name: "secrets negative proof rejects a scanner killed with no exit code",
  cmd: gate("secrets-negative.mjs"),
  env: { PATH: fakeBin },
  expectExit: 1,
  expectOutput: /scanner failed \(no exit code\) — a crash is not a finding(?![\s\S]*negative proof OK)/,
});

const cleanRoot = join(secretsDir, "clean");
mkdirSync(cleanRoot);
writeFileSync(join(cleanRoot, "note.txt"), "Clean deployment note for the positive control.\n");
const findingScanner = join(secretsDir, "finding-scanner");
writeFileSync(findingScanner, `#!/bin/sh
prev=
report=
for arg in "$@"; do
  if [ "$prev" = "--report-path" ]; then
    report=$arg
  fi
  prev=$arg
done
printf '%s' '[{"RuleID":"generic-api-key","File":"secret.txt"}]' > "$report"
exit 0
`, { mode: 0o755 });
const crashScanner = join(secretsDir, "crash-scanner");
writeFileSync(crashScanner, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
cases.push({
  name: "secrets gate blocks the planted fake secret fixture",
  cmd: gate("secrets.mjs", "--root", join(fixtures, "gitleaks")),
  expectExit: 1,
  expectOutput: /secrets gate: finding rule generic-api-key file secret\.txt(?![\s\S]*secrets gate OK)/,
});
cases.push({
  name: "secrets gate accepts clean input",
  cmd: gate("secrets.mjs", "--root", cleanRoot),
  expectExit: 0,
  expectOutput: /^secrets gate OK\n$/,
});
cases.push({
  name: "secrets gate rejects a clean scanner exit that still reports a finding",
  cmd: gate("secrets.mjs", "--root", cleanRoot, "--scanner", findingScanner),
  expectExit: 1,
  expectOutput: /secrets gate: finding rule generic-api-key file secret\.txt(?![\s\S]*secrets gate OK)/,
});
cases.push({
  name: "secrets gate rejects a scanner crash",
  cmd: gate("secrets.mjs", "--root", cleanRoot, "--scanner", crashScanner),
  expectExit: 1,
  expectOutput: /scanner failed \(exit 2\)(?![\s\S]*secrets gate OK)/,
});
const allowRoot = join(secretsDir, "allowlisted-fixture");
mkdirSync(allowRoot);
copyFileSync(join(fixtures, "gitleaks", "secret.txt"), join(allowRoot, "secret.txt"));
writeFileSync(
  join(allowRoot, ".gitleaks.toml"),
  "[extend]\nuseDefault = true\n\n[allowlist]\npaths = ['''.*''']\n",
);
cases.push({
  name: "secrets gate still blocks the fixture when the target allowlists it",
  cmd: gate("secrets.mjs", "--root", allowRoot),
  expectExit: 1,
  expectOutput: /secrets gate: finding rule generic-api-key file secret\.txt(?![\s\S]*secrets gate OK)/,
});

const parseWorkflow = (text, label) => {
  const doc = parseYaml(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${label} did not parse as a workflow mapping`);
  }
  return doc;
};
const stepList = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const runsOf = (doc) =>
  Object.values(doc.jobs ?? {}).flatMap((job) =>
    stepList(job).map((step) => (typeof step?.run === "string" ? step.run : "")),
  );
const workflowWiringProblems = () => {
  const gates = parseWorkflow(
    readFileSync(join(here, "../../.github/workflows/p0-gates.yml"), "utf8"),
    "p0-gates.yml",
  );
  const approval = parseWorkflow(
    readFileSync(join(here, "../../.github/workflows/approval-artifact.yml"), "utf8"),
    "approval-artifact.yml",
  );
  const problems = [];
  const negative = stepList(gates.jobs?.secrets).filter(
    (step) => typeof step?.run === "string" && step.run.trim() === "node scripts/gates/secrets-negative.mjs",
  );
  if (negative.length !== 1) problems.push("secrets job must run secrets-negative.mjs exactly once");
  if (runsOf(gates).some((run) => run.includes("verify-approval.mjs"))) {
    problems.push("p0-gates must not run verify-approval.mjs");
  }
  const trigger = approval.on;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger) || !Object.hasOwn(trigger, "pull_request_target")) {
    problems.push("approval workflow must trigger on pull_request_target");
  }
  const branches = trigger && typeof trigger === "object" ? trigger.push?.branches : undefined;
  if (!Array.isArray(branches) || !branches.includes("dev")) problems.push("approval workflow push branches must include dev");
  const permissions = approval.permissions;
  if (!permissions || permissions.contents !== "read" || Object.keys(permissions).length !== 1) {
    problems.push("approval workflow permissions must be contents: read only");
  }
  const job = approval.jobs?.["approval-artifact"];
  if (!job || typeof job !== "object" || Array.isArray(job)) problems.push("approval-artifact job is missing");
  if (job?.permissions != null) problems.push("approval job must not raise permissions");
  const steps = stepList(job);
  const checkouts = steps.filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
  if (checkouts.length !== 1) problems.push("approval workflow must have one actions/checkout step");
  const checkout = checkouts[0];
  const pin = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  if (checkout && checkout.uses !== pin) problems.push("checkout must be pinned to the reviewed action sha");
  const baseRef = "${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.sha }}";
  if (checkout && checkout.with?.ref !== baseRef) problems.push("checkout ref must be the base sha");
  if (checkout && checkout.with?.["fetch-depth"] !== 0) problems.push("checkout fetch-depth must be 0");
  if (checkout && checkout.with?.["persist-credentials"] !== false) problems.push("checkout persist-credentials must be false");
  const fetchStep = steps.find((step) => step?.env && Object.hasOwn(step.env, "HEAD_SHA"));
  if (!fetchStep) problems.push("fetch step must pass HEAD_SHA");
  if (fetchStep && fetchStep.env.HEAD_SHA !== "${{ github.event.pull_request.head.sha }}") {
    problems.push("HEAD_SHA must be the event head sha");
  }
  if (fetchStep && fetchStep.if !== "github.event_name == 'pull_request_target'") {
    problems.push("fetch step must run only for pull_request_target");
  }
  const fetchRun = typeof fetchStep?.run === "string" ? fetchStep.run : "";
  if (!fetchRun.includes('git fetch --no-tags origin "$HEAD_SHA"')) problems.push("fetch must request the event head sha");
  if (fetchRun.includes("pull/${PR_NUMBER}/head") || fetchRun.includes("FETCH_HEAD")) {
    problems.push("fetch must not use the moving pull ref or FETCH_HEAD");
  }
  const verify = steps.find((step) => typeof step?.run === "string" && step.run.includes("verify-approval.mjs"));
  if (!verify) problems.push("verify step must run verify-approval.mjs");
  const baseExpr = "${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.event.before }}";
  const headExpr = "${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || 'HEAD' }}";
  if (verify?.env?.APPROVAL_BASE !== baseExpr) problems.push("APPROVAL_BASE must be the base sha or event.before");
  if (verify?.env?.APPROVAL_HEAD !== headExpr) problems.push("APPROVAL_HEAD must be the event head sha or HEAD");
  const verifyRun = typeof verify?.run === "string" ? verify.run : "";
  if (!verifyRun.includes('base=$(git merge-base "$APPROVAL_BASE" "$APPROVAL_HEAD")')) {
    problems.push("pull request base must be the merge-base");
  }
  if (!verifyRun.includes('node scripts/gates/verify-approval.mjs --base "$base" --head "$APPROVAL_HEAD" --event "$APPROVAL_EVENT"')) {
    problems.push("verify step must run the base copy of verify-approval.mjs");
  }
  if (verifyRun.includes("git show HEAD:scripts/gates/approvals/maintainer.pub") || verifyRun.includes("FETCH_HEAD")) {
    problems.push("verify step must not read the head key or FETCH_HEAD");
  }
  return problems.join("; ");
};
let workflowWiringReport = "";
try {
  workflowWiringReport = workflowWiringProblems();
} catch (err) {
  workflowWiringReport = err instanceof Error ? err.message : String(err);
}
cases.push({
  name: "approval verification runs from the base workflow, not the pull request checkout",
  cmd: [
    process.execPath,
    [
      "-e",
      workflowWiringReport
        ? `console.error(${JSON.stringify(`workflow wiring: ${workflowWiringReport}`)}); process.exit(1)`
        : "console.log('workflow wiring OK')",
    ],
  ],
  expectExit: 0,
  expectOutput: /workflow wiring OK/,
});

let failed = 0;
try {
  for (const c of cases) {
    let code = 0;
    let output = "";
    const env = { ...process.env };
    for (const key of ["COMMIT_IDENTITY_PATTERNS", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "PR_HEAD_REPO"]) {
      delete env[key];
    }
    if (c.env) {
      for (const [key, value] of Object.entries(c.env)) {
        if (value == null) delete env[key];
        else env[key] = value;
      }
    }
    try {
      output = execFileSync(c.cmd[0], c.cmd[1], { encoding: "utf8", env });
    } catch (e) {
      code = e.status ?? 1;
      output = `${e.stderr ?? ""}${e.stdout ?? ""}`;
    }
    let ok = code === c.expectExit;
    if (ok && c.expectOutput) ok = c.expectOutput.test(output);
    console.log(`${ok ? "✓" : "✗"} ${c.name} (exit ${code}, expected ${c.expectExit})`);
    if (!ok) failed++;
  }
} finally {
  rmSync(historyDir, { recursive: true, force: true });
  rmSync(identityDir, { recursive: true, force: true });
  rmSync(approvalRoot, { recursive: true, force: true });
  rmSync(approvalKeys, { recursive: true, force: true });
  rmSync(secretsDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`gate-health: ${failed} case(s) failed — FAIL`);
  process.exit(1);
}
console.log(`gate-health: OK (${cases.length} cases: fail-closed proofs + positive controls)`);
