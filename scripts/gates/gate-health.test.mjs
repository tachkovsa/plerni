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
    name: "license-audit accepts an MIT dependency declared outside the workspace",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-mit")),
    expectExit: 0,
  },
  {
    name: "license-audit blocks a forbidden license on an installed optional dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-transitive")),
    expectExit: 1,
    expectOutput:
      /fake-lgpl-lib \(dependency of fake-mit-lib \(brand\)\): forbidden license "LGPL-3.0-or-later"(?![\s\S]*fake-other-platform)/,
  },
  {
    name: "license-audit blocks a forbidden license on an installed peer dependency",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-peer")),
    expectExit: 1,
    expectOutput: /fake-gpl-peer \(dependency of fake-mit-lib \(brand\)\): forbidden license "GPL-3.0-only"/,
  },
  {
    name: "license-audit blocks a forbidden lockfile license for another platform",
    cmd: gate("license-audit.mjs", "--root", join(fixtures, "isolated-foreign")),
    expectExit: 1,
    expectOutput: /fake-darwin-gpl \(lockfile optional dependency of fake-mit-lib \(brand\)\): forbidden license "GPL-3.0-only"/,
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
    cmd: gate(
      "commit-policy.mjs",
      "--file",
      join(fixtures, "commit-policy", "bad-metadata.txt"),
      "--identities",
      join(fixtures, "commit-policy", "identities.txt"),
    ),
    expectExit: 1,
    expectOutput:
      /author matches a forbidden identity[\s\S]*committer matches a forbidden identity[\s\S]*message matches a forbidden identity[\s\S]*identity-bearing author/,
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
cases.push({
  name: "commit-policy history mode loads the governed identity list",
  cmd: gate("commit-policy.mjs", "--cwd", historyDir, "--base", historyBase),
  expectExit: 1,
  expectOutput: /author matches a forbidden identity[\s\S]*message matches a forbidden identity/,
});

let failed = 0;
try {
  for (const c of cases) {
    let code = 0;
    let output = "";
    try {
      output = execFileSync(c.cmd[0], c.cmd[1], { encoding: "utf8" });
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
}

if (failed) {
  console.error(`gate-health: ${failed} case(s) failed — FAIL`);
  process.exit(1);
}
console.log(`gate-health: OK (${cases.length} cases: fail-closed proofs + positive controls)`);
