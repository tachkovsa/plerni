// vacuity-authority (plan T5c): the same race without status='ACTIVE' rewrites
// a terminal row. The production predicate does not. The open predicate lives
// in the race harness. The case returns pass false when that exploit lands;
// the runner scores the demonstration.

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
import { vacuousCommit, vacuousSweep } from './control.mjs';
import { countEffects, ensureEffects, expireHeartbeat, insertEffect, quietRenew } from './support.mjs';

async function abandon(token, timing) {
  const id = await timing.run(() => createExecution('t5c-vacuity', token, true), `abandon ${token} create`);
  await timing.run(() => dispatch(id, true), `abandon ${token} dispatch`);
  await timing.run(() => expireHeartbeat(id), `abandon ${token} expire`);
  const swept = await timing.run(() => sweepAbandoned(true), `abandon ${token} sweep`);
  if (!swept.includes(id)) throw new Error('setup sweep missed the row');
  return id;
}

async function commitSettled(token, timing) {
  const id = await timing.run(() => createExecution('t5c-vacuity', token, true), `settle ${token} create`);
  await timing.run(() => dispatch(id, true), `settle ${token} dispatch`);
  await timing.run(() => commitExecution(id, token, async (client) => {
    await insertEffect(client, id, 'kept');
  }, true, quietRenew()), `settle ${token} commit`);
  await timing.run(() => expireHeartbeat(id), `settle ${token} expire`);
  return id;
}

export async function vacuityAuthority() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const heldToken = `held-${randomUUID()}`;
  const heldId = await abandon(heldToken, timing);
  let heldFenced = false;
  try {
    await timing.run(() => commitExecution(heldId, heldToken, async (client) => {
      await insertEffect(client, heldId, 'held');
    }, true, quietRenew()), 'production commit on abandoned');
  } catch (err) {
    heldFenced = err instanceof FencedError;
    if (!heldFenced) throw err;
  }
  const heldStatus = (await timing.run(() => getStatus(heldId, true), 'held status'))?.status ?? null;

  const openToken = `open-${randomUUID()}`;
  const openId = await abandon(openToken, timing);
  let openCommitted = false;
  try {
    const result = await timing.run(() => vacuousCommit(openId, openToken, async (client) => {
      await insertEffect(client, openId, 'rewritten');
    }), 'vacuous commit');
    openCommitted = result.committed === true;
  } catch (err) {
    if (!(err instanceof FencedError)) throw err;
  }
  const openStatus = (await timing.run(() => getStatus(openId, true), 'open status'))?.status ?? null;

  const safeId = await commitSettled(`safe-${randomUUID()}`, timing);
  const safeSwept = await timing.run(() => sweepAbandoned(true), 'production sweep of committed');
  const safeStatus = (await timing.run(() => getStatus(safeId, true), 'safe status'))?.status ?? null;

  const openSweepId = await commitSettled(`sweep-${randomUUID()}`, timing);
  const openSwept = await timing.run(() => vacuousSweep(openSweepId), 'vacuous sweep');
  const openSweepStatus = (await timing.run(() => getStatus(openSweepId, true), 'open sweep status'))?.status ?? null;

  const heldEffects = await timing.run(() => countEffects(heldId, 'held'), 'held effects');
  const rewrittenEffects = await timing.run(() => countEffects(openId, 'rewritten'), 'rewritten effects');
  const realHeld = heldFenced
    && heldStatus === 'ABANDONED'
    && heldEffects === 0
    && safeSwept.includes(safeId) === false
    && safeStatus === 'COMMITTED';
  const exploit = openCommitted
    && openStatus === 'COMMITTED'
    && rewrittenEffects === 1
    && openSwept.includes(openSweepId)
    && openSweepStatus === 'ABANDONED';
  const detail = {
    heldStatus,
    openStatus,
    safeStatus,
    openSweepStatus,
    realHeld,
    exploit,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  return { pass: false, exploit, realHeld, detail };
}
