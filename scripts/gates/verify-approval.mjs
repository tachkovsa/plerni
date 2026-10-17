#!/usr/bin/env node
/**
 * Gate-config approval verifier (plan §8, T13).
 *
 * An artifact is required when the scoped diff is non-empty. Each artifact in
 * the diff must be canonical JSON, cover that diff's sha256, and carry a
 * detached signature from the public key at the base commit
 * (scripts/gates/approvals/maintainer.pub). The key is never read from the
 * head commit. Artifact json and sig files are outside the digest; maintainer.pub
 * stays inside it.
 *
 * Scope (plan T13): a plain `git diff base head --` of the workflow and gate
 * trees, tools/harness/sql/, and spike bench artifacts, excluding approval
 * json and sig files. The rest of tools/harness/ is outside that recipe.
 * maintainer.pub stays in the digest. No extra diff flags: the digest is the
 * byte stream of that command.
 *
 * A change to either half of an artifact pair (the json or the detached sig),
 * including a deletion or a rename, is verified or rejected. A signature-only
 * edit is not an empty scope.
 *
 * Push runs pass the pre-push commit (github.event.before) as --base. Pull
 * requests pass the merge-base of the base branch and the pull request head.
 * A missing key, an unreadable base, or a signature that does not verify
 * fails closed.
 *
 * The signed artifact for gate-config changes is waived at the current stage
 * (docs/ai/model-routing.md, owner decision 2026-10-15). While that sentence
 * is committed at the base revision, a missing artifact does not fail the
 * job. A sentence added only on the head does not waive it. The waiver does
 * not cover a change to maintainer.pub: a rotation still needs an artifact
 * signed by the key at the base. A present artifact is still checked.
 * Repositories without the sentence — including the gate-health fixtures —
 * enforce the missing-artifact rule.
 *
 * approval-artifact.yml runs this script from the base checkout
 * (pull_request_target). A pull_request job must not run it: that job checks
 * out the pull request, so the pull request could replace this file.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const NAMESPACE = "plerni-gate-approval";
const PRINCIPAL = "maintainer";
const WAIVER_SENTENCE = "The signed approval artifact for gate-config changes is waived at the current stage";
const WAIVER_PATH = "docs/ai/model-routing.md";
const KEY_PATH = "scripts/gates/approvals/maintainer.pub";
const SCOPE_PATHS = [
  ".github/workflows/",
  "scripts/gates/",
  "tools/harness/sql/",
  "tools/spikes/*/bench/.artifacts/",
  ":(exclude)scripts/gates/approvals/*.json",
  ":(exclude)scripts/gates/approvals/*.json.sig",
];
const JSON_NAME = /^scripts\/gates\/approvals\/[^/]+\.json$/;
const SIG_NAME = /^scripts\/gates\/approvals\/[^/]+\.json\.sig$/;

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    base: { type: "string" },
    head: { type: "string", default: "HEAD" },
    event: { type: "string" },
    "print-scope": { type: "boolean", default: false },
  },
});

const fail = (message) => {
  console.error(`verify-approval: ${message}`);
  process.exit(1);
};

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });

const resolveCommit = (cwd, rev) => {
  try {
    return git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]).toString("utf8").trim();
  } catch {
    return null;
  }
};

const gitShow = (cwd, rev, path) => {
  try {
    return git(cwd, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
};

const scopedDiff = (cwd, base, head) => {
  try {
    return git(cwd, ["diff", base, head, "--", ...SCOPE_PATHS]);
  } catch (err) {
    fail(`cannot read the scoped diff (${err.message}) — FAIL CLOSED`);
  }
};

const jsonOf = (path) => {
  if (typeof path !== "string") return null;
  if (SIG_NAME.test(path)) return path.slice(0, -4);
  if (JSON_NAME.test(path)) return path;
  return null;
};

const artifactsInDiff = (cwd, base, head) => {
  let raw;
  try {
    raw = git(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      base,
      head,
      "--",
      "scripts/gates/approvals",
    ]);
  } catch (err) {
    fail(`cannot list approval artifacts (${err.message}) — FAIL CLOSED`);
  }
  const parts = raw.toString("utf8").split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  const verify = new Set();
  const removed = new Set();
  let index = 0;
  while (index < parts.length) {
    const status = parts[index++];
    const renamed = status.startsWith("R") || status.startsWith("C");
    const from = parts[index++];
    const to = renamed ? parts[index++] : null;
    if (!status || from === undefined || (renamed && to === undefined)) {
      fail("cannot list approval artifacts — FAIL CLOSED");
    }
    if (renamed) {
      const fromJson = jsonOf(from);
      const toJson = jsonOf(to);
      if (toJson) verify.add(toJson);
      if (fromJson && fromJson !== toJson && gitShow(cwd, head, fromJson)) verify.add(fromJson);
      if (fromJson && !toJson && !gitShow(cwd, head, fromJson)) removed.add(fromJson);
      continue;
    }
    const pathJson = jsonOf(from);
    if (!pathJson) continue;
    if (status.startsWith("D")) {
      if (gitShow(cwd, head, pathJson)) verify.add(pathJson);
      else removed.add(pathJson);
      continue;
    }
    verify.add(pathJson);
  }
  if (removed.size > 0) {
    fail(`${[...removed].sort()[0]} was removed — FAIL CLOSED`);
  }
  return [...verify].sort();
};

const keyChanged = (cwd, base, head) => {
  const before = gitShow(cwd, base, KEY_PATH);
  const after = gitShow(cwd, head, KEY_PATH);
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return !before.equals(after);
};

const canonicalOf = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || keys.some((key) => !["approver", "scope_sha256", "timestamp"].includes(key))) return null;
  const { approver, scope_sha256, timestamp } = value;
  if (approver !== PRINCIPAL) return null;
  if (typeof scope_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(scope_sha256)) return null;
  if (typeof timestamp !== "string" || timestamp.length === 0 || timestamp.length > 80) return null;
  if (/[\u0000-\u001f]/.test(timestamp)) return null;
  return `{"approver":"maintainer","scope_sha256":${JSON.stringify(scope_sha256)},"timestamp":${JSON.stringify(timestamp)}}`;
};

const waiverActive = (cwd, base) => {
  const body = gitShow(cwd, base, WAIVER_PATH);
  if (!body) return false;
  return body.toString("utf8").includes(WAIVER_SENTENCE);
};

const publicKeyLine = (cwd, base) => {
  const raw = gitShow(cwd, base, KEY_PATH);
  if (!raw) fail("approval key is absent at the base commit — FAIL CLOSED");
  const line = raw.toString("utf8").trim();
  if (!/^ssh-(?:ed25519|rsa|ecdsa(?:-sk)?|ed25519-sk) \S+(?: \S+)?$/.test(line)) {
    fail("approval key at the base commit is not a public key — FAIL CLOSED");
  }
  return line;
};

const signatureOk = (pubLine, artifact, signature) => {
  const dir = mkdtempSync(join(tmpdir(), "plerni-approval-verify-"));
  try {
    const allowed = join(dir, "allowed");
    const sigPath = join(dir, "artifact.json.sig");
    writeFileSync(allowed, `${PRINCIPAL} ${pubLine}\n`);
    writeFileSync(sigPath, signature);
    execFileSync(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowed, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", sigPath],
      { input: artifact, stdio: ["pipe", "pipe", "pipe"] },
    );
    return true;
  } catch (err) {
    const missing = err && err.code === "ENOENT";
    rmSync(dir, { recursive: true, force: true });
    if (missing) fail("ssh-keygen is not available — FAIL CLOSED");
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const cwd = values.cwd || process.cwd();
if (typeof values.base !== "string" || !/^[0-9a-fA-F]{40}$/.test(values.base) || /^0{40}$/.test(values.base)) {
  fail("base commit is not a revision — FAIL CLOSED");
}
const base = resolveCommit(cwd, values.base);
if (!base) fail("base commit is not a revision — FAIL CLOSED");
const head = resolveCommit(cwd, values.head);
if (!head) fail("head commit is not a revision — FAIL CLOSED");

const diff = scopedDiff(cwd, base, head);
const scopeHash = createHash("sha256").update(diff).digest("hex");
if (values["print-scope"]) {
  console.log(scopeHash);
  process.exit(0);
}

const artifacts = artifactsInDiff(cwd, base, head);
if (keyChanged(cwd, base, head) && artifacts.length === 0) {
  fail("approval key changed; the waiver does not cover a key rotation — FAIL CLOSED");
}
if (artifacts.length === 0 && diff.length === 0) {
  console.log("verify-approval: OK (scoped diff empty)");
  process.exit(0);
}
if (artifacts.length === 0) {
  if (waiverActive(cwd, base)) {
    console.log(
      "verify-approval: WAIVER scoped diff is non-empty and no approval artifact is present; the signed artifact is waived at the current stage (docs/ai/model-routing.md) — not a failure",
    );
    process.exit(0);
  }
  fail("artifact is required for a non-empty scoped diff — FAIL CLOSED");
}

const pubLine = publicKeyLine(cwd, base);
for (const path of artifacts) {
  const bytes = gitShow(cwd, head, path);
  if (!bytes) fail(`${path} is absent at the head commit — FAIL CLOSED`);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${path} is not canonical — FAIL CLOSED`);
  }
  const canonical = canonicalOf(parsed);
  if (canonical === null || !bytes.equals(Buffer.from(canonical, "utf8"))) {
    fail(`${path} is not canonical — FAIL CLOSED`);
  }
  if (parsed.scope_sha256 !== scopeHash) {
    fail(`${path} scope digest does not match the scoped diff — FAIL CLOSED`);
  }
  const sig = gitShow(cwd, head, `${path}.sig`);
  if (!sig) fail(`${path}.sig is absent — FAIL CLOSED`);
  if (!signatureOk(pubLine, bytes, sig)) fail(`${path} signature verification failed — FAIL CLOSED`);
}

const event = typeof values.event === "string" && /^[a-z_]{1,40}$/.test(values.event) ? `${values.event}, ` : "";
console.log(`verify-approval: OK (${event}${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}, scope ${scopeHash})`);
