#!/usr/bin/env node
/**
 * SCA negative proof (plan T14).
 *
 * One process generates a lockfile for lodash 4.17.20, scans it, requires
 * CVE-2021-23337 on that package, and deletes the directory. The lockfile
 * is never committed. A generator that exited before the scan would leave
 * the scanner with nothing to read; both steps stay in this process.
 *
 * A completed scan exits 0 (no advisories) or 1 (advisories found). Any
 * other exit, a termination with no numeric exit code, or a completed scan
 * that does not produce an osv-scanner JSON result, is a scanner failure.
 * A completed scan whose result lacks the required advisory and package is
 * an absent finding. Passing --advisory CVE-2020-0000 is that case on the
 * live fixture: the scan still finds CVE-2021-23337, and this proof fails
 * with its own diagnostic. Exit 0 together with the required advisory is a
 * broken scanner, not a pass. A nonzero exit alone is not proof.
 *
 * Report mode (--report together with --scanner-exit) classifies a saved
 * result without starting the scanner. The live path does not read a
 * committed lockfile.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ADVISORY_ID, collectReport, readReportFile, scanLockfile } from "../../sca.mjs";
import { FIXTURE_ADVISORY, FIXTURE_PACKAGE, VULN_SPEC, writeLockfile } from "./gen-vuln-lockfile.mjs";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    "scanner-exit": { type: "string" },
    advisory: { type: "string", default: FIXTURE_ADVISORY },
  },
});

const fail = (message) => {
  console.error(`sca negative proof: ${message}`);
  process.exit(1);
};

if (!ADVISORY_ID.test(values.advisory)) fail("advisory id is not allowed — FAIL CLOSED");

const classify = (scanned, advisory) => {
  if (scanned.failure) return { ok: false, message: scanned.failure };
  if (scanned.code !== 0 && scanned.code !== 1) {
    return { ok: false, message: `scanner failed (exit ${scanned.code}) — a crash is not a finding` };
  }
  const report = collectReport(scanned.reportText);
  if (!report.ok) return { ok: false, message: `scanner failed (exit ${scanned.code}) — ${report.message}` };
  const present = report.findings.some((finding) => finding.id === advisory && finding.packageName === FIXTURE_PACKAGE);
  if (!present) {
    return {
      ok: false,
      message: `expected advisory ${advisory} package ${FIXTURE_PACKAGE} is absent — the scan completed without that advisory`,
    };
  }
  if (scanned.code !== 1) {
    return {
      ok: false,
      message: `scanner exit ${scanned.code} contradicts a planted advisory — a vulnerability must exit 1`,
    };
  }
  return { ok: true };
};

const finish = (scanned) => {
  const result = classify(scanned, values.advisory);
  if (!result.ok) fail(result.message);
  console.log(`sca negative proof OK (advisory ${values.advisory}, package ${FIXTURE_PACKAGE})`);
  process.exit(0);
};

if (values.report != null || values["scanner-exit"] != null) {
  if (values.report == null || values["scanner-exit"] == null) {
    fail("report mode requires both --report and --scanner-exit — FAIL CLOSED");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(values["scanner-exit"])) fail("scanner exit is not a number — FAIL CLOSED");
  const loaded = readReportFile(values.report);
  if (loaded.error) fail(`scanner failed (exit ${values["scanner-exit"]}) — ${loaded.error}`);
  finish({ code: Number(values["scanner-exit"]), reportText: loaded.text });
}

const dir = mkdtempSync(join(tmpdir(), "plerni-sca-proof-"));
let failure = null;
try {
  try {
    writeLockfile(dir, VULN_SPEC);
    const scanned = scanLockfile(dir);
    const result = classify(scanned, values.advisory);
    if (!result.ok) failure = result.message;
    else console.log(`sca negative proof OK (advisory ${values.advisory}, package ${FIXTURE_PACKAGE})`);
  } catch {
    failure = "fixture scan did not finish — FAIL CLOSED";
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failure) fail(failure);
