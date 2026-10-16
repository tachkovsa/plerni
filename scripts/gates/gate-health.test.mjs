#!/usr/bin/env node
/**
 * gate-health suite (spec §12, principle 16): proves the gates can fail AND
 * that they pass clean input. Every gate runs against deliberately-bad fixtures
 * (must block with its own diagnostic — a crash is not proof) and against
 * positive controls (must pass). The secrets gate's negative proof runs in CI
 * against fixtures/gitleaks (see .github/workflows/p0-gates.yml).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
}

if (failed) {
  console.error(`gate-health: ${failed} case(s) failed — FAIL`);
  process.exit(1);
}
console.log(`gate-health: OK (${cases.length} cases: fail-closed proofs + positive controls)`);
