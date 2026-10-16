#!/usr/bin/env node
/**
 * license-audit gate (spec §12): appliance dependencies must be OSI-approved.
 * Walks workspace package.json files and the installed dependency graph,
 * including transitive dependencies, peer dependencies, and platform-selected
 * optional packages, and fails on missing/unknown/copyleft licenses.
 * Also audits npm packages that sit outside the workspace (assets/brand).
 * A manifest with external dependencies and no package-lock.json fails
 * closed. The locked version of each direct dependency must satisfy the
 * manifest range. Every license is read from the installed package manifest,
 * never from the lockfile's license field when the package is installed.
 * An optional dependency this platform did not install is still judged.
 * The lockfile supplies the tarball URL and integrity hash; the license is
 * read from that tarball's package.json after the hash matches. The lockfile
 * license field is ignored. A missing tarball, a bad hash, or a name or
 * version that does not match the lock entry fails closed.
 * A dependency of that tarball is resolved from the lock entry nested under
 * its parent, and the locked version must satisfy the parent's range. An
 * installed package of the same name at a different version does not stand
 * in for that child.
 * A required dependency that is not installed fails closed. A required peer
 * that is not installed fails closed, including a required peer declared by
 * an absent optional package's verified tarball. A required peer declared on
 * the package itself is audited even when it is the only external
 * declaration. An optional root peer is not seeded into that walk.
 * An optional peer (`peerDependenciesMeta.*.optional`) that is not installed
 * is skipped; an optional peer that is installed is judged.
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

const requiredPeerEntries = (pkg) => {
  const meta = pkg.peerDependenciesMeta ?? {};
  return Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => meta[name]?.optional !== true);
};

const deps = new Map(); // name -> owning package dir
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const [name, range] of [
    ...Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }),
    ...requiredPeerEntries(pkg),
  ]) {
    if (!String(range).startsWith("workspace:")) deps.set(name, dir);
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

const packageJsonFromTarball = (bytes) => {
  let tar;
  try {
    tar = gunzipSync(bytes);
  } catch {
    return null;
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim(), 8);
    offset += 512;
    if (!Number.isFinite(size) || size < 0 || offset + size > tar.length) return null;
    const data = tar.subarray(offset, offset + size);
    if (name === "package/package.json") {
      try {
        return JSON.parse(data.toString("utf8"));
      } catch {
        return null;
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
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
  if (!spec.parentKey || typeof spec.range !== "string" || spec.range.trim() === "") {
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
  const pkg = packageJsonFromTarball(loaded.bytes);
  if (!pkg || pkg.name !== name || pkg.version !== entry.version) {
    failures.push(`${where}: verified tarball does not match the locked name and version — fail closed`);
    return;
  }
  checked++;
  const problem = judge(where, licenseOf(pkg));
  if (problem) failures.push(problem);
  const nested = { ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const [child, childRange] of Object.entries(nested)) {
    await auditLockedOptional(startDir, child, where, "verified dependency", { parentKey: key, range: childRange });
  }
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  for (const [child, childRange] of Object.entries(pkg.peerDependencies ?? {})) {
    if (peerMeta[child]?.optional === true) {
      const childPath = resolveInstalled(startDir, child);
      if (!childPath) continue;
      const installed = JSON.parse(readFileSync(childPath, "utf8"));
      if (satisfies(installed.version, String(childRange)) !== true) continue;
      await auditTree(childPath, `${child} (dependency of ${where})`);
      continue;
    }
    await auditLockedOptional(startDir, child, where, "verified peer", { parentKey: key, range: String(childRange) });
  }
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
      failures.push(`${name} (optional dependency of ${label}): installed parent is not in package-lock.json — fail closed`);
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
    ...Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }),
    ...requiredPeerEntries(pkg),
  ].filter(([, range]) => !String(range).startsWith("workspace:"));
  if (externals.length === 0) continue;
  const rel = relative(root, dir) || ".";
  if (!existsSync(join(dir, "package-lock.json"))) {
    failures.push(`${rel}: dependencies declared but package-lock.json is missing — fail closed`);
    continue;
  }
  for (const [name, range] of externals) lockDeps.push({ name, range, dir });
}

if (deps.size === 0 && lockDeps.length === 0 && failures.length === 0) {
  console.log("license-audit: no external dependencies declared. OK (vacuous — gate-health covers the negative case).");
  process.exit(0);
}

const main = async () => {
  for (const [name, ownerDir] of deps) {
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

  for (const { name, range, dir } of lockDeps) {
    const rel = relative(root, dir) || ".";
    const label = `${name} (${rel})`;
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
    const rootPkg = lock.packages?.[""] ?? {};
    const rootSpec =
      rootPkg.dependencies?.[name] ?? rootPkg.optionalDependencies?.[name] ?? rootPkg.peerDependencies?.[name];
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
    const installedPath = join(dir, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(installedPath)) {
      failures.push(`${label}: not installed — run npm ci --ignore-scripts in ${rel}; gate is fail-closed`);
      continue;
    }
    const installed = JSON.parse(readFileSync(installedPath, "utf8"));
    if (installed.version && entry.version && installed.version !== entry.version) {
      failures.push(
        `${label}: installed version ${installed.version} does not match lockfile version ${entry.version}`,
      );
    }
    await auditTree(installedPath, label);
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
