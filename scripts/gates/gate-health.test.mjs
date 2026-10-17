#!/usr/bin/env node
/**
 * gate-health suite (spec §12, principle 16): proves the gates can fail AND
 * that they pass clean input. Every gate runs against deliberately-bad fixtures
 * (must block with its own diagnostic — a crash is not proof) and against
 * positive controls (must pass). The secrets gate's negative proof asserts the
 * planted gitleaks finding (see .github/workflows/p0-gates.yml). The approval
 * verifier's four fail-closed cases are artifact missing, digest mismatch,
 * bad signature, and head-key substitution.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const diff = execFileSync("git", [
    "diff", base, head, "--",
    ".github/workflows/",
    "scripts/gates/",
    "tools/harness/",
    "sql/",
    "tools/spikes/*/bench/.artifacts/",
    ":(exclude)scripts/gates/approvals/*.json",
    ":(exclude)scripts/gates/approvals/*.json.sig",
  ], { cwd: dir });
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

const gatesWorkflow = readFileSync(join(here, "../../.github/workflows/p0-gates.yml"), "utf8");
const approvalWorkflow = readFileSync(join(here, "../../.github/workflows/approval-artifact.yml"), "utf8");
const workflowWired =
  gatesWorkflow.includes("node scripts/gates/secrets-negative.mjs") &&
  !gatesWorkflow.includes("verify-approval.mjs") &&
  gatesWorkflow.includes("scanner failure, not evidence") &&
  gatesWorkflow.includes("absent finding") &&
  gatesWorkflow.includes("nonzero exit alone is not proof") &&
  gatesWorkflow.includes("no exit code") &&
  !gatesWorkflow.includes("secrets negative proof OK (gitleaks exit") &&
  approvalWorkflow.includes("pull_request_target:") &&
  approvalWorkflow.includes("github.event.pull_request.base.sha") &&
  approvalWorkflow.includes("github.event.before") &&
  approvalWorkflow.includes("git merge-base") &&
  approvalWorkflow.includes("git fetch --no-tags origin \"pull/${PR_NUMBER}/head\"") &&
  approvalWorkflow.includes("node scripts/gates/verify-approval.mjs") &&
  approvalWorkflow.includes("11d5960a326750d5838078e36cf38b85af677262") &&
  !approvalWorkflow.includes("github.event.pull_request.head.sha") &&
  !approvalWorkflow.includes("git show HEAD:scripts/gates/approvals/maintainer.pub");
cases.push({
  name: "approval verification runs from the base workflow, not the pull request checkout",
  cmd: [
    process.execPath,
    ["-e", workflowWired ? "console.log('workflow wiring OK')" : "console.error('workflow wiring missing'); process.exit(1)"],
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
