// lost-reply (plan B2 / T5c): the commit succeeded and the reply was discarded.
// The retry reads the durable row. COMMITTED is reported as committed.
// It is never reported as cancelled. The retry's own effect does not land.
// Both commits are the production executor. quietRenew keeps a slow run from
// healing the row through the wall-clock cadence.

import { randomUUID } from 'node:crypto';
import { FencedError, commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { countEffects, ensureEffects, insertEffect, quietRenew } from './support.mjs';

function reportDurable(status) {
  if (status === 'COMMITTED') return 'committed';
  if (status === 'CANCELLED') return 'cancelled';
  return 'lost';
}

export async function lostReply() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const token = `lost-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-lost-reply', token, true), 'create');
  await timing.run(() => dispatch(id, true), 'dispatch');

  await timing.run(() => commitExecution(id, token, async (client) => {
    await insertEffect(client, id, 'durable');
  }, true, quietRenew()), 'durable commit');

  let fenced = false;
  try {
    await timing.run(() => commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'retry');
    }, true, quietRenew()), 'retry commit');
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }

  const status = (await timing.run(() => getStatus(id, true), 'status'))?.status ?? null;
  const reported = reportDurable(status);
  const detail = {
    id,
    fenced,
    status,
    reported,
    durableEffects: await timing.run(() => countEffects(id, 'durable'), 'durable effects'),
    retryEffects: await timing.run(() => countEffects(id, 'retry'), 'retry effects'),
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = fenced
    && reported === 'committed'
    && reported !== 'cancelled'
    && detail.durableEffects === 1
    && detail.retryEffects === 0;
  return { pass, detail };
}
