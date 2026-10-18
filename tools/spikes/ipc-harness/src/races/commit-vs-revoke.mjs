// commit-vs-revoke: the executor holds the fencing row with SELECT FOR UPDATE
// inside the effects transaction, and the revoker issues CANCELLED on a second
// pooled connection. The revoker waits on Lock / transactionid. Releasing the
// transaction lets exactly one status transition win. No deadlock.

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

export function overlapHeld(row) {
  const commitWon = row.commit === true && row.cancelWon === false && row.status === 'COMMITTED';
  const cancelWon = row.commit === false && row.cancelWon === true && row.fenced === true && row.status === 'CANCELLED';
  return row.revokerWaitedOnLock === true
    && row.waitEvent === 'transactionid'
    && row.winners === 1
    && (commitWon || cancelWon);
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
  try {
    await timing.run(() => commitExecution(id, token, async (client) => {
      await client.query('SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE', [id]);
      cancelP = cancelExecution(id, USE_DIRECT).then((won) => {
        cancelWon = won;
        return won;
      });
      cancelP.catch(() => {});
      waitEvent = await waitForCancelLock();
    }, USE_DIRECT), 'overlap commit', 15_000);
    commit = true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }
  if (cancelP) await cancelP;
  const status = await timing.run(() => getStatus(id, USE_DIRECT), 'status');
  const detail = {
    commit,
    fenced,
    cancelWon,
    status: status?.status ?? null,
    revokerWaitedOnLock: waitEvent != null,
    waitEvent,
    winners: Number(commit) + Number(cancelWon === true),
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: overlapHeld(detail), detail };
}

// The same oracle, with the cancel finished before the executor starts.
// Nothing waits on the row lock, so a passing overlap result cannot be this run.
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
    winners: Number(commit) + Number(cancelWon === true),
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: overlapHeld(detail), detail };
}
