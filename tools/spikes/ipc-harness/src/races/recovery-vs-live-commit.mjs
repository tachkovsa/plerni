// recovery-vs-live-commit (plan B2 / T5c): the sweeper and the executor race
// on one ACTIVE row whose lease is already expired. PostgreSQL READ COMMITTED
// waits on the row lock and rechecks the status predicate, so exactly one
// transition wins. Both orderings are forced with barriers.
// The executor update and the sweeper update are the production statements
// (the harness adds only a comment tag and, for the sweep, the row id).
// https://www.postgresql.org/docs/18/transaction-iso.html

import { randomUUID } from 'node:crypto';
import { FencedError, createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { raceCommit, raceSweep } from './control.mjs';
import { countEffects, ensureEffects, expireHeartbeat, heldClock, insertEffect, waitForQueryLock } from './support.mjs';

const RACE_BOUND_MS = 15000;
const BARRIER_MS = 4000;

async function executorWins(timing) {
  const token = `exec-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), 'executor create');
  await timing.run(() => dispatch(id, true), 'executor dispatch');
  await timing.run(() => expireHeartbeat(id), 'executor expire');
  let sweepP = Promise.resolve({ ids: [] });
  let committed = false;
  let fenced = false;
  try {
    const result = await raceCommit(id, token, async (client) => {
      await insertEffect(client, id, 'exec-wins');
    }, true, {
      ...heldClock(),
      tag: 'race-exec-live',
      label: 'executor-first commit',
      bounds: timing.bounds,
      boundMs: RACE_BOUND_MS,
      afterLock: async () => {
        sweepP = raceSweep(true, {
          id,
          tag: 'race-sweep-live',
          label: 'executor-first sweep',
          bounds: timing.bounds,
          boundMs: RACE_BOUND_MS,
        });
        await waitForQueryLock('race-sweep-live', BARRIER_MS);
      },
    });
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) {
      await sweepP.catch(() => {});
      throw err;
    }
  }
  const swept = await sweepP;
  return {
    ordering: 'executor-first',
    committed,
    fenced,
    swept: swept.ids.includes(id),
    status: (await timing.run(() => getStatus(id, true), 'executor status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'exec-wins'), 'executor effects'),
  };
}

async function sweeperWins(timing) {
  const token = `sweep-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-recovery', token, true), 'sweeper create');
  await timing.run(() => dispatch(id, true), 'sweeper dispatch');
  await timing.run(() => expireHeartbeat(id), 'sweeper expire');
  let sweepP = Promise.resolve({ ids: [] });
  let committed = false;
  let fenced = false;
  let releaseLock;
  const locked = new Promise((resolve, reject) => {
    releaseLock = { resolve, reject };
  });
  try {
    const result = await raceCommit(id, token, async (client) => {
      await insertEffect(client, id, 'sweep-wins');
    }, true, {
      ...heldClock(),
      tag: 'race-exec-sweep',
      label: 'sweeper-first commit',
      bounds: timing.bounds,
      boundMs: RACE_BOUND_MS,
      beforeCommit: async () => {
        sweepP = raceSweep(true, {
          id,
          tag: 'race-sweep-hold',
          label: 'sweeper-first sweep',
          bounds: timing.bounds,
          boundMs: RACE_BOUND_MS,
          afterLock: async () => {
            releaseLock.resolve();
            await waitForQueryLock('race-exec-sweep', BARRIER_MS);
          },
        }).catch((err) => {
          releaseLock.reject(err);
          throw err;
        });
        await timing.run(() => locked, 'sweeper locked the row', BARRIER_MS);
      },
    });
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) {
      await sweepP.catch(() => {});
      throw err;
    }
  }
  const swept = await sweepP;
  return {
    ordering: 'sweeper-first',
    committed,
    fenced,
    swept: swept.ids.includes(id),
    status: (await timing.run(() => getStatus(id, true), 'sweeper status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'sweep-wins'), 'sweeper effects'),
  };
}

export async function recoveryVsLiveCommit() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const executor = await executorWins(timing);
  const sweeper = await sweeperWins(timing);
  const detail = { executor, sweeper, bounds: timing.bounds };
  assertBounds(detail.bounds);
  const pass = executor.committed === true
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
