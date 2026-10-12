#!/usr/bin/env node
/**
 * private-markers gate (AGENTS.md §0): forbid machine-local paths, internal
 * hostnames, and raw IP literals in a public repo. Patterns are governed —
 * changes require an ADR. Docs that *state* the policy (AGENTS.md) and this
 * gate itself are exempt by allowlist.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const defaultRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { values } = parseArgs({ options: { root: { type: "string", default: defaultRoot } } });
const root = resolve(values.root);
const isRepoRun = root === defaultRoot;

const PATTERNS = [
  { re: /\/Users\/[a-zA-Z0-9._-]+/g, label: "machine-local macOS path" },
  { re: /[A-Z]:\\Users\\[a-zA-Z0-9._-]+/g, label: "machine-local Windows path" },
  { re: /\/home\/[a-zA-Z0-9._-]+\//g, label: "machine-local Linux path" },
  { re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g, label: "RFC1918 IP literal" },
];

const EXEMPT = new Set([
  "AGENTS.md",                       // states the policy
  "scripts/gates/private-markers.mjs", // this gate
  "scripts/gates/gate-health.test.mjs",
]);

const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", "dist"]);
const violations = [];

const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const rel = relative(root, p);
    // Negative fixtures live inside the repo; the repo run skips them,
    // gate-health runs the gate *against* them via --root.
    if (isRepoRun && rel.startsWith(join("scripts", "gates", "fixtures"))) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
    } else {
      if (EXEMPT.has(rel)) continue;
      if (!/\.(md|txt|json|ya?ml|toml|ts|tsx|mts|js|mjs|html|css|sh)$/.test(e)) continue;
      const body = readFileSync(p, "utf8");
      for (const { re, label } of PATTERNS) {
        const m = body.match(re);
        if (m) violations.push(`${rel}: ${label} (${m[0].slice(0, 40)}…)`);
      }
    }
  }
};
walk(root);

if (violations.length) {
  console.error("private-markers: FAIL (AGENTS.md §0)\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log(`private-markers: OK (${PATTERNS.length} governed patterns)`);
