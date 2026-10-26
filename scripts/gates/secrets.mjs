#!/usr/bin/env node
/**
 * Secrets gate (spec §12): gitleaks v8.30.1 with its default rules. Any
 * finding fails. A scanner crash, a missing report, or an exit other than
 * 0 or 1 fails closed. Exit 0 with an empty finding list passes.
 *
 * The repo allowlist in .gitleaks.toml applies only to the history scan.
 * This gate does not load that file. Gate-health points it at
 * scripts/gates/fixtures/gitleaks (the planted synthetic fixture, which
 * must fail) and at a clean directory (which must pass).
 *
 * Scanner output is discarded. The diagnostic prints only an allowlisted
 * rule id and file basename, never the report body.
 *
 * Resolution order: --scanner, else the pinned image used by
 * .github/workflows/p0-gates.yml when docker is installed, else the
 * official v8.30.1 release archive. Archive checksums are the published
 * v8.30.1 checksums file:
 * https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const IMAGE = "zricethezav/gitleaks:v8.30.1";
const VERSION = "8.30.1";
const RULE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const ARCHIVES = {
  "linux-x64": ["gitleaks_8.30.1_linux_x64.tar.gz", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"],
  "linux-arm64": ["gitleaks_8.30.1_linux_arm64.tar.gz", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"],
  "darwin-x64": ["gitleaks_8.30.1_darwin_x64.tar.gz", "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"],
  "darwin-arm64": ["gitleaks_8.30.1_darwin_arm64.tar.gz", "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"],
};

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    scanner: { type: "string" },
  },
});

const fail = (message) => {
  console.error(`secrets gate: ${message}`);
  process.exit(1);
};

const basename = (file) => {
  if (typeof file !== "string" || file.length === 0 || file.length > 4096) return "";
  const parts = file.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
};

const hasDocker = () => {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const pinnedBinary = () => {
  const spec = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!spec) fail("pinned scanner is not published for this platform — FAIL CLOSED");
  const [file, sha256] = spec;
  const cache = join(tmpdir(), "plerni-gitleaks", VERSION, `${process.platform}-${process.arch}`);
  const binary = join(cache, "gitleaks");
  const archiveStamp = join(cache, "archive.sha256");
  const binaryStamp = join(cache, "binary.sha256");
  if (existsSync(binary) && existsSync(archiveStamp) && existsSync(binaryStamp)) {
    const storedArchive = readFileSync(archiveStamp, "utf8").trim();
    const storedBinary = readFileSync(binaryStamp, "utf8").trim();
    const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (storedArchive === sha256 && storedBinary === actual) return binary;
  }
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `${file}.download`);
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${file}`;
  try {
    execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "1", "-o", archive, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    rmSync(archive, { force: true });
    fail("pinned scanner download failed — FAIL CLOSED");
  }
  const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (got !== sha256) {
    rmSync(archive, { force: true });
    fail("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  let bytes;
  try {
    bytes = execFileSync("tar", ["-xOf", archive, "gitleaks"], { maxBuffer: 80 * 1024 * 1024 });
  } catch {
    rmSync(archive, { force: true });
    fail("pinned scanner archive has no gitleaks binary — FAIL CLOSED");
  }
  rmSync(archive, { force: true });
  if (!Buffer.isBuffer(bytes) || bytes.length < 1000) fail("pinned scanner archive has no gitleaks binary — FAIL CLOSED");
  const tmpBin = join(cache, "gitleaks.download");
  writeFileSync(tmpBin, bytes, { mode: 0o755 });
  chmodSync(tmpBin, 0o755);
  renameSync(tmpBin, binary);
  writeFileSync(archiveStamp, sha256);
  writeFileSync(binaryStamp, createHash("sha256").update(bytes).digest("hex"));
  return binary;
};

const scannerEnv = () => {
  const env = { ...process.env };
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  return env;
};

const scanArgs = (reportPath, ignoreDir, source) => [
  "dir",
  "--no-banner",
  "--no-color",
  "--redact=100",
  "--log-level",
  "error",
  "--timeout",
  "60",
  "--report-format",
  "json",
  "--report-path",
  reportPath,
  "--gitleaks-ignore-path",
  ignoreDir,
  source,
];

if (typeof values.root !== "string" || values.root.length === 0) fail("root is required — FAIL CLOSED");
let root;
try {
  root = realpathSync(values.root);
} catch {
  fail("root is not a directory — FAIL CLOSED");
}
if (!statSync(root).isDirectory()) fail("root is not a directory — FAIL CLOSED");
if (root.includes(",") || root.includes(":")) fail("root path is not mountable — FAIL CLOSED");

const explicitScanner = typeof values.scanner === "string" && values.scanner.length > 0 ? values.scanner : null;
const binary = explicitScanner ?? (hasDocker() ? null : pinnedBinary());

const outDir = mkdtempSync(join(tmpdir(), "plerni-secrets-gate-"));
const reportOnHost = join(outDir, "report.json");
let failure = null;
let findingLines = null;
try {
  const env = scannerEnv();
  let code = 0;
  try {
    if (binary) {
      execFileSync(binary, scanArgs(reportOnHost, outDir, root), {
        cwd: outDir,
        env,
        stdio: "ignore",
        timeout: 180000,
      });
    } else {
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${root}:/scan:ro`,
          "-v",
          `${outDir}:/out`,
          IMAGE,
          ...scanArgs("/out/report.json", "/out", "/scan"),
        ],
        { env, stdio: "ignore", timeout: 180000 },
      );
    }
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EACCES")) failure = "scanner is not available — FAIL CLOSED";
    else if (typeof err?.status !== "number") failure = "scanner failed (no exit code) — a crash is not a finding";
    else code = err.status;
  }

  if (!failure && code !== 0 && code !== 1) {
    failure = `scanner failed (exit ${code}) — a crash is not a finding`;
  }
  if (!failure) {
    let reportText = null;
    try {
      const raw = readFileSync(reportOnHost);
      if (raw.length > 1_000_000) failure = `scanner failed (exit ${code}) — report is too large`;
      else reportText = raw.toString("utf8");
    } catch {
      reportText = null;
    }
    let list = null;
    if (!failure) {
      try {
        list = JSON.parse(reportText ?? "");
      } catch {
        list = null;
      }
      if (!Array.isArray(list) || list.length > 50) {
        failure = `scanner failed (exit ${code}) — report is missing or not a finding list`;
      }
    }
    if (!failure) {
      const lines = [];
      for (const finding of list) {
        if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
          failure = `scanner failed (exit ${code}) — report finding is malformed`;
          break;
        }
        const rule = finding.RuleID;
        const file = basename(finding.File);
        if (typeof rule !== "string" || !RULE_ID.test(rule) || !FILE_NAME.test(file)) {
          failure = `scanner failed (exit ${code}) — report finding is malformed`;
          break;
        }
        const line = `secrets gate: finding rule ${rule} file ${file}`;
        if (!lines.includes(line)) lines.push(line);
      }
      if (!failure && lines.length === 0 && code !== 0) {
        failure = `scanner failed (exit ${code}) — report listed no findings`;
      }
      if (!failure) findingLines = lines;
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failure) fail(failure);
if (!findingLines) fail("scanner failed — FAIL CLOSED");
if (findingLines.length > 0) {
  console.error(findingLines.join("\n"));
  process.exit(1);
}
console.log("secrets gate OK");
