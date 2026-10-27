#!/usr/bin/env node
/**
 * SCA gate (spec §12): osv-scanner v2.7.0. Any advisory fails. A scanner
 * crash, a missing report, an empty package list, or an exit other than
 * 0 or 1 fails closed. Exit 0 with no advisories, and at least one
 * package in the report, passes. Exit 0 with an advisory still fails.
 *
 * The target directory is not trusted for configuration. osv-scanner reads
 * osv-scanner.toml beside a lockfile, and an ignore entry hides aliases of
 * that id. This gate always passes --config pointing at a file with no
 * ignores, which overrides every directory config (osv-scanner configuration
 * docs, retrieved 2026-10-27). There is no osv-scanner.toml in the repo:
 * the scanner has no path exclusion, so the vulnerable fixture is generated
 * outside the tree (plan T14).
 *
 * --all-packages is on so a clean lockfile still lists its package. An
 * empty result is not treated as clean.
 *
 * Scanner output is discarded. The diagnostic prints only an allowlisted
 * advisory id and package name, never the report body.
 *
 * Resolution order: --scanner, else the digest-pinned v2.7.0 image when
 * docker is installed, else the official v2.7.0 release binary.
 * The image pin is the registry Docker-Content-Digest of tag v2.7.0
 * (manifest list, 2026-10-27). The linux/amd64 and linux/arm64 configs
 * in that index are labeled 2.7.0 and their entrypoint is /osv-scanner.
 * Binary checksums are the published v2.7.0 sums file:
 * https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner_SHA256SUMS
 *
 * The binary fallback keeps its copy in the per-user cache (XDG_CACHE_HOME
 * when set, otherwise ~/.cache). Each directory from that root through the
 * version directory must be owned by the current user and not writable by
 * group or other. A cached binary is executed only when its own bytes match
 * the pinned digest. Stamp files in the cache are never read.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const IMAGE = "ghcr.io/google/osv-scanner:v2.7.0@sha256:4f3b7e2c64b9d38a5febc5a7e4a3dfef1d1362f726dea7a2ef4762b46469fcd0";
const VERSION = "2.7.0";
export const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,200}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REPORT_BYTES = 1_000_000;
const CONFIG_TEXT = "# no ignores\n";
const BINARIES = {
  "linux-x64": ["osv-scanner_linux_amd64", "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b"],
  "linux-arm64": ["osv-scanner_linux_arm64", "4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7"],
  "darwin-x64": ["osv-scanner_darwin_amd64", "e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45"],
  "darwin-arm64": ["osv-scanner_darwin_arm64", "d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b"],
};

class GateStop extends Error {}

const stop = (message) => {
  throw new GateStop(message);
};

const fail = (message) => {
  console.error(`sca gate: ${message}`);
  process.exit(1);
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
  if (typeof uid !== "number") stop("scanner cache is not private — FAIL CLOSED");
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
    stop("scanner cache is not private — FAIL CLOSED");
  }
  return null;
};

const assertPrivate = (st, kind) => {
  if (st.isSymbolicLink()) stop("scanner cache is not private — FAIL CLOSED");
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) stop("scanner cache is not private — FAIL CLOSED");
  if (st.uid !== cacheUid()) stop("scanner cache is not private — FAIL CLOSED");
  if ((st.mode & 0o022) !== 0) stop("scanner cache is not private — FAIL CLOSED");
};

const ensurePrivateDir = (dir) => {
  let st = lstatOrNull(dir);
  if (!st) {
    const parent = lstatOrNull(dirname(dir));
    if (!parent) stop("scanner cache is not private — FAIL CLOSED");
    assertPrivate(parent, "dir");
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      stop("scanner cache is not private — FAIL CLOSED");
    }
    st = lstatOrNull(dir);
  }
  if (!st) stop("scanner cache is not private — FAIL CLOSED");
  assertPrivate(st, "dir");
};

const privateCacheDir = () => {
  cacheUid();
  const xdg = process.env.XDG_CACHE_HOME;
  let dir;
  if (typeof xdg === "string" && xdg.length > 0) {
    if (!isSafeAbsolute(xdg)) stop("scanner cache is not private — FAIL CLOSED");
    dir = xdg;
  } else {
    const home = homedir();
    if (!isSafeAbsolute(home)) stop("scanner cache is not private — FAIL CLOSED");
    dir = join(home, ".cache");
  }
  ensurePrivateDir(dir);
  for (const part of ["plerni", "osv-scanner", VERSION, `${process.platform}-${process.arch}`]) {
    dir = join(dir, part);
    ensurePrivateDir(dir);
  }
  return dir;
};

const readRegularFile = (path) => {
  if ((constants.O_NOFOLLOW ?? 0) === 0) stop("scanner cache is not private — FAIL CLOSED");
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    stop("scanner cache is not private — FAIL CLOSED");
  }
  try {
    const st = fstatSync(fd);
    assertPrivate(st, "file");
    if (!Number.isSafeInteger(st.size) || st.size < 0 || st.size > 80 * 1024 * 1024) {
      stop("pinned scanner checksum mismatch — FAIL CLOSED");
    }
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) stop("pinned scanner checksum mismatch — FAIL CLOSED");
      offset += n;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pinnedBinary = () => {
  const spec = BINARIES[`${process.platform}-${process.arch}`];
  if (!Array.isArray(spec)) stop("pinned scanner is not published for this platform — FAIL CLOSED");
  const [file, binarySha256] = spec;
  if (typeof file !== "string" || !HEX64.test(binarySha256)) stop("pinned scanner checksum mismatch — FAIL CLOSED");
  const dir = privateCacheDir();
  const binary = join(dir, "osv-scanner");
  const cached = readRegularFile(binary);
  if (cached) {
    if (sha256(cached) !== binarySha256) stop("cached scanner does not match the pinned binary — FAIL CLOSED");
    return binary;
  }
  const partial = join(dir, `.osv-scanner.${process.pid}.partial`);
  try {
    rmSync(partial, { force: true });
  } catch {
    stop("scanner cache is not private — FAIL CLOSED");
  }
  const url = `https://github.com/google/osv-scanner/releases/download/v${VERSION}/${file}`;
  try {
    execFileSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "1", "--max-time", "120", "-o", partial, url], {
      stdio: "ignore",
    });
  } catch {
    rmSync(partial, { force: true });
    stop("pinned scanner download failed — FAIL CLOSED");
  }
  const downloaded = lstatOrNull(partial);
  if (!downloaded || downloaded.isSymbolicLink() || !downloaded.isFile() || downloaded.uid !== cacheUid()) {
    rmSync(partial, { force: true });
    stop("scanner cache is not private — FAIL CLOSED");
  }
  if ((downloaded.mode & 0o022) !== 0) {
    try {
      chmodSync(partial, 0o600);
    } catch {
      rmSync(partial, { force: true });
      stop("scanner cache is not private — FAIL CLOSED");
    }
  }
  const bytes = readRegularFile(partial);
  if (!bytes || sha256(bytes) !== binarySha256) {
    rmSync(partial, { force: true });
    stop("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  try {
    chmodSync(partial, 0o700);
    renameSync(partial, binary);
  } catch {
    try {
      rmSync(partial, { force: true });
    } catch {
      stop("scanner cache is not private — FAIL CLOSED");
    }
    stop("pinned scanner checksum mismatch — FAIL CLOSED");
  }
  const confirmed = readRegularFile(binary);
  if (!confirmed || sha256(confirmed) !== binarySha256) {
    stop("cached scanner does not match the pinned binary — FAIL CLOSED");
  }
  return binary;
};

const scanArgs = (lockfile, configPath, reportPath) => [
  "scan",
  "source",
  "--lockfile",
  lockfile,
  "--config",
  configPath,
  "--format",
  "json",
  "--output-file",
  reportPath,
  "--verbosity",
  "error",
  "--no-resolve",
  "--all-packages",
];

const takeId = (value, into) => {
  if (typeof value !== "string" || !ADVISORY_ID.test(value)) return false;
  into.add(value);
  return true;
};

const takeList = (list, into, limit) => {
  if (!Array.isArray(list) || list.length > limit) return false;
  for (const value of list) {
    if (!takeId(value, into)) return false;
  }
  return true;
};

export const collectReport = (reportText) => {
  let doc;
  try {
    doc = JSON.parse(reportText ?? "");
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.results)) {
    return { ok: false, message: "report is missing or not an osv-scanner result" };
  }
  if (doc.results.length > 20) return { ok: false, message: "report is too large" };
  const findings = [];
  let packages = 0;
  for (const result of doc.results) {
    if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.packages)) {
      return { ok: false, message: "report finding is malformed" };
    }
    if (result.packages.length > 50) return { ok: false, message: "report is too large" };
    for (const pkg of result.packages) {
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
        return { ok: false, message: "report finding is malformed" };
      }
      const name = pkg.package && typeof pkg.package === "object" ? pkg.package.name : undefined;
      if (typeof name !== "string" || !PACKAGE_NAME.test(name)) {
        return { ok: false, message: "report finding is malformed" };
      }
      packages += 1;
      const ids = new Set();
      const vulns = pkg.vulnerabilities ?? [];
      const groups = pkg.groups ?? [];
      if (!Array.isArray(vulns) || vulns.length > 50 || !Array.isArray(groups) || groups.length > 50) {
        return { ok: false, message: "report is too large" };
      }
      for (const vuln of vulns) {
        if (!vuln || typeof vuln !== "object" || Array.isArray(vuln)) {
          return { ok: false, message: "report finding is malformed" };
        }
        if (!takeId(vuln.id, ids)) return { ok: false, message: "report finding is malformed" };
        const aliases = vuln.aliases ?? [];
        if (!takeList(aliases, ids, 20)) return { ok: false, message: "report finding is malformed" };
      }
      for (const group of groups) {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          return { ok: false, message: "report finding is malformed" };
        }
        if (!takeList(group.ids ?? [], ids, 20)) return { ok: false, message: "report finding is malformed" };
        if (!takeList(group.aliases ?? [], ids, 20)) return { ok: false, message: "report finding is malformed" };
      }
      for (const id of ids) findings.push({ id, packageName: name });
    }
  }
  if (findings.length > 50) return { ok: false, message: "report is too large" };
  return { ok: true, findings, packages };
};

export const readReportFile = (path) => {
  try {
    const raw = readFileSync(path);
    if (raw.length > REPORT_BYTES) return { error: "report is too large" };
    return { text: raw.toString("utf8") };
  } catch {
    return { text: null };
  }
};

export const classifyGate = (code, reportText) => {
  if (code !== 0 && code !== 1) {
    return { failure: `scanner failed (exit ${code}) — a crash is not a finding` };
  }
  const report = collectReport(reportText);
  if (!report.ok) return { failure: `scanner failed (exit ${code}) — ${report.message}` };
  if (report.packages === 0) return { failure: `scanner failed (exit ${code}) — report listed no packages` };
  if (report.findings.length === 0) {
    if (code !== 0) return { failure: `scanner failed (exit ${code}) — report listed no findings` };
    return { ok: true };
  }
  const lines = [];
  for (const finding of report.findings) {
    const line = `sca gate: finding id ${finding.id} package ${finding.packageName}`;
    if (!lines.includes(line)) lines.push(line);
  }
  lines.sort();
  return { lines };
};

const mountable = (path) => !path.includes(",") && !path.includes(":");

export const scanLockfile = (root, options = {}) => {
  let resolved;
  try {
    resolved = realpathSync(root);
  } catch {
    return { failure: "root is not a directory — FAIL CLOSED" };
  }
  let rootStat;
  try {
    rootStat = statSync(resolved);
  } catch {
    return { failure: "root is not a directory — FAIL CLOSED" };
  }
  if (!rootStat.isDirectory()) return { failure: "root is not a directory — FAIL CLOSED" };
  if (!mountable(resolved)) return { failure: "root path is not mountable — FAIL CLOSED" };

  const explicit = typeof options.scanner === "string" && options.scanner.length > 0 ? options.scanner : null;
  let binary = explicit;
  let failure = null;
  if (!binary) {
    try {
      binary = hasDocker() ? null : pinnedBinary();
    } catch (err) {
      if (err instanceof GateStop) return { failure: err.message };
      return { failure: "scanner failed — FAIL CLOSED" };
    }
  }

  const outDir = mkdtempSync(join(tmpdir(), "plerni-sca-gate-"));
  if (!mountable(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
    return { failure: "root path is not mountable — FAIL CLOSED" };
  }
  const reportOnHost = join(outDir, "report.json");
  let code = 0;
  let reportText = null;
  try {
    writeFileSync(join(outDir, "gate.toml"), CONFIG_TEXT);
    try {
      if (binary) {
        execFileSync(binary, scanArgs(join(resolved, "package-lock.json"), join(outDir, "gate.toml"), reportOnHost), {
          cwd: outDir,
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
            `${resolved}:/scan:ro`,
            "-v",
            `${outDir}:/out`,
            IMAGE,
            ...scanArgs("/scan/package-lock.json", "/out/gate.toml", "/out/report.json"),
          ],
          { stdio: "ignore", timeout: 180000 },
        );
      }
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "EACCES")) failure = "scanner is not available — FAIL CLOSED";
      else if (typeof err?.status !== "number") failure = "scanner failed (no exit code) — a crash is not a finding";
      else code = err.status;
    }
    if (!failure) {
      const loaded = readReportFile(reportOnHost);
      if (loaded.error) failure = `scanner failed (exit ${code}) — ${loaded.error}`;
      else reportText = loaded.text;
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  if (failure) return { failure };
  return { code, reportText };
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      scanner: { type: "string" },
    },
  });
  if (typeof values.root !== "string" || values.root.length === 0) fail("root is required — FAIL CLOSED");
  const scanned = scanLockfile(values.root, { scanner: values.scanner });
  if (scanned.failure) fail(scanned.failure);
  const verdict = classifyGate(scanned.code, scanned.reportText);
  if (verdict.failure) fail(verdict.failure);
  if (verdict.lines) {
    console.error(verdict.lines.join("\n"));
    process.exit(1);
  }
  if (!verdict.ok) fail("scanner failed — FAIL CLOSED");
  console.log("sca gate OK");
}
