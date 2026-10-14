// run.mjs — Entry point for the IPC harness spike.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { smoke } from './cases/smoke.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(__dirname, '..', 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = join(evidenceDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

function record(row) {
  appendFileSync(evidenceFile, JSON.stringify(row) + '\n');
  const mark = row.pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${row.case} — ${JSON.stringify(row.detail)}`);
}

async function main() {
  console.log(`[run] IPC harness spike starting...`);
  console.log(`[run] Evidence will be written to: ${evidenceFile}`);

  const smokeResult = await smoke();
  record({ case: 'smoke', pass: smokeResult.pass, detail: smokeResult.detail });

  console.log(`[run] Spike complete. Evidence: ${evidenceFile}`);
  process.exit(smokeResult.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`[run] fatal: ${e.stack}`);
  process.exit(1);
});
