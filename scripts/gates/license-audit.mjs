#!/usr/bin/env node
/**
 * license-audit gate (spec §12): appliance dependencies must be OSI-approved.
 * Walks workspace package.json files, reads installed dependency licenses from
 * node_modules, and fails on missing/unknown/copyleft licenses.
 * Also audits direct dependencies of npm packages that sit outside the
 * workspace and carry their own package-lock.json (assets/brand). Those
 * licenses are read from the lockfile, and from node_modules when it is
 * present; a missing lockfile entry fails closed. Transitive lockfile
 * entries are not a second policy — the gate checks declared dependencies,
 * the same set it checks for workspace packages.
 * Usage: node scripts/gates/license-audit.mjs [--root <dir>]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
const lockDirs = [];
const walkLockfiles = (dir) => {
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
    const hasLock = existsSync(join(p, "package.json")) && existsSync(join(p, "package-lock.json"));
    if (!pkgDirs.includes(p) && hasLock) lockDirs.push(p);
    walkLockfiles(p);
  }
};
walkLockfiles(root);

const lockDeps = [];
for (const dir of lockDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (!range.startsWith("workspace:")) lockDeps.push({ name, range, dir });
  }
}

if (deps.size === 0 && lockDeps.length === 0) {
  console.log("license-audit: no external dependencies declared. OK (vacuous — gate-health covers the negative case).");
  process.exit(0);
}

const licenseOf = (pkg) => {
  const lic = pkg?.license;
  return typeof lic === "string" ? lic : lic?.type ?? "";
};

const judge = (label, licStr) => {
  if (ALLOWED.has(licStr)) return null;
  if (FORBIDDEN_HINTS.test(licStr)) return `${label}: forbidden license "${licStr}"`;
  return `${label}: unknown/unlisted license "${licStr || "MISSING"}" — review and allowlist explicitly`;
};

let failures = [];
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
  const problem = judge(name, licenseOf(JSON.parse(readFileSync(pkgPath, "utf8"))));
  if (problem) failures.push(problem);
}

const exactVersion = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
for (const { name, range, dir } of lockDeps) {
  const rel = relative(root, dir) || ".";
  const label = `${name} (${rel})`;
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) {
    failures.push(`${label}: missing from package-lock.json — fail closed`);
    continue;
  }
  if (exactVersion.test(range) && entry.version !== range) {
    failures.push(
      `${label}: lockfile version ${entry.version} does not match declared ${range}`,
    );
    continue;
  }
  const lockLic = typeof entry.license === "string" ? entry.license : "";
  const installedPath = join(dir, "node_modules", ...name.split("/"), "package.json");
  if (existsSync(installedPath)) {
    const installedLic = licenseOf(JSON.parse(readFileSync(installedPath, "utf8")));
    if (installedLic !== lockLic) {
      failures.push(
        `${label}: installed license "${installedLic}" does not match lockfile license "${lockLic}"`,
      );
      continue;
    }
  }
  const problem = judge(label, lockLic);
  if (problem) failures.push(problem);
}

if (failures.length) {
  console.error("license-audit: FAIL\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log(`license-audit: OK (${deps.size + lockDeps.length} dependencies checked)`);
