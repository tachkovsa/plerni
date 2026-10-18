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
import { holdRow, settleAll } from './control.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, expireHeartbeat, insertEffect, quietRenew, waitForQueryLock } from './support.mjs';

const RACE_BOUND_MS = 15_000;

export function productionRecoveryAuthority() {
  return {
    name: 'production',
    commit(id, token, note) {
      return commitExecution(id, token, async (client) => {
        await insertEffect(client, id, note);
      }, true, quietRenew());
    },
    sweep() {
      return sweepAbandoned(true);
    },
  };
}

// Exactly one transition wins. The executor-first ordering keeps COMMITTED
// and its effect; the sweeper-first ordering keeps ABANDONED and zero effects.
export function recoveryRaceHeld(executor, sweeper) {
  return executor.committed === true
    && executor.fenced === false
    && executor.swept === false
    && executor.status === 'COMMITTED'
    && executor.effects === 1
    && sweeper.committed === false
    && sweeper.fenced === true
    && sweeper.swept === true
    && sweeper.status === 'ABANDONED'
    && sweeper.effects === 0;
}

async function executorWins(timing, authority) {
  const token = `${authority.name}-exec-${randomUUID()}`;
  const note = `${authority.name}-exec-wins`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), `${authority.name} executor create`);
  await timing.run(() => dispatch(id, true), `${authority.name} executor dispatch`);
  await timing.run(() => expireHeartbeat(id), `${authority.name} executor expire`);
  const barrier = await timing.run(() => holdRow(id), `${authority.name} executor barrier`);
  let commitP = Promise.resolve(null);
  let sweepP = Promise.resolve([]);
  try {
    commitP = authority.commit(id, token, note);
    commitP.catch(() => {});
    await timing.run(() => waitForQueryLock('COMMITTED', 8_000), `${authority.name} executor update queued`, 10_000);
    sweepP = authority.sweep(id);
    sweepP.catch(() => {});
    await timing.run(() => waitForQueryLock('ABANDONED', 8_000), `${authority.name} executor-first sweeper queued`, 10_000);
    await timing.run(() => barrier.release(), `${authority.name} executor release`);
    let report = commitMetrics(null);
    let fenced = false;
    try {
      report = commitMetrics(await timing.run(() => commitP, `${authority.name} executor-first commit`, RACE_BOUND_MS));
    } catch (err) {
      fenced = err instanceof FencedError;
      if (!fenced) throw err;
    }
    const swept = await timing.run(() => sweepP, `${authority.name} executor-first sweep`, RACE_BOUND_MS);
    return {
      ordering: 'executor-first',
      ...report,
      fenced,
      swept: swept.includes(id),
      status: (await timing.run(() => getStatus(id, true), `${authority.name} executor status`))?.status ?? null,
      effects: await timing.run(() => countEffects(id, note), `${authority.name} executor effects`),
    };
  } finally {
    await barrier.release().catch(() => {});
    await settleAll([
      ['recovery commit', commitP],
      ['recovery sweep', sweepP],
    ]);
  }
}

async function sweeperWins(timing, authority) {
  const token = `${authority.name}-sweep-${randomUUID()}`;
  const note = `${authority.name}-sweep-wins`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), `${authority.name} sweeper create`);
  await timing.run(() => dispatch(id, true), `${authority.name} sweeper dispatch`);
  await timing.run(() => expireHeartbeat(id), `${authority.name} sweeper expire`);
  const barrier = await timing.run(() => holdRow(id), `${authority.name} sweeper barrier`);
  let commitP = Promise.resolve(null);
  let sweepP = Promise.resolve([]);
  try {
    sweepP = authority.sweep(id);
    sweepP.catch(() => {});
    await timing.run(() => waitForQueryLock('ABANDONED', 8_000), `${authority.name} sweeper update queued`, 10_000);
    commitP = authority.commit(id, token, note);
    commitP.catch(() => {});
    await timing.run(() => waitForQueryLock('COMMITTED', 8_000), `${authority.name} sweeper-first executor queued`, 10_000);
    await timing.run(() => barrier.release(), `${authority.name} sweeper release`);
    const sweptIds = await timing.run(() => sweepP, `${authority.name} sweeper-first sweep`, RACE_BOUND_MS);
    let report = commitMetrics(null);
    let fenced = false;
    try {
      report = commitMetrics(await timing.run(() => commitP, `${authority.name} sweeper-first commit`, RACE_BOUND_MS));
    } catch (err) {
      fenced = err instanceof FencedError;
      if (!fenced) throw err;
    }
    return {
      ordering: 'sweeper-first',
      ...report,
      fenced,
      swept: sweptIds.includes(id),
      status: (await timing.run(() => getStatus(id, true), `${authority.name} sweeper status`))?.status ?? null,
      effects: await timing.run(() => countEffects(id, note), `${authority.name} sweeper effects`),
    };
  } finally {
    await barrier.release().catch(() => {});
    await settleAll([
      ['recovery commit', commitP],
      ['recovery sweep', sweepP],
    ]);
  }
}

export async function runRecoveryRace(authority) {
  const timing = steps();
  await timing.run(() => ensureEffects(), `${authority.name} effects fixture`);
  const executor = await executorWins(timing, authority);
  const sweeper = await sweeperWins(timing, authority);
  const detail = { executor, sweeper, bounds: timing.bounds };
  assertBounds(detail.bounds);
  return { pass: recoveryRaceHeld(executor, sweeper), detail };
}

export async function recoveryVsLiveCommit() {
  const raced = await runRecoveryRace(productionRecoveryAuthority());
  return {
    pass: raced.pass && commitReportHeld(raced.detail.executor),
    detail: raced.detail,
  };
}
