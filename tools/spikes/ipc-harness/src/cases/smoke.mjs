// smoke.mjs — Smoke test: round-trip over stdio framing + authority transitions on harness PG.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NdjsonFramer, encodeNdjson } from '../framing.mjs';
import {
  createExecution,
  dispatch,
  commitExecution,
  cancelExecution,
  getStatus,
  startSweeper,
  sweepAbandoned,
} from '../authority.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const echoPath = join(__dirname, '../children/echo.mjs');

export async function smoke() {
  const evidence = { pass: true, detail: {} };
  // Use direct connection fallback until PgBouncer auth_query issue is resolved
  const useDirect = true;

  // ================
  // Part 1: Framing
  // ================
  const child = spawn('node', [echoPath]);
  const framer = new NdjsonFramer();
  const received = [];

  child.stdout.on('data', (chunk) => {
    framer.feed(chunk.toString('utf8'));
    for (const msg of framer.frames()) {
      received.push(msg);
    }
  });

  const sent = [
    { id: 1, text: 'hello' },
    { id: 2, text: 'world' },
  ];

  for (const msg of sent) {
    child.stdin.write(encodeNdjson(msg));
  }

  child.stdin.end();

  await new Promise((resolve) => child.on('close', resolve));

  const expectedEcho = sent.map((m) => ({ ...m, echoed: true }));
  if (JSON.stringify(received) !== JSON.stringify(expectedEcho)) {
    evidence.pass = false;
    evidence.detail.framing = { sent, received, expected: expectedEcho };
  } else {
    evidence.detail.framing = 'PASS';
  }

  // ==================
  // Part 2: Authority - Basic lifecycle
  // ==================
  const stopSweeper = startSweeper(useDirect);

  try {
    // Case 1: Fast commit (no renewals)
    const id1 = await createExecution('test-plugin', 'token-1', useDirect);
    let status = await getStatus(id1, useDirect);
    if (status.status !== 'QUEUED') {
      evidence.pass = false;
      evidence.detail.authority_queued = { expected: 'QUEUED', got: status.status };
    }

    await dispatch(id1, useDirect);
    status = await getStatus(id1, useDirect);
    if (status.status !== 'ACTIVE' || !status.heartbeat_at) {
      evidence.pass = false;
      evidence.detail.authority_active = { expected: 'ACTIVE', got: status };
    }

    const commitResult1 = await commitExecution(id1, 'token-1', async (c) => {
      await c.query('SELECT pg_sleep(0.5)');
    }, useDirect);
    if (!commitResult1.committed) {
      evidence.pass = false;
      evidence.detail.authority_commit_fast = { expected: 'committed', got: commitResult1 };
    }
    status = await getStatus(id1, useDirect);
    if (status.status !== 'COMMITTED') {
      evidence.pass = false;
      evidence.detail.authority_committed_fast = { expected: 'COMMITTED', got: status.status };
    }

    // Case 2: Long commit with multiple renewals (12s > 2× cadence of 5s)
    console.log('[smoke] starting long execution (12s) to exercise renewals...');
    const id4 = await createExecution('test-plugin', 'token-4', useDirect);
    await dispatch(id4, useDirect);
    const commitResult4 = await commitExecution(id4, 'token-4', async (c) => {
      await c.query('SELECT pg_sleep(12)');
    }, useDirect);
    if (!commitResult4.committed) {
      evidence.pass = false;
      evidence.detail.authority_commit_long = { expected: 'committed', got: commitResult4 };
    }
    if (commitResult4.boundViolation) {
      evidence.pass = false;
      evidence.detail.authority_bound_violation_long = {
        lastRenewalToLockMs: commitResult4.lastRenewalToLockMs,
        bound: commitResult4.bound,
      };
    }
    status = await getStatus(id4, useDirect);
    if (status.status !== 'COMMITTED') {
      evidence.pass = false;
      evidence.detail.authority_committed_long = { expected: 'COMMITTED', got: status.status };
    }
    evidence.detail.authority_metrics_long = {
      renewals: commitResult4.renewals,
      lastRenewalToLockMs: commitResult4.lastRenewalToLockMs,
      bound: commitResult4.bound,
      effectsDuration: '12s',
    };

    // Case 3: Very long commit with renewal in-flight when lock acquired (16s > 3× cadence)
    console.log('[smoke] starting very long execution (16s) to test in-flight renewal...');
    const id5 = await createExecution('test-plugin', 'token-5', useDirect);
    await dispatch(id5, useDirect);
    const commitResult5 = await commitExecution(id5, 'token-5', async (c) => {
      await c.query('SELECT pg_sleep(16)');
    }, useDirect);
    if (!commitResult5.committed) {
      evidence.pass = false;
      evidence.detail.authority_commit_verylong = { expected: 'committed', got: commitResult5 };
    }
    if (commitResult5.boundViolation) {
      evidence.pass = false;
      evidence.detail.authority_bound_violation_verylong = {
        lastRenewalToLockMs: commitResult5.lastRenewalToLockMs,
        bound: commitResult5.bound,
      };
    }
    status = await getStatus(id5, useDirect);
    if (status.status !== 'COMMITTED') {
      evidence.pass = false;
      evidence.detail.authority_committed_verylong = { expected: 'COMMITTED', got: status.status };
    }
    evidence.detail.authority_metrics_verylong = {
      renewals: commitResult5.renewals,
      lastRenewalToLockMs: commitResult5.lastRenewalToLockMs,
      bound: commitResult5.bound,
      effectsDuration: '16s',
    };

    // Case 4: Cancellation path
    const id2 = await createExecution('test-plugin', 'token-2', useDirect);
    await dispatch(id2, useDirect);
    const cancelled = await cancelExecution(id2, useDirect);
    if (!cancelled) {
      evidence.pass = false;
      evidence.detail.authority_cancel = { expected: true, got: cancelled };
    }
    status = await getStatus(id2, useDirect);
    if (status.status !== 'CANCELLED') {
      evidence.pass = false;
      evidence.detail.authority_cancelled = { expected: 'CANCELLED', got: status.status };
    }

    // Case 5: Sweeper abandonment (create ACTIVE, wait for lease expiry)
    const id3 = await createExecution('test-plugin', 'token-3', useDirect);
    await dispatch(id3, useDirect);
    const statusBefore = await getStatus(id3, useDirect);
    console.log('[smoke] waiting 22s for lease expiry (lease=20s)...');
    await new Promise((resolve) => setTimeout(resolve, 22000));
    // Trigger manual sweep to ensure it processes
    await sweepAbandoned(useDirect);
    status = await getStatus(id3, useDirect);
    if (status.status !== 'ABANDONED') {
      evidence.pass = false;
      evidence.detail.authority_abandoned = {
        expected: 'ABANDONED',
        got: status.status,
        heartbeat_at: status.heartbeat_at,
        created_at: status.created_at,
        statusBefore: statusBefore.status,
      };
    }

    if (evidence.pass) {
      evidence.detail.authority = 'PASS';
    }
  } finally {
    stopSweeper();
  }

  return evidence;
}
