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
 * never from the lockfile's license field. An optional dependency this
 * platform did not install is skipped. A required dependency that is not
 * installed fails closed. A required peer that is not installed fails closed.
 * An optional peer (`peerDependenciesMeta.*.optional`) that is not installed
 * is skipped; an optional peer that is installed is judged.
 * Usage: node scripts/gates/license-audit.mjs [--root <dir>]
 */
import { readFileSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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

const deps = new Map(); // name -> owning package dir
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (!range.startsWith("workspace:")) deps.set(name, dir);
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

const auditTree = (pkgPath, label) => {
  // Follow the install layout (pnpm's virtual store is behind a symlink).
  const real = realpathSync(pkgPath);
  if (seenPackages.has(real)) return;
  seenPackages.add(real);
  const pkg = JSON.parse(readFileSync(real, "utf8"));
  checked++;
  const problem = judge(label, licenseOf(pkg));
  if (problem) failures.push(problem);
  const dir = dirname(real);
  const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (optional.has(name)) continue;
    const child = resolveInstalled(dir, name);
    if (!child) {
      failures.push(`${name} (required by ${label}): not installed — fail closed`);
      continue;
    }
    auditTree(child, `${name} (dependency of ${label})`);
  }
  for (const name of optional) {
    const child = resolveInstalled(dir, name);
    if (!child) continue;
    auditTree(child, `${name} (dependency of ${label})`);
  }
  const peerMeta = pkg.peerDependenciesMeta ?? {};
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    const child = resolveInstalled(dir, name);
    if (!child) {
      if (peerMeta[name]?.optional === true) continue;
      failures.push(`${name} (peer of ${label}): not installed — fail closed`);
      continue;
    }
    auditTree(child, `${name} (dependency of ${label})`);
  }
};

const lockDeps = [];
let failures = [];
for (const dir of isolatedDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const externals = Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter(
    ([, range]) => !String(range).startsWith("workspace:"),
  );
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
  auditTree(pkgPath, name);
}

for (const { name, range, dir } of lockDeps) {
  const rel = relative(root, dir) || ".";
  const label = `${name} (${rel})`;
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const rootSpec = lock.packages?.[""]?.dependencies?.[name] ?? lock.packages?.[""]?.optionalDependencies?.[name];
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
  auditTree(installedPath, label);
}

if (failures.length) {
  console.error("license-audit: FAIL\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log(`license-audit: OK (${checked} dependencies checked)`);
