#!/usr/bin/env node
/**
 * gate-health suite (spec §12, principle 16): proves the gates can fail.
 * Every gate is run against a deliberately-bad fixture; a gate that does not
 * block its fixture is itself a failure. Gates proven here: kernel-purity,
 * license-audit. (gitleaks' negative proof is its own fixture scan in CI.)
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

const cases = [
  {
    name: "kernel-purity blocks a domain noun in kernel code",
    cmd: [process.execPath, [join(here, "kernel-purity.mjs"), "--root", join(fixtures, "kernel-noun")]],
    expectExit: 1,
  },
  {
    name: "license-audit blocks a GPL dependency",
    cmd: [process.execPath, [join(here, "license-audit.mjs"), "--root", join(fixtures, "gpl-dep")]],
    expectExit: 1,
  },
  {
    name: "private-markers blocks machine-local paths/IPs",
    cmd: [process.execPath, [join(here, "private-markers.mjs"), "--root", join(fixtures, "private-path")]],
    expectExit: 1,
  },
];

let failed = 0;
for (const c of cases) {
  let code = 0;
  try {
    execFileSync(c.cmd[0], c.cmd[1], { stdio: "pipe" });
  } catch (e) {
    code = e.status ?? 1;
  }
  const ok = code === c.expectExit;
  console.log(`${ok ? "✓" : "✗"} ${c.name} (exit ${code}, expected ${c.expectExit})`);
  if (!ok) failed++;
}

if (failed) {
  console.error(`gate-health: ${failed} gate(s) failed to block their negative fixtures — FAIL`);
  process.exit(1);
}
console.log(`gate-health: OK (${cases.length} gates proven fail-closed)`);
