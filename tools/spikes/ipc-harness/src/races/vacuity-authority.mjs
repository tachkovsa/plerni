// vacuity-authority (plan T5c): the same race without status='ACTIVE' rewrites
// a terminal row. The production predicate does not. The case returns pass
// false when that exploit lands; the runner scores the demonstration.

import { randomUUID } from 'node:crypto';
import {
  FencedError,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  sweepAbandoned,
} from '../authority.mjs';
import { countEffects, ensureEffects, expireHeartbeat, heldClock, insertEffect } from './support.mjs';

async function abandon(token) {
  const id = await createExecution('t5c-vacuity', token, true);
  await dispatch(id, true);
  await expireHeartbeat(id);
  const swept = await sweepAbandoned(true, { id });
  if (!swept.includes(id)) throw new Error('setup sweep missed the row');
  return id;
}

async function commitSettled(token) {
  const id = await createExecution('t5c-vacuity', token, true);
  await dispatch(id, true);
  await commitExecution(id, token, async (client) => {
    await insertEffect(client, id, 'kept');
  }, true, heldClock());
  await expireHeartbeat(id);
  return id;
}

export async function vacuityAuthority() {
  await ensureEffects();
  const heldToken = `held-${randomUUID()}`;
  const heldId = await abandon(heldToken);
  let heldFenced = false;
  try {
    await commitExecution(heldId, heldToken, async (client) => {
      await insertEffect(client, heldId, 'held');
    }, true, heldClock());
  } catch (err) {
    heldFenced = err instanceof FencedError;
    if (!heldFenced) throw err;
  }
  const heldStatus = (await getStatus(heldId, true))?.status ?? null;

  const openToken = `open-${randomUUID()}`;
  const openId = await abandon(openToken);
  let openCommitted = false;
  try {
    const result = await commitExecution(openId, openToken, async (client) => {
      await insertEffect(client, openId, 'rewritten');
    }, true, heldClock({ requireActive: false }));
    openCommitted = result.committed === true;
  } catch (err) {
    if (!(err instanceof FencedError)) throw err;
  }
  const openStatus = (await getStatus(openId, true))?.status ?? null;

  const safeId = await commitSettled(`safe-${randomUUID()}`);
  const safeSwept = await sweepAbandoned(true, { id: safeId });
  const safeStatus = (await getStatus(safeId, true))?.status ?? null;

  const openSweepId = await commitSettled(`sweep-${randomUUID()}`);
  const openSwept = await sweepAbandoned(true, { id: openSweepId, requireActive: false });
  const openSweepStatus = (await getStatus(openSweepId, true))?.status ?? null;

  const realHeld = heldFenced
    && heldStatus === 'ABANDONED'
    && await countEffects(heldId, 'held') === 0
    && safeSwept.includes(safeId) === false
    && safeStatus === 'COMMITTED';
  const exploit = openCommitted
    && openStatus === 'COMMITTED'
    && await countEffects(openId, 'rewritten') === 1
    && openSwept.includes(openSweepId)
    && openSweepStatus === 'ABANDONED';
  return {
    pass: false,
    exploit,
    realHeld,
    detail: { heldStatus, openStatus, safeStatus, openSweepStatus, realHeld, exploit },
  };
}
