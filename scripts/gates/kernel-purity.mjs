#!/usr/bin/env node
/**
 * kernel-purity gate (spec §3): the kernel must not contain domain logic.
 * Scans apps/kernel/src for governed domain nouns (docs/gates/domain-nouns.txt).
 * Allowlist: docs/gates/kernel-purity-allowlist.txt (changes require an ADR — spec §3).
 * Usage: node scripts/gates/kernel-purity.mjs [--root <dir>]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { root: { type: "string", default: "." } } });
const root = values.root;
const kernelSrc = join(root, "apps/kernel/src");

const readLines = (p) => {
  try {
    return readFileSync(p, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  } catch {
    return [];
  }
};

const nouns = readLines(join(root, "docs/gates/domain-nouns.txt"));
const allowlist = new Set(readLines(join(root, "docs/gates/kernel-purity-allowlist.txt")));

if (nouns.length === 0) {
  console.error("kernel-purity: domain-nouns.txt is empty or missing — gate would be vacuous. FAIL CLOSED.");
  process.exit(1);
}

let files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts)$/.test(e)) files.push(p);
  }
};
try {
  walk(kernelSrc);
} catch {
  console.log(`kernel-purity: ${kernelSrc} does not exist yet (P0). Fixture coverage is proven by gate-health.`);
  process.exit(0);
}

let violations = [];
for (const f of files) {
  const body = readFileSync(f, "utf8");
  const rel = relative(root, f);
  for (const noun of nouns) {
    if (allowlist.has(`${rel}:${noun}`)) continue;
    const re = new RegExp(`\\b${noun}\\b`, "i");
    const m = body.match(re);
    if (m) violations.push(`${rel}: domain noun "${noun}"`);
  }
}

if (violations.length) {
  console.error("kernel-purity: domain logic in kernel — forbidden (spec §3):\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
console.log(`kernel-purity: OK (${files.length} files, ${nouns.length} governed nouns)`);
