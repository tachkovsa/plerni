#!/usr/bin/env node
/**
 * license-audit gate (spec §12): appliance dependencies must be OSI-approved.
 * Walks workspace package.json files, reads installed dependency licenses from
 * node_modules, and fails on missing/unknown/copyleft licenses.
 * Usage: node scripts/gates/license-audit.mjs [--root <dir>]
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

if (deps.size === 0) {
  console.log("license-audit: no external dependencies declared. OK (vacuous — gate-health covers the negative case).");
  process.exit(0);
}

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
  const lic = JSON.parse(readFileSync(pkgPath, "utf8")).license;
  const licStr = typeof lic === "string" ? lic : lic?.type ?? "";
  if (ALLOWED.has(licStr)) continue;
  if (FORBIDDEN_HINTS.test(licStr)) failures.push(`${name}: forbidden license "${licStr}"`);
  else failures.push(`${name}: unknown/unlisted license "${licStr || "MISSING"}" — review and allowlist explicitly`);
}

if (failures.length) {
  console.error("license-audit: FAIL\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log(`license-audit: OK (${deps.size} dependencies checked)`);
