#!/usr/bin/env node
/**
 * Secrets gate (spec §12): gitleaks v8.30.1 with its default rules. Any
 * finding fails. A scanner crash, a missing report, or an exit other than
 * 0 or 1 fails closed. Exit 0 with an empty finding list passes.
 *
 * The repo allowlist in .gitleaks.toml applies only to the history scan.
 * This gate does not load that file, or any .gitleaks.toml in the target.
 * gitleaks v8.30.1 otherwise uses (target)/.gitleaks.toml, which
 * re-enables the history allowlist at the repo root and lets another
 * target hide findings. Both the docker and archive paths pass a
 * generated config that extends the built-in defaults and has no
 * allowlist. Gate-health points the gate at scripts/gates/fixtures/gitleaks
 * (the planted synthetic fixture, which must fail), at a clean directory
 * (which must pass), and at a target whose own config allowlists the fixture
 * (which must still fail).
 *
 * Scanner output is discarded. The diagnostic prints only an allowlisted
 * rule id and file basename, never the report body.
 *
 * Resolution order: --scanner, else the digest-pinned v8.30.1 image when
 * docker is installed, else the official v8.30.1 release archive.
 * The image pin is the registry Docker-Content-Digest of tag v8.30.1
 * (oci index, 2026-10-26). The linux/amd64 and linux/arm64 configs in
 * that index are labeled v8.30.1. Archive checksums are the published
 * v8.30.1 checksums file:
 * https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
 * The third field is the sha256 of the archive member named gitleaks,
 * taken after that archive matched the published checksum.
 *
 * The archive fallback keeps its copy in the per-user cache
 * (XDG_CACHE_HOME when set, otherwise ~/.cache). Each directory from
 * that root through the version directory must be owned by the current
 * user and not writable by group or other. A cached binary is executed
 * only when its own bytes match the pinned member digest. Stamp files
 * in the cache are never read.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const IMAGE = "zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const VERSION = "8.30.1";
const RULE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ARCHIVES = {
  "linux-x64": [
    "gitleaks_8.30.1_linux_x64.tar.gz",
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
  ],
  "linux-arm64": [
    "gitleaks_8.30.1_linux_arm64.tar.gz",
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    "00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b",
  ],
  "darwin-x64": [
    "gitleaks_8.30.1_darwin_x64.tar.gz",
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    "cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291",
  ],
  "darwin-arm64": [
    "gitleaks_8.30.1_darwin_arm64.tar.gz",
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    "ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f",
  ],
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

const cacheUid = () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof uid !== "number") fail("scanner cache is not private — FAIL CLOSED");
  return uid;
};

const isSafeAbsolute = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (!value.startsWith("/") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "." && part !== "..");
};

const lstatOrNull = (path) => {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch {
    fail("scanner cache is not private — FAIL CLOSED");
  }
  return null;
};

const assertPrivate = (st, kind) => {
  if (st.isSymbolicLink()) fail("scanner cache is not private — FAIL CLOSED");
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) fail("scanner cache is not private — FAIL CLOSED");
  if (st.uid !== cacheUid()) fail("scanner cache is not private — FAIL CLOSED");
  if ((st.mode & 0o022) !== 0) fail("scanner cache is not private — FAIL CLOSED");
};

// Create a missing directory at mode 0700. Never chmod a directory, and
// never create one whose parent is group- or other-writable.
const ensurePrivateDir = (dir) => {
  let st = lstatOrNull(dir);
  if (!st) {
    const parent = lstatOrNull(dirname(dir));
    if (!parent) fail("scanner cache is not private — FAIL CLOSED");
    assertPrivate(parent, "dir");
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      fail("scanner cache is not private — FAIL CLOSED");
    }
    st = lstatOrNull(dir);
  }
  if (!st) fail("scanner cache is not private — FAIL CLOSED");
  assertPrivate(st, "dir");
};

const privateCacheDir = () => {
  cacheUid();
  const xdg = process.env.XDG_CACHE_HOME;
  let dir;
  if (typeof xdg === "string" && xdg.length > 0) {
    if (!isSafeAbsolute(xdg)) fail("scanner cache is not private — FAIL CLOSED");
    dir = xdg;
  } else {
    const home = homedir();
    if (!isSafeAbsolute(home)) fail("scanner cache is not private — FAIL CLOSED");
    dir = join(home, ".cache");
  }
  ensurePrivateDir(dir);
  for (const part of ["plerni", "gitleaks", VERSION, `${process.platform}-${process.arch}`]) {
    dir = join(dir, part);
    ensurePrivateDir(dir);
  }
  return dir;
};

// O_NOFOLLOW: a symlink planted in the cache is not a readable binary.
const readRegularFile = (path) => {
  if ((constants.O_NOFOLLOW ?? 0) === 0) fail("scanner cache is not private — FAIL CLOSED");
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    fail("scanner cache is not private — FAIL CLOSED");
  }
  try {
    const st = fstatSync(fd);
    assertPrivate(st, "file");
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > 80 * 1024 * 1024) {
      fail("pinned scanner checksum mismatch — FAIL CLOSED");
    }
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) fail("pinned scanner checksum mismatch — FAIL CLOSED");
      offset += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pinnedBinary = () => {
  const spec = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!Array.isArray(spec)) fail("pinned scanner is not published for this platform — FAIL CLOSED");
  const [file, archiveSha256, binarySha256] = spec;
  if (typeof file !== "string" || !HEX64.test(archiveSha256) || !HEX64.test(binarySha256)) {
    fail("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  const dir = privateCacheDir();
  const binary = join(dir, "gitleaks");
  const cached = readRegularFile(binary);
  if (cached) {
    if (sha256(cached) !== binarySha256) fail("cached scanner does not match the pinned binary — FAIL CLOSED");
    return binary;
  }
  const archive = join(dir, `.${file}.${process.pid}.partial`);
  try {
    rmSync(archive, { force: true });
  } catch {
    fail("scanner cache is not private — FAIL CLOSED");
  }
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${file}`;
  try {
    execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "1", "-o", archive, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    rmSync(archive, { force: true });
    fail("pinned scanner download failed — FAIL CLOSED");
  }
  const archiveStat = lstatOrNull(archive);
  if (!archiveStat || archiveStat.isSymbolicLink() || !archiveStat.isFile() || archiveStat.uid !== cacheUid()) {
    rmSync(archive, { force: true });
    fail("scanner cache is not private — FAIL CLOSED");
  }
  if ((archiveStat.mode & 0o022) !== 0) {
    try {
      chmodSync(archive, 0o600);
    } catch {
      rmSync(archive, { force: true });
      fail("scanner cache is not private — FAIL CLOSED");
    }
  }
  const archiveBytes = readRegularFile(archive);
  if (!archiveBytes || sha256(archiveBytes) !== archiveSha256) {
    rmSync(archive, { force: true });
    fail("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  let extracted;
  try {
    extracted = execFileSync("tar", ["-xOf", archive, "gitleaks"], { maxBuffer: 80 * 1024 * 1024 });
  } catch {
    rmSync(archive, { force: true });
    fail("pinned scanner archive has no gitleaks binary — FAIL CLOSED");
  }
  rmSync(archive, { force: true });
  if (!Buffer.isBuffer(extracted) || sha256(extracted) !== binarySha256) {
    fail("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  const tmpBin = join(dir, `.gitleaks.${process.pid}.partial`);
  try {
    rmSync(tmpBin, { force: true });
  } catch {
    fail("scanner cache is not private — FAIL CLOSED");
  }
  try {
    writeFileSync(tmpBin, extracted, { mode: 0o700, flag: "wx" });
    chmodSync(tmpBin, 0o700);
    const written = readRegularFile(tmpBin);
    if (!written || sha256(written) !== binarySha256) {
      try {
        rmSync(tmpBin, { force: true });
      } catch {
        fail("scanner cache is not private — FAIL CLOSED");
      }
      fail("pinned scanner checksum mismatch — FAIL CLOSED");
    }
    renameSync(tmpBin, binary);
  } catch {
    try {
      rmSync(tmpBin, { force: true });
    } catch {
      fail("scanner cache is not private — FAIL CLOSED");
    }
    fail("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  const confirmed = readRegularFile(binary);
  if (!confirmed || sha256(confirmed) !== binarySha256) {
    fail("cached scanner does not match the pinned binary — FAIL CLOSED");
  }
  return binary;
};

const scannerEnv = () => {
  const env = { ...process.env };
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  return env;
};

// Built-in default rules, no allowlist. Written outside the target and
// passed as --config so gitleaks does not read the target's toml.
const DEFAULT_RULES = "title = \"plerni-secrets-gate\"\n\n[extend]\nuseDefault = true\n";

const scanArgs = (reportPath, ignoreDir, configPath, source) => [
  "dir",
  "--no-banner",
  "--no-color",
  "--redact=100",
  "--log-level",
  "error",
  "--timeout",
  "60",
  "--config",
  configPath,
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
const configOnHost = join(outDir, "rules.toml");
writeFileSync(configOnHost, DEFAULT_RULES);
let failure = null;
let findingLines = null;
try {
  const env = scannerEnv();
  let code = 0;
  try {
    if (binary) {
      execFileSync(binary, scanArgs(reportOnHost, outDir, configOnHost, root), {
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
          ...scanArgs("/out/report.json", "/out", "/out/rules.toml", "/scan"),
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
