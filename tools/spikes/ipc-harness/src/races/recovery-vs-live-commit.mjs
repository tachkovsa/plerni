// recovery-vs-live-commit (plan B2 / T5c): the sweeper and the executor race
// on one ACTIVE row whose lease is already expired. PostgreSQL READ COMMITTED
// waits on the row lock and rechecks the status predicate, so exactly one
// transition wins. Both orderings are forced with barriers.
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
import { deferred, withDeadline } from './clock.mjs';
import { countEffects, ensureEffects, expireHeartbeat, heldClock, insertEffect, waitForQueryLock } from './support.mjs';

async function executorWins() {
  const token = `exec-${randomUUID()}`;
  const id = await createExecution('t5c-recovery', token, true);
  await dispatch(id, true);
  await expireHeartbeat(id);
  let sweepP;
  let committed = false;
  let fenced = false;
  try {
    const result = await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'exec-wins');
    }, true, {
      ...heldClock(),
      tag: 'race-exec-live',
      afterLock: async () => {
        sweepP = sweepAbandoned(true, { id, tag: 'race-sweep-live' });
        await waitForQueryLock('race-sweep-live');
      },
    });
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (sweepP) await sweepP.catch(() => {});
    if (!fenced) throw err;
  }
  const swept = sweepP ? await sweepP : [];
  return {
    ordering: 'executor-first',
    committed,
    fenced,
    swept: swept.includes(id),
    status: (await getStatus(id, true))?.status ?? null,
    effects: await countEffects(id, 'exec-wins'),
  };
}

async function sweeperWins() {
  const token = `sweep-${randomUUID()}`;
  const id = await createExecution('t5c-recovery', token, true);
  await dispatch(id, true);
  await expireHeartbeat(id);
  const locked = deferred();
  let sweepP;
  let committed = false;
  let fenced = false;
  try {
    const result = await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'sweep-wins');
    }, true, {
      ...heldClock(),
      tag: 'race-exec-sweep',
      beforeCommit: async () => {
        sweepP = sweepAbandoned(true, {
          id,
          tag: 'race-sweep-hold',
          afterLock: async () => {
            locked.resolve();
            await waitForQueryLock('race-exec-sweep');
          },
        }).catch((err) => {
          locked.reject(err);
          throw err;
        });
        await withDeadline(locked.promise, 5000, 'sweeper did not lock');
      },
    });
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (sweepP) await sweepP.catch(() => {});
    if (!fenced) throw err;
  }
  const swept = sweepP ? await sweepP : [];
  return {
    ordering: 'sweeper-first',
    committed,
    fenced,
    swept: swept.includes(id),
    status: (await getStatus(id, true))?.status ?? null,
    effects: await countEffects(id, 'sweep-wins'),
  };
}

export async function recoveryVsLiveCommit() {
  await ensureEffects();
  const executor = await executorWins();
  const sweeper = await sweeperWins();
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
  return { pass, detail: { executor, sweeper } };
}
