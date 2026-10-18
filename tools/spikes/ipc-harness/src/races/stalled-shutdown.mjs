// A shutdown that stops renewals and then waits longer than the cadence
// before the COMMITTED update. Production records that gap and sets
// boundViolation. The race oracle has to fail on that result.

import { randomUUID } from 'node:crypto';
import { commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { CADENCE_MS, isAborted } from './control.mjs';
import { commitMetrics, commitReportHeld } from './support.mjs';

const STALL_MS = CADENCE_MS + 1000;
const RENEWAL_LIMIT_MS = 15_000;
const STALL_BOUND_MS = RENEWAL_LIMIT_MS + STALL_MS + 5_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stalledShutdown() {
  const timing = steps();
  const token = `stall-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-stall', token, true), 'stall create');
  await timing.run(() => dispatch(id, true), 'stall dispatch');
  const initial = await timing.run(() => getStatus(id, true), 'stall heartbeat');
  const started = new Date(initial.heartbeat_at).getTime();
  const result = await timing.run(() => commitExecution(id, token, async () => {
    const opened = Date.now();
    for (;;) {
      if (isAborted()) throw new Error('aborted');
      const row = await getStatus(id, true);
      if (new Date(row.heartbeat_at).getTime() > started) return;
      if (Date.now() - opened > RENEWAL_LIMIT_MS) throw new Error('stalled setup missed the renewal');
      await sleep(200);
    }
  }, true, {
    beforeCommit: () => sleep(STALL_MS),
  }), 'stalled shutdown', STALL_BOUND_MS);

  const report = commitMetrics(result);
  const detail = {
    ...report,
    stallMs: STALL_MS,
    cadenceMs: CADENCE_MS,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: commitReportHeld(report), detail };
}
