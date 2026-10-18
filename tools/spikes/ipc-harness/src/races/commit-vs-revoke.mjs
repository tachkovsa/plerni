// commit-vs-revoke: the executor holds the fencing row with SELECT FOR UPDATE
// inside the effects transaction, and the revoker issues CANCELLED on a second
// pooled connection. The revoker waits on Lock / transactionid. The executor
// already holds the lock, so the commit wins and the cancel loses. No deadlock.

import { randomUUID } from 'node:crypto';
import {
  FencedError,
  cancelExecution,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
} from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { endClient, isAborted, openAppClient, queryWithin } from './control.mjs';

const USE_DIRECT = false;
const RACE_BOUND_MS = 15_000;

async function waitForCancelLock(deadlineMs = 8_000) {
  const client = openAppClient('direct');
  await client.connect();
  const started = Date.now();
  try {
    while (Date.now() - started < deadlineMs) {
      if (isAborted()) throw new Error('aborted');
      const found = await queryWithin(
        client,
        `SELECT wait_event
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%CANCELLED%'`,
      );
      if (found.rowCount > 0) return found.rows[0].wait_event;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('deadline: revoker did not wait on the row lock');
  } finally {
    await endClient(client);
  }
}

// The executor acquired the row lock before the revoker started, so the
// commit is the only accepted winner. A cancel that wins means the effects
// transaction did not keep the lock it had already shown as held.
export function overlapHeld(row) {
  return row.revokerWaitedOnLock === true
    && row.waitEvent === 'transactionid'
    && row.commit === true
    && row.fenced === false
    && row.cancelWon === false
    && row.status === 'COMMITTED';
}

export async function commitVsRevoke() {
  const timing = steps();
  const token = `overlap-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-overlap', token, USE_DIRECT), 'create');
  await timing.run(() => dispatch(id, USE_DIRECT), 'dispatch');
  let cancelWon = null;
  let waitEvent = null;
  let cancelP = null;
  let commit = false;
  let fenced = false;
  let commitError = null;
  try {
    await timing.run(() => commitExecution(id, token, async (client) => {
      await client.query('SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE', [id]);
      cancelP = cancelExecution(id, USE_DIRECT);
      cancelP.catch(() => {});
      waitEvent = await waitForCancelLock();
    }, USE_DIRECT), 'overlap commit', RACE_BOUND_MS);
    commit = true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) commitError = err;
  } finally {
    if (cancelP) cancelWon = await timing.run(() => cancelP, 'revoker settled', RACE_BOUND_MS);
  }
  if (commitError) throw commitError;
  const status = await timing.run(() => getStatus(id, USE_DIRECT), 'status');
  const detail = {
    commit,
    fenced,
    cancelWon,
    status: status?.status ?? null,
    revokerWaitedOnLock: waitEvent != null,
    waitEvent,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: overlapHeld(detail), detail };
}

// Cancel finishes before the executor starts. The overlap oracle requires the
// commit to win after a lock wait, so this run fails it. The cancel is the
// outcome of this run.
export async function commitVsRevokeVacuity() {
  const timing = steps();
  const token = `overlap-open-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-overlap-open', token, USE_DIRECT), 'create');
  await timing.run(() => dispatch(id, USE_DIRECT), 'dispatch');
  const cancelWon = await timing.run(() => cancelExecution(id, USE_DIRECT), 'cancel first');
  let commit = false;
  let fenced = false;
  try {
    await timing.run(
      () => commitExecution(id, token, async () => {}, USE_DIRECT),
      'commit after cancel',
    );
    commit = true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }
  const status = await timing.run(() => getStatus(id, USE_DIRECT), 'status');
  const detail = {
    commit,
    fenced,
    cancelWon,
    status: status?.status ?? null,
    revokerWaitedOnLock: false,
    waitEvent: null,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: overlapHeld(detail), detail };
}
