// lost-reply (plan B2 / T5c): the commit succeeded and the reply was discarded.
// The retry reads the durable row. COMMITTED is reported as committed.
// It is never reported as cancelled. The retry's own effect does not land.

import { randomUUID } from 'node:crypto';
import { FencedError, commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { countEffects, ensureEffects, heldClock, insertEffect } from './support.mjs';

function reportDurable(status) {
  if (status === 'COMMITTED') return 'committed';
  if (status === 'CANCELLED') return 'cancelled';
  return 'lost';
}

export async function lostReply() {
  await ensureEffects();
  const token = `lost-${randomUUID()}`;
  const id = await createExecution('t5c-lost-reply', token, true);
  await dispatch(id, true);

  await commitExecution(id, token, async (client) => {
    await insertEffect(client, id, 'durable');
  }, true, heldClock());
  // The caller never observes that return value.

  let fenced = false;
  try {
    await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'retry');
    }, true, heldClock());
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }

  const status = (await getStatus(id, true))?.status ?? null;
  const reported = reportDurable(status);
  const detail = {
    id,
    fenced,
    status,
    reported,
    durableEffects: await countEffects(id, 'durable'),
    retryEffects: await countEffects(id, 'retry'),
  };
  const pass = fenced
    && reported === 'committed'
    && reported !== 'cancelled'
    && detail.durableEffects === 1
    && detail.retryEffects === 0;
  return { pass, detail };
}
