// recovery-vs-live-commit (plan B2 / T5c): the production sweeper and the
// production executor race on one ACTIVE row whose lease is already expired.
// A third session holds the row with SELECT FOR UPDATE. Each production
// statement queues on that lock. PostgreSQL grants the same lock mode to the
// waiter that has waited longest, then READ COMMITTED rechecks the status
// predicate, so exactly one transition wins.
// https://www.postgresql.org/docs/18/explicit-locking.html
// https://www.postgresql.org/docs/18/transaction-iso.html

import { randomUUID } from 'node:crypto';
import {
  FencedError,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  sweepAbandoned,
} from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { holdRow } from './control.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, expireHeartbeat, insertEffect, quietRenew, waitForQueryLock } from './support.mjs';

const RACE_BOUND_MS = 15_000;

async function executorWins(timing) {
  const token = `exec-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), 'executor create');
  await timing.run(() => dispatch(id, true), 'executor dispatch');
  await timing.run(() => expireHeartbeat(id), 'executor expire');
  const barrier = await timing.run(() => holdRow(id), 'executor barrier');
  let commitP = Promise.resolve(null);
  let sweepP = Promise.resolve([]);
  try {
    commitP = commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'exec-wins');
    }, true, quietRenew());
    commitP.catch(() => {});
    await timing.run(() => waitForQueryLock('COMMITTED', 8_000), 'executor update queued', 10_000);
    sweepP = sweepAbandoned(true);
    sweepP.catch(() => {});
    await timing.run(() => waitForQueryLock('ABANDONED', 8_000), 'executor-first sweeper queued', 10_000);
    await timing.run(() => barrier.release(), 'executor release');
    let report = commitMetrics(null);
    let fenced = false;
    try {
      report = commitMetrics(await timing.run(() => commitP, 'executor-first commit', RACE_BOUND_MS));
    } catch (err) {
      fenced = err instanceof FencedError;
      if (!fenced) throw err;
    }
    const swept = await timing.run(() => sweepP, 'executor-first sweep', RACE_BOUND_MS);
    return {
      ordering: 'executor-first',
      ...report,
      fenced,
      swept: swept.includes(id),
      status: (await timing.run(() => getStatus(id, true), 'executor status'))?.status ?? null,
      effects: await timing.run(() => countEffects(id, 'exec-wins'), 'executor effects'),
    };
  } finally {
    await barrier.release().catch(() => {});
    await Promise.allSettled([commitP, sweepP]);
  }
}

async function sweeperWins(timing) {
  const token = `sweep-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), 'sweeper create');
  await timing.run(() => dispatch(id, true), 'sweeper dispatch');
  await timing.run(() => expireHeartbeat(id), 'sweeper expire');
  const barrier = await timing.run(() => holdRow(id), 'sweeper barrier');
  let commitP = Promise.resolve(null);
  let sweepP = Promise.resolve([]);
  try {
    sweepP = sweepAbandoned(true);
    sweepP.catch(() => {});
    await timing.run(() => waitForQueryLock('ABANDONED', 8_000), 'sweeper update queued', 10_000);
    commitP = commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'sweep-wins');
    }, true, quietRenew());
    commitP.catch(() => {});
    await timing.run(() => waitForQueryLock('COMMITTED', 8_000), 'sweeper-first executor queued', 10_000);
    await timing.run(() => barrier.release(), 'sweeper release');
    const swept = await timing.run(() => sweepP, 'sweeper-first sweep', RACE_BOUND_MS);
    let committed = false;
    let fenced = false;
    try {
      const result = await timing.run(() => commitP, 'sweeper-first commit', RACE_BOUND_MS);
      committed = result?.committed === true;
    } catch (err) {
      fenced = err instanceof FencedError;
      if (!fenced) throw err;
    }
    return {
      ordering: 'sweeper-first',
      committed,
      fenced,
      swept: swept.includes(id),
      status: (await timing.run(() => getStatus(id, true), 'sweeper status'))?.status ?? null,
      effects: await timing.run(() => countEffects(id, 'sweep-wins'), 'sweeper effects'),
    };
  } finally {
    await barrier.release().catch(() => {});
    await Promise.allSettled([commitP, sweepP]);
  }
}

export async function recoveryVsLiveCommit() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const executor = await executorWins(timing);
  const sweeper = await sweeperWins(timing);
  const detail = { executor, sweeper, bounds: timing.bounds };
  assertBounds(detail.bounds);
  const pass = commitReportHeld(executor)
    && executor.fenced === false
    && executor.swept === false
    && executor.status === 'COMMITTED'
    && executor.effects === 1
    && sweeper.committed === false
    && sweeper.fenced === true
    && sweeper.swept === true
    && sweeper.status === 'ABANDONED'
    && sweeper.effects === 0;
  return { pass, detail };
}
