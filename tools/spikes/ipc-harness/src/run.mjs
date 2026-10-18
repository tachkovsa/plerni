// run.mjs — Entry point for the IPC harness spike.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { smoke } from './cases/smoke.mjs';
import { b1 } from './cases/b1-throughput.mjs';
import { b2 } from './cases/b2-fencing.mjs';
import { b3 } from './cases/b3-backpressure.mjs';
import { b4 } from './cases/b4-bounds.mjs';
import { b5 } from './cases/b5-crash.mjs';
import { b6 } from './cases/b6-mux-identity.mjs';
import { deathBeforeCommit } from './races/death-before-commit.mjs';
import { lostReply } from './races/lost-reply.mjs';
import { recoveryVsLiveCommit } from './races/recovery-vs-live-commit.mjs';
import { healthyLong } from './races/healthy-long.mjs';
import { heartbeatBehindCommit } from './races/heartbeat-behind-commit.mjs';
import { saturatedPool } from './races/saturated-pool.mjs';
import { queuedPastLease } from './races/queued-past-lease.mjs';
import { secondExecutorTakeover } from './races/second-executor-takeover.mjs';
import { vacuityAuthority } from './races/vacuity-authority.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(__dirname, '..', 'evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = join(evidenceDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

function record(row) {
  appendFileSync(evidenceFile, JSON.stringify(row) + '\n');
  const mark = row.pass === true ? 'PASS' : row.pass === false ? 'FAIL' : 'INVALID';
  console.log(`[${mark}] ${row.case} — ${JSON.stringify(row.detail)}`);
}

async function main() {
  console.log(`[run] IPC harness spike starting...`);
  console.log(`[run] Evidence will be written to: tools/spikes/ipc-harness/evidence/${basename(evidenceFile)}`);

  const cases = [
    ['b4-bounds', b4],
    ['b5-crash', b5],
    ['b2-fencing', b2],
    ['b6-mux-identity', () => b6()],
    ['b6-vacuity', () => b6({ stampIdentity: false, flood: false })],
    ['death-before-commit', deathBeforeCommit],
    ['lost-reply', lostReply],
    ['recovery-vs-live-commit', recoveryVsLiveCommit],
    ['healthy-long', healthyLong],
    ['heartbeat-behind-commit', heartbeatBehindCommit],
    ['saturated-pool', saturatedPool],
    ['queued-past-lease', queuedPastLease],
    ['second-executor-takeover', secondExecutorTakeover],
    ['vacuity-authority', vacuityAuthority],
    ['b1-throughput', b1],
    ['b3-backpressure', b3],
    ['smoke', smoke],
  ];
  let failed = false;
  let unscored = false;
  for (const [name, fn] of cases) {
    const result = await fn();
    const pass = name === 'b6-vacuity'
      ? result.pass === false && result.exploit === true && result.checks?.routing === true
        && result.checks?.mismatch === true && result.checks?.stale === true
      : name === 'vacuity-authority'
        ? result.pass === false && result.exploit === true && result.realHeld === true
        : result.pass;
    if (pass === false) failed = true;
    else if (pass !== true) unscored = true;
    record({
      case: name,
      pass,
      outcome: result.outcome ?? (pass === true ? 'pass' : pass === false ? 'fail' : 'invalid'),
      detail: result.detail ?? result,
    });
  }

  console.log(`[run] Spike complete. Evidence: tools/spikes/ipc-harness/evidence/${basename(evidenceFile)}`);
  process.exit(failed || unscored ? 1 : 0);
}

main().catch((e) => {
  console.error(`[run] fatal: ${e.stack}`);
  process.exit(1);
});
