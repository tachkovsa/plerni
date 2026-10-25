#!/usr/bin/env node
/**
 * Secrets-gate negative proof (plan T13).
 *
 * The history scan allowlists scripts/gates/fixtures/gitleaks/ so the synthetic
 * fixture does not fail every push. This proof scans that directory with
 * gitleaks' default rules — the repo config is not mounted — and requires the
 * planted finding: rule generic-api-key on secret.txt.
 *
 * gitleaks v8.30.1 config/gitleaks.toml defines aws-access-token as an AKIA /
 * ASIA / ABIA / ACCA / A3T prefix plus 16 characters from [A-Z2-7]. The
 * fixture's access-key line is outside that alphabet. The leak the default
 * rules report is generic-api-key on secret.txt (observed with the official
 * v8.30.1 binary).
 *
 * A completed scan exits 0 (no leaks) or 1 (leaks found). Any other exit, a
 * termination with no numeric exit code (a signal, or a spawn error such as
 * a full output buffer), or a completed scan that does not produce a JSON
 * finding list, is a scanner failure. A completed scan whose list lacks the
 * planted rule and file is an absent finding. That case — the scan ran, and
 * the planted finding is missing — is covered in report mode only
 * (`--report` together with `--scanner-exit`). It is not covered as a live
 * scanner run. The planted finding is proof only when the scanner exits 1.
 * Exit 0 together with that finding is a broken scanner, not a pass. A
 * nonzero exit alone is not proof. A thrown error is proof only when it
 * carries exit 1 and the planted finding.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const EXPECT_RULE = "generic-api-key";
const EXPECT_FILE = "secret.txt";
const IMAGE = "zricethezav/gitleaks:v8.30.1";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    "scanner-exit": { type: "string" },
  },
});

const fail = (message) => {
  console.error(`secrets negative proof: ${message}`);
  process.exit(1);
};

const basename = (file) => {
  if (typeof file !== "string" || file.length === 0 || file.length > 4096) return "";
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
};

const findingPresent = (list) =>
  list.some((finding) => finding && finding.RuleID === EXPECT_RULE && basename(finding.File) === EXPECT_FILE);

/**
 * @param {number} exitCode
 * @param {string | null} reportText null when the scanner produced no report
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
const classify = (exitCode, reportText) => {
  if (exitCode !== 0 && exitCode !== 1) {
    return { ok: false, message: `scanner failed (exit ${exitCode}) — a crash is not a finding` };
  }
  let list;
  try {
    list = JSON.parse(reportText ?? "");
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) {
    return {
      ok: false,
      message: `scanner failed (exit ${exitCode}) — report is missing or not a finding list`,
    };
  }
  if (!findingPresent(list)) {
    return {
      ok: false,
      message: `expected finding rule ${EXPECT_RULE} file ${EXPECT_FILE} is absent — the scan completed without that finding`,
    };
  }
  if (exitCode !== 1) {
    return {
      ok: false,
      message: `scanner exit ${exitCode} contradicts a planted finding — a leak must exit 1`,
    };
  }
  return { ok: true };
};

const finish = (exitCode, reportText) => {
  const result = classify(exitCode, reportText);
  if (!result.ok) fail(result.message);
  console.log(`secrets negative proof OK (rule ${EXPECT_RULE}, file ${EXPECT_FILE})`);
  process.exit(0);
};

if (values.report != null || values["scanner-exit"] != null) {
  if (values.report == null || values["scanner-exit"] == null) {
    fail("report mode requires both --report and --scanner-exit — FAIL CLOSED");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(values["scanner-exit"])) {
    fail("scanner exit is not a number — FAIL CLOSED");
  }
  let reportText = null;
  try {
    reportText = readFileSync(values.report, "utf8");
  } catch {
    reportText = null;
  }
  finish(Number(values["scanner-exit"]), reportText);
}

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixture = join(repoRoot, "scripts/gates/fixtures/gitleaks");
const outDir = mkdtempSync(join(tmpdir(), "plerni-secrets-negative-"));
try {
  let code = 0;
  let aborted = false;
  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${fixture}:/scan:ro`,
        "-v",
        `${outDir}:/out`,
        IMAGE,
        "dir",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        "/out/report.json",
        "/scan",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error("secrets negative proof: scanner failed (docker is not available) — a crash is not a finding");
      process.exitCode = 1;
      aborted = true;
    } else if (typeof err?.status !== "number") {
      console.error("secrets negative proof: scanner failed (no exit code) — a crash is not a finding");
      process.exitCode = 1;
      aborted = true;
    } else {
      code = err.status;
    }
  }
  if (!aborted) {
    let reportText = null;
    try {
      reportText = readFileSync(join(outDir, "report.json"), "utf8");
    } catch {
      reportText = null;
    }
    const result = classify(code, reportText);
    if (!result.ok) {
      console.error(`secrets negative proof: ${result.message}`);
      process.exitCode = 1;
    } else {
      console.log(`secrets negative proof OK (rule ${EXPECT_RULE}, file ${EXPECT_FILE})`);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
