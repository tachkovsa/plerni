#!/usr/bin/env node
/**
 * private-markers gate (AGENTS.md §0): forbid machine-local paths, internal
 * hostnames, and raw IP literals in a public repo. Patterns are governed —
 * changes require an ADR. Maintainers may extend with a gitignored
 * `.private-markers.local` at the root (one regex per line).
 * Repository runs scan exactly the git-tracked tree (what would be published);
 * fixture roots (--root) are scanned by filesystem traversal. Docs that *state*
 * the policy (AGENTS.md) and this gate itself are exempt by allowlist.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
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

// Maintainer-local patterns (AGENTS.md §0): .private-markers.local at the
// scanned root, one regex per line (# comments, blank lines allowed). The file
// is gitignored — never committed; CI runs governed patterns only. An invalid
// regex fails closed.
let localCount = 0;
try {
  const lines = readFileSync(join(root, ".private-markers.local"), "utf8").split("\n");
  lines.forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith("#")) return;
    try {
      PATTERNS.push({ re: new RegExp(s, "gi"), label: `local private pattern (.private-markers.local:${i + 1})` });
      localCount++;
    } catch (err) {
      console.error(`private-markers: invalid regex at .private-markers.local:${i + 1} (${err.message}) — FAIL CLOSED`);
      process.exit(1);
    }
  });
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const EXEMPT = new Set([
  "AGENTS.md",                       // states the policy
  "scripts/gates/private-markers.mjs", // this gate
  "scripts/gates/gate-health.test.mjs",
]);

const SCAN_EXT = /\.(md|txt|json|ya?ml|toml|ts|tsx|mts|js|mjs|html|css|sh)$/;
const violations = [];

const scanFile = (p, rel) => {
  if (EXEMPT.has(rel)) return;
  if (!SCAN_EXT.test(p)) return;
  if (!existsSync(p)) return; // in the index but removed from the worktree (pending commit)
  const body = readFileSync(p, "utf8");
  for (const { re, label } of PATTERNS) {
    const m = body.match(re);
    if (m) violations.push(`${rel}: ${label} (${m[0].slice(0, 40)}…)`);
  }
};

if (isRepoRun) {
  // Scan exactly what would be published: the git-tracked tree (index
  // included). Local clutter — temp/, ignored tooling files like .mcp.json,
  // build output — never enters diagnostics. Negative fixtures are tracked but
  // skipped on repo runs; gate-health runs the gate *against* them via --root.
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  for (const rel of tracked.split("\n")) {
    if (!rel || rel.startsWith("scripts/gates/fixtures/")) continue;
    scanFile(join(root, rel), rel);
  }
} else {
  const SKIP_DIRS = new Set([".git", "node_modules", ".turbo", "dist", "temp"]);
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else scanFile(p, relative(root, p));
    }
  };
  walk(root);
}

if (violations.length) {
  console.error("private-markers: FAIL (AGENTS.md §0)\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log(`private-markers: OK (${PATTERNS.length - localCount} governed + ${localCount} local patterns)`);
