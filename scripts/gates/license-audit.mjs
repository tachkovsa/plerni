#!/usr/bin/env node
/**
 * license-audit gate (spec §12): appliance dependencies must be OSI-approved.
 * Walks workspace package.json files and the installed dependency graph,
 * including devDependencies, transitive dependencies, peer dependencies, and
 * platform-selected optional packages, and fails on missing/unknown/copyleft
 * licenses.
 * Also audits npm packages that sit outside the workspace (assets/brand).
 * A manifest with external dependencies and no package-lock.json fails
 * closed. The locked version of each direct dependency must satisfy the
 * manifest range. Workspace packages are judged from the installed manifest
 * after the package manager has installed them. An isolated package is
 * judged from its integrity-checked lockfile tarball. A tracked
 * node_modules manifest is not the license authority for an isolated
 * package, even when the version matches. The lockfile license field is
 * ignored. A missing tarball, a bad hash, a name or version that does
 * not match the lock entry, or more than one package/package.json in the
 * tarball fails closed.
 * A dependency of that tarball is resolved from the lock entry nested under
 * its parent, and the locked version must satisfy the parent's range. An
 * installed package of the same name at a different version does not stand
 * in for that child.
 * A required dependency that is not installed fails closed. A required peer
 * that is not installed fails closed, including a required peer declared by
 * an absent optional package's verified tarball. A required peer declared on
 * the package itself is audited even when it is the only external
 * declaration. An optional root peer is not seeded into that walk.
 * Each (owning package directory, dependency name) is an independent root.
 * A required peer in one workspace package does not replace a dependency
 * of the same name installed for another package.
 * An optional peer (`peerDependenciesMeta.*.optional`) that is not installed
 * is skipped. An optional peer that is installed is judged from the same
 * source as its parent: the verified tarball when the parent was verified
 * that way.
 * Usage: node scripts/gates/license-audit.mjs [--root <dir>]
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string", default: "." } } });
const root = values.root;

const ALLOWED = new Set([
  "MIT", "MIT-0", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause",
  "0BSD", "CC0-1.0", "Unlicense", "Python-2.0", "BlueOak-1.0.0",
]);
const FORBIDDEN_HINTS = /GPL|AGPL|SSPL|LGPL|RSAL|BUSL|Elastic/i;

// Scope: workspace globs from pnpm-workspace.yaml (fixture/test trees are never
// workspaces, so they can't contaminate the real audit; with no workspace file
// present — e.g. a fixture root — audit the root itself only).
const pkgDirs = [];
const wsPath = join(root, "pnpm-workspace.yaml");
if (existsSync(wsPath)) {
  const ws = readFileSync(wsPath, "utf8");
  const globs = [...ws.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);
  for (const g of globs) {
    const parent = join(root, g.replace(/\/\*+$/, ""));
    if (!existsSync(parent)) continue;
    for (const e of readdirSync(parent)) {
      const p = join(parent, e);
      if (statSync(p).isDirectory() && existsSync(join(p, "package.json"))) pkgDirs.push(p);
    }
  }
  if (existsSync(join(root, "package.json"))) pkgDirs.push(root); // root package
} else {
  pkgDirs.push(root);
}
pkgDirs.sort();

const requiredPeerEntries = (pkg) => {
  const meta = pkg.peerDependenciesMeta ?? {};
  return Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => meta[name]?.optional !== true);
};

// One root per owning directory and name. A later peer must not replace an
// earlier install of the same name in another package.
const deps = [];
const seenRoots = new Set();
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const [name, range] of [
    ...Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies }),
    ...requiredPeerEntries(pkg),
  ]) {
    if (String(range).startsWith("workspace:")) continue;
    const key = `${dir}\0${name}`;
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    deps.push({ name, dir });
  }
}

// npm packages outside the workspace (not matched by pnpm-workspace globs).
// Fixture trees are scanned only when --root points at them.
const fixtureRoot = join("scripts", "gates", "fixtures");
const isolatedDirs = [];
const walkPackages = (dir) => {
  const rel = relative(root, dir);
  if (rel === fixtureRoot || rel.startsWith(fixtureRoot + sep)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const childRel = relative(root, p);
    if (childRel === fixtureRoot || childRel.startsWith(fixtureRoot + sep)) continue;
    if (!pkgDirs.includes(p) && existsSync(join(p, "package.json"))) isolatedDirs.push(p);
    walkPackages(p);
  }
};
walkPackages(root);

let checked = 0;
const seenPackages = new Set();

const licenseOf = (pkg) => {
  const lic = pkg?.license;
  return typeof lic === "string" ? lic : lic?.type ?? "";
};

const judge = (label, licStr) => {
  if (ALLOWED.has(licStr)) return null;
  if (FORBIDDEN_HINTS.test(licStr)) return `${label}: forbidden license "${licStr}"`;
  return `${label}: unknown/unlisted license "${licStr || "MISSING"}" — review and allowlist explicitly`;
};

const parseVer = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const cmpVer = (left, right) => {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
};

// true / false when the range is understood, null when it is not (fail closed).
const satisfies = (version, range) => {
  const ver = parseVer(version);
  const trimmed = range.trim();
  if (!ver) return false;
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(trimmed)) return version === trimmed;
  const caret = /^\^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(trimmed);
  if (caret) {
    const floor = [Number(caret[1]), Number(caret[2]), Number(caret[3])];
    if (cmpVer(ver, floor) < 0) return false;
    if (floor[0] > 0) return ver[0] === floor[0];
    if (floor[1] > 0) return ver[0] === 0 && ver[1] === floor[1];
    return ver[0] === 0 && ver[1] === 0 && ver[2] === floor[2];
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(trimmed);
  if (tilde) {
    const floor = [Number(tilde[1]), Number(tilde[2]), Number(tilde[3])];
    if (cmpVer(ver, floor) < 0) return false;
    return ver[0] === floor[0] && ver[1] === floor[1];
  }
  return null;
};

// node resolution from pkgDir, never above --root. Scoped names are
// node_modules/@scope/name. Missing optional packages are skipped by the caller.
const resolveInstalled = (pkgDir, name) => {
  let dir = pkgDir;
  const segments = name.split("/");
  for (;;) {
    const candidate = join(dir, "node_modules", ...segments, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith("..")) return null;
    dir = parent;
  }
};

const lockCache = new Map();
const seenLocked = new Set();

const findPnpmLock = (startDir) => {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "pnpm-lock.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith("..")) return null;
    dir = parent;
  }
};

const pnpmPackageCache = new Map();

// pnpm-lock.yaml v9 has no npm `resolved` URL. Integrity is on the package
// key; the registry tarball URL is the public npm form of that name and version.
const readPnpmPackages = (lockPath) => {
  if (pnpmPackageCache.has(lockPath)) return pnpmPackageCache.get(lockPath);
  const packages = [];
  let inPackages = false;
  let current = null;
  const flush = () => {
    if (current) packages.push(current);
    current = null;
  };
  for (const line of readFileSync(lockPath, "utf8").split("\n")) {
    if (!inPackages) {
      if (line === "packages:") inPackages = true;
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ")) {
      flush();
      break;
    }
    const keyMatch = /^  ['"]?(.+?)['"]?:$/.exec(line);
    if (keyMatch) {
      flush();
      current = { key: keyMatch[1], integrity: null, directory: null };
      continue;
    }
    if (!current) continue;
    const integrity = /integrity: (sha\d+-[A-Za-z0-9+/=]+)/.exec(line);
    if (integrity) current.integrity = integrity[1];
    const directory = /directory: ([^,}]+)/.exec(line);
    if (directory) current.directory = directory[1].trim();
  }
  flush();
  pnpmPackageCache.set(lockPath, packages);
  return packages;
};

const splitPnpmKey = (key) => {
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
};

const registryTarball = (name, version) => {
  const leaf = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${leaf}-${version}.tgz`;
};

const findLock = (startDir) => {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package-lock.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith("..")) return null;
    dir = parent;
  }
};

const readLock = (startDir) => {
  const lockPath = findLock(startDir);
  if (!lockPath) return null;
  if (!lockCache.has(lockPath)) lockCache.set(lockPath, { lockPath, lock: JSON.parse(readFileSync(lockPath, "utf8")) });
  return lockCache.get(lockPath);
};

const lockKeyForInstalled = (lock, pkg) => {
  const suffix = `node_modules/${pkg.name}`;
  let best = null;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (entry?.version !== pkg.version) continue;
    if (key !== suffix && !key.endsWith(`/${suffix}`)) continue;
    if (!best || key.length < best.length) best = key;
  }
  return best;
};

// npm resolves a child from the parent path, nearest node_modules first.
const entryFor = (lock, parentKey, name) => {
  const packages = lock.packages ?? {};
  let cursor = parentKey ?? "";
  const seen = new Set();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const key = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return { key, entry: packages[key] };
    if (!cursor) return null;
    const marker = "/node_modules/";
    const idx = cursor.lastIndexOf(marker);
    cursor = idx === -1 ? "" : cursor.slice(0, idx);
  }
  return null;
};

const fetchCache = new Map();

const integrityMatches = (bytes, integrity) => {
  const parts = String(integrity ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const dash = part.indexOf("-");
    if (dash <= 0) return false;
    const algo = part.slice(0, dash);
    const expected = part.slice(dash + 1);
    try {
      return createHash(algo).update(bytes).digest("base64") === expected;
    } catch {
      return false;
    }
  });
};

const readCString = (buf) => buf.toString("utf8").replace(/\0.*$/, "");

const paxPath = (data) => {
  const text = data.toString("utf8");
  let i = 0;
  let path = null;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space <= i) break;
    const len = Number(text.slice(i, space));
    if (!Number.isInteger(len) || len <= 0 || i + len > text.length) break;
    const body = text.slice(space + 1, i + len);
    if (body.startsWith("path=")) path = body.slice("path=".length).replace(/\n$/, "");
    i += len;
  }
  return path;
};

// npm keeps the last regular-file package/package.json when an archive repeats
// that path. Exactly one such entry is accepted; zero or two is fail-closed.
const packageJsonFromTarball = (bytes, accept = (name) => name === "package/package.json") => {
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch {
    return { error: "tarball is not gzip" };
  }
  let offset = 0;
  let pendingName = null;
  const manifests = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(readCString(header.subarray(124, 136)).trim(), 8);
    const typeflag = header[156];
    offset += 512;
    if (!Number.isFinite(size) || size < 0 || offset + size > tar.length) return { error: "tarball is truncated" };
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeflag === 76) { // GNU long name for the next entry
      pendingName = readCString(data);
      continue;
    }
    if (typeflag === 120) { // pax extended header for the next entry
      pendingName = paxPath(data) ?? pendingName;
      continue;
    }
    const prefix = readCString(header.subarray(345, 500));
    const shortName = readCString(header.subarray(0, 100));
    const rawName = pendingName ?? (prefix ? `${prefix.replace(/\/$/, "")}/${shortName.replace(/^\//, "")}` : shortName);
    pendingName = null;
    const name = rawName.replace(/^\.\//, "");
    const regular = typeflag === 0 || typeflag === 48;
    if (regular && accept(name)) manifests.push(data);
  }
  if (manifests.length !== 1) {
    return {
      error: manifests.length === 0
        ? "tarball has no package/package.json"
        : "tarball contains more than one package/package.json",
    };
  }
  try {
    return { pkg: JSON.parse(manifests[0].toString("utf8")) };
  } catch {
    return { error: "tarball package manifest is not JSON" };
  }
};

// file: paths must stay inside --root. https tarballs are fetched and hashed.
const readResolvedTarball = async (resolved, lockPath) => {
  if (typeof resolved !== "string" || resolved.length === 0) return { error: "no integrity-checked tarball" };
  if (resolved.startsWith("file:")) {
    let abs;
    try {
      const spec = resolved.startsWith("file://")
        ? new URL(resolved).pathname
        : resolved.slice("file:".length);
      abs = resolve(dirname(lockPath), spec);
    } catch {
      return { error: "resolved tarball URL is invalid" };
    }
    const relToRoot = relative(root, abs);
    if (relToRoot.startsWith("..") || relToRoot === "") return { error: "resolved tarball is outside the audit root" };
    if (!existsSync(abs)) return { error: "resolved tarball is missing" };
    return { bytes: readFileSync(abs) };
  }
  if (!/^https:\/\//i.test(resolved)) return { error: "resolved URL is not verifiable" };
  if (!fetchCache.has(resolved)) {
    try {
      const res = await fetch(resolved, { redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (!res.ok) fetchCache.set(resolved, { error: `tarball download failed (${res.status})` });
      else fetchCache.set(resolved, { bytes: Buffer.from(await res.arrayBuffer()) });
    } catch {
      fetchCache.set(resolved, { error: "tarball download failed" });
    }
  }
  return fetchCache.get(resolved);
};

// Optional packages for other OS/CPU targets are absent here. Their license
// comes from the integrity-checked tarball, never from the lockfile license field.
const auditLockedOptional = async (startDir, name, label, relation = "verified optional dependency", spec = {}) => {
  const found = readLock(startDir);
  const where = `${name} (${relation} of ${label})`;
  if (!found) {
    failures.push(`${name} (optional dependency of ${label}): not installed and no package-lock.json — fail closed`);
    return;
  }
  if (typeof spec.parentKey !== "string" || typeof spec.range !== "string" || spec.range.trim() === "") {
    failures.push(`${where}: parent lock entry or dependency range is missing — fail closed`);
    return;
  }
  const resolved = entryFor(found.lock, spec.parentKey, name);
  if (!resolved) {
    failures.push(`${where}: missing from package-lock.json under ${spec.parentKey} — fail closed`);
    return;
  }
  const { key, entry } = resolved;
  const sat = typeof entry.version === "string" ? satisfies(entry.version, spec.range) : false;
  if (sat !== true) {
    failures.push(
      `${where}: lockfile version ${entry.version ?? "MISSING"} does not satisfy range ${spec.range} — fail closed`,
    );
    return;
  }
  const id = `${found.lockPath}\0${key}\0${entry.version ?? ""}\0${entry.resolved ?? ""}\0${entry.integrity ?? ""}`;
  if (seenLocked.has(id)) return;
  seenLocked.add(id);
  if (!entry.resolved || !entry.integrity) {
    failures.push(`${where}: lockfile entry has no integrity-checked tarball — fail closed`);
    return;
  }
  const loaded = await readResolvedTarball(entry.resolved, found.lockPath);
  if (loaded.error || !loaded.bytes) {
    failures.push(`${where}: tarball could not be verified (${loaded.error ?? "missing"}) — fail closed`);
    return;
  }
  if (!integrityMatches(loaded.bytes, entry.integrity)) {
    failures.push(`${where}: tarball integrity check failed — fail closed`);
    return;
  }
  const parsed = packageJsonFromTarball(loaded.bytes);
  if (!parsed.pkg) {
    failures.push(`${where}: ${parsed.error ?? "tarball has no readable package manifest"} — fail closed`);
    return;
  }
  const pkg = parsed.pkg;
  if (pkg.name !== name || pkg.version !== entry.version) {
    failures.push(`${where}: verified tarball does not match the locked name and version — fail closed`);
    return;
  }
  checked++;
  const problem = judge(where, licenseOf(pkg));
  if (problem) failures.push(problem);
  const optionalChildren = pkg.optionalDependencies ?? {};
  for (const [child, childRange] of Object.entries(pkg.dependencies ?? {})) {
    if (Object.prototype.hasOwnProperty.call(optionalChildren, child)) continue;
    await auditLockedOptional(startDir, child, where, "verified dependency", { parentKey: key, range: childRange });
  }
  for (const [child, childRange] of Object.entries(optionalChildren)) {
    await auditLockedOptional(startDir, child, where, "verified optional dependency", {
      parentKey: key,
      range: childRange,
    });
  }
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  for (const [child, childRange] of Object.entries(pkg.peerDependencies ?? {})) {
    if (peerMeta[child]?.optional === true) {
      const childPath = resolveInstalled(startDir, child);
      if (!childPath) continue;
      await auditLockedOptional(startDir, child, where, "verified peer", { parentKey: key, range: String(childRange) });
      continue;
    }
    await auditLockedOptional(startDir, child, where, "verified peer", { parentKey: key, range: String(childRange) });
  }
};

// Missing optional packages of a pnpm install have no package-lock.json entry.
// Verify them from pnpm-lock.yaml and the integrity-checked registry tarball.
const auditPnpmMissing = async (startDir, name, label, range) => {
  const lockPath = findPnpmLock(startDir);
  const where = `${name} (optional dependency of ${label})`;
  if (!lockPath) return false;
  if (typeof range !== "string" || range.trim() === "") {
    failures.push(`${where}: dependency range is missing — fail closed`);
    return true;
  }
  const matches = [];
  for (const entry of readPnpmPackages(lockPath)) {
    const parsed = splitPnpmKey(entry.key);
    if (!parsed || parsed.name !== name) continue;
    if (satisfies(parsed.version, range) === true) matches.push({ ...entry, ...parsed });
  }
  if (matches.length !== 1) {
    failures.push(`${where}: pnpm-lock.yaml has ${matches.length} versions that satisfy ${range} — fail closed`);
    return true;
  }
  const match = matches[0];
  const id = `${lockPath}\0${match.key}\0${match.integrity ?? ""}\0${match.directory ?? ""}`;
  if (seenLocked.has(id)) return true;
  seenLocked.add(id);
  let pkg;
  if (match.directory) {
    const abs = resolve(dirname(lockPath), match.directory);
    const relToRoot = relative(root, abs);
    if (relToRoot.startsWith("..") || relToRoot === "") {
      failures.push(`${where}: pnpm directory is outside the audit root — fail closed`);
      return true;
    }
    const manifest = join(abs, "package.json");
    if (!existsSync(manifest)) {
      failures.push(`${where}: pnpm directory has no package.json — fail closed`);
      return true;
    }
    pkg = JSON.parse(readFileSync(manifest, "utf8"));
  } else {
    if (!match.integrity) {
      failures.push(`${where}: pnpm-lock.yaml entry has no integrity — fail closed`);
      return true;
    }
    const loaded = await readResolvedTarball(registryTarball(name, match.version), lockPath);
    if (loaded.error || !loaded.bytes) {
      failures.push(`${where}: tarball could not be verified (${loaded.error ?? "missing"}) — fail closed`);
      return true;
    }
    if (!integrityMatches(loaded.bytes, match.integrity)) {
      failures.push(`${where}: tarball integrity check failed — fail closed`);
      return true;
    }
    const parsedTarball = packageJsonFromTarball(loaded.bytes, (name) => /^[^/]+\/package\.json$/.test(name));
    if (!parsedTarball.pkg) {
      failures.push(`${where}: ${parsedTarball.error ?? "tarball has no readable package manifest"} — fail closed`);
      return true;
    }
    pkg = parsedTarball.pkg;
    if (pkg.name !== name || pkg.version !== match.version) {
      failures.push(`${where}: verified tarball does not match the locked name and version — fail closed`);
      return true;
    }
  }
  checked++;
  const problem = judge(`${where}, verified from pnpm-lock.yaml`, licenseOf(pkg));
  if (problem) failures.push(problem);
  const optionalChildren = pkg.optionalDependencies ?? {};
  for (const [child, childRange] of Object.entries(pkg.dependencies ?? {})) {
    if (Object.prototype.hasOwnProperty.call(optionalChildren, child)) continue;
    const childPath = resolveInstalled(startDir, child);
    if (childPath) await auditTree(childPath, `${child} (dependency of ${where})`);
    else await auditPnpmMissing(startDir, child, where, String(childRange));
  }
  for (const [child, childRange] of Object.entries(optionalChildren)) {
    const childPath = resolveInstalled(startDir, child);
    if (childPath) await auditTree(childPath, `${child} (dependency of ${where})`);
    else await auditPnpmMissing(startDir, child, where, String(childRange));
  }
  return true;
};

const auditTree = async (pkgPath, label) => {
  // Follow the install layout (pnpm's virtual store is behind a symlink).
  const real = realpathSync(pkgPath);
  if (seenPackages.has(real)) return;
  seenPackages.add(real);
  const pkg = JSON.parse(readFileSync(real, "utf8"));
  checked++;
  const problem = judge(label, licenseOf(pkg));
  if (problem) failures.push(problem);
  const dir = dirname(real);
  const lockFound = readLock(dir);
  const parentKey = lockFound ? lockKeyForInstalled(lockFound.lock, pkg) : null;
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (optional.has(name)) continue;
    const child = resolveInstalled(dir, name);
    if (!child) {
      failures.push(`${name} (required by ${label}): not installed — fail closed`);
      continue;
    }
    await auditTree(child, `${name} (dependency of ${label})`);
  }
  for (const name of optional) {
    const child = resolveInstalled(dir, name);
    if (child) {
      await auditTree(child, `${name} (dependency of ${label})`);
      continue;
    }
    if (!parentKey) {
      const handled = await auditPnpmMissing(dir, name, label, pkg.optionalDependencies?.[name] ?? "");
      if (!handled) {
        failures.push(`${name} (optional dependency of ${label}): installed parent is not in package-lock.json — fail closed`);
      }
      continue;
    }
    await auditLockedOptional(dir, name, label, "verified optional dependency", {
      parentKey,
      range: pkg.optionalDependencies?.[name] ?? "",
    });
  }
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    const child = resolveInstalled(dir, name);
    if (!child) {
      if (peerMeta[name]?.optional === true) continue;
      failures.push(`${name} (peer of ${label}): not installed — fail closed`);
      continue;
    }
    await auditTree(child, `${name} (dependency of ${label})`);
  }
};

const lockDeps = [];
let failures = [];
for (const dir of isolatedDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const externals = [
    ...Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies }),
    ...requiredPeerEntries(pkg),
  ].filter(([, range]) => !String(range).startsWith("workspace:"));
  if (externals.length === 0) continue;
  const rel = relative(root, dir) || ".";
  if (!existsSync(join(dir, "package-lock.json"))) {
    failures.push(`${rel}: dependencies declared but package-lock.json is missing — fail closed`);
    continue;
  }
  const peers = new Set(requiredPeerEntries(pkg).map(([name]) => name));
  for (const [name, range] of externals) {
    lockDeps.push({ name, range, dir, relation: peers.has(name) ? "verified peer" : "verified dependency" });
  }
}

if (deps.length === 0 && lockDeps.length === 0 && failures.length === 0) {
  console.log("license-audit: no external dependencies declared. OK (vacuous — gate-health covers the negative case).");
  process.exit(0);
}

const main = async () => {
  for (const { name, dir: ownerDir } of deps) {
    const candidates = [
      join(ownerDir, "node_modules", ...name.split("/"), "package.json"),
      join(root, "node_modules", ...name.split("/"), "package.json"),
    ];
    const pkgPath = candidates.find((p) => existsSync(p));
    if (!pkgPath) {
      failures.push(`${name}: not installed (checked: ${candidates.join(", ")}) — run pnpm install; gate is fail-closed`);
      continue;
    }
    await auditTree(pkgPath, name);
  }

  for (const { name, range, dir, relation } of lockDeps) {
    const rel = relative(root, dir) || ".";
    const label = `${name} (${rel})`;
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    const rootPkg = lock.packages?.[""] ?? {};
    const rootSpec =
      rootPkg.dependencies?.[name] ?? rootPkg.devDependencies?.[name] ?? rootPkg.optionalDependencies?.[name] ?? rootPkg.peerDependencies?.[name];
    if (rootSpec !== range) {
      failures.push(`${label}: lockfile root specifier "${rootSpec ?? "MISSING"}" does not match manifest "${range}"`);
    }
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) {
      failures.push(`${label}: missing from package-lock.json — fail closed`);
      continue;
    }
    const sat = satisfies(entry.version, range);
    if (sat === null) {
      failures.push(`${label}: cannot validate manifest range "${range}" — fail closed`);
    } else if (!sat) {
      failures.push(`${label}: lockfile version ${entry.version} does not satisfy manifest range ${range}`);
    }
    await auditLockedOptional(dir, name, rel, relation, { parentKey: "", range });
  }

  if (failures.length) {
    console.error("license-audit: FAIL\n" + failures.map((f) => "  " + f).join("\n"));
    process.exit(1);
  }
  console.log(`license-audit: OK (${checked} dependencies checked)`);
};

main().catch((err) => {
  console.error(`license-audit: ${err instanceof Error ? err.message : err} — FAIL CLOSED`);
  process.exit(1);
});
