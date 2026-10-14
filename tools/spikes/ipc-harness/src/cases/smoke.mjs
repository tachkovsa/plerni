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
} from '../authority.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const echoPath = join(__dirname, '../children/echo.mjs');

export async function smoke() {
  const evidence = { pass: true, detail: {} };

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
  // Part 2: Authority
  // ==================
  const stopSweeper = startSweeper();

  try {
    // Create QUEUED
    const id1 = await createExecution('test-plugin', 'token-1');
    let status = await getStatus(id1);
    if (status.status !== 'QUEUED') {
      evidence.pass = false;
      evidence.detail.authority_queued = { expected: 'QUEUED', got: status.status };
    }

    // Dispatch QUEUED→ACTIVE
    await dispatch(id1);
    status = await getStatus(id1);
    if (status.status !== 'ACTIVE' || !status.heartbeat_at) {
      evidence.pass = false;
      evidence.detail.authority_active = { expected: 'ACTIVE', got: status };
    }

    // Commit ACTIVE→COMMITTED
    const commitResult = await commitExecution(id1, 'token-1', async (c) => {
      // Simulate effects
      await c.query('SELECT pg_sleep(0.5)');
    });
    if (!commitResult.committed) {
      evidence.pass = false;
      evidence.detail.authority_commit = { expected: 'committed', got: commitResult };
    }
    // Check bound assertion
    if (commitResult.boundViolation) {
      evidence.pass = false;
      evidence.detail.authority_bound_violation = {
        lastRenewalToLockMs: commitResult.lastRenewalToLockMs,
        bound: commitResult.bound,
      };
    }
    status = await getStatus(id1);
    if (status.status !== 'COMMITTED') {
      evidence.pass = false;
      evidence.detail.authority_committed = { expected: 'COMMITTED', got: status.status };
    }
    evidence.detail.authority_metrics = {
      renewals: commitResult.renewals,
      lastRenewalToLockMs: commitResult.lastRenewalToLockMs,
      bound: commitResult.bound,
    };

    // Test cancellation path
    const id2 = await createExecution('test-plugin', 'token-2');
    await dispatch(id2);
    const cancelled = await cancelExecution(id2);
    if (!cancelled) {
      evidence.pass = false;
      evidence.detail.authority_cancel = { expected: true, got: cancelled };
    }
    status = await getStatus(id2);
    if (status.status !== 'CANCELLED') {
      evidence.pass = false;
      evidence.detail.authority_cancelled = { expected: 'CANCELLED', got: status.status };
    }

    // Test sweeper abandonment (create ACTIVE, wait for lease expiry)
    const id3 = await createExecution('test-plugin', 'token-3');
    await dispatch(id3);
    // Wait for lease to expire (20s + margin)
    console.log('[smoke] waiting 22s for lease expiry...');
    await new Promise((resolve) => setTimeout(resolve, 22000));
    status = await getStatus(id3);
    if (status.status !== 'ABANDONED') {
      evidence.pass = false;
      evidence.detail.authority_abandoned = { expected: 'ABANDONED', got: status.status };
    }

    if (evidence.pass) {
      evidence.detail.authority = 'PASS';
    }
  } finally {
    stopSweeper();
  }

  return evidence;
}
