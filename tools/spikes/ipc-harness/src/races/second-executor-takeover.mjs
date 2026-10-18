// second-executor-takeover (plan B2 / §11.11): after the row is terminal, a
// second executor holding the stale token issues the production conditional
// COMMITTED update. Zero rows, FENCED, and the takeover effect is absent on an
// independent connection. Covers COMMITTED, CANCELLED, and ABANDONED.

import { randomUUID } from 'node:crypto';
import {
  FencedError,
  cancelExecution,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  sweepAbandoned,
} from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, expireHeartbeat, insertEffect, quietRenew } from './support.mjs';

async function settle(kind, id, token, timing) {
  if (kind === 'COMMITTED') {
    return commitMetrics(await timing.run(() => commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'settled');
    }, true, quietRenew()), `${kind} settle`));
  }
  if (kind === 'CANCELLED') {
    const won = await timing.run(() => cancelExecution(id, true), `${kind} cancel`);
    if (!won) throw new Error('cancel did not win');
    return null;
  }
  await timing.run(() => expireHeartbeat(id), `${kind} expire`);
  const swept = await timing.run(() => sweepAbandoned(true), `${kind} sweep`);
  if (!swept.includes(id)) throw new Error('sweeper did not abandon the settled row');
  return null;
}

async function one(kind, timing) {
  const token = `stale-${kind}-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-takeover', token, true), `${kind} create`);
  await timing.run(() => dispatch(id, true), `${kind} dispatch`);
  const settled = await settle(kind, id, token, timing);
  let fenced = false;
  try {
    await timing.run(() => commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'takeover');
    }, true, quietRenew()), `${kind} takeover`);
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }
  return {
    kind,
    fenced,
    status: (await timing.run(() => getStatus(id, true), `${kind} status`))?.status ?? null,
    takeoverEffects: await timing.run(() => countEffects(id, 'takeover'), `${kind} takeover effects`),
    settled,
    settledEffects: kind === 'COMMITTED'
      ? await timing.run(() => countEffects(id, 'settled'), `${kind} settled effects`)
      : null,
  };
}

export async function secondExecutorTakeover() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const rows = [];
  for (const kind of ['COMMITTED', 'CANCELLED', 'ABANDONED']) {
    rows.push(await one(kind, timing));
  }
  const detail = { rows, bounds: timing.bounds };
  assertBounds(detail.bounds);
  const pass = rows.every((row) => row.fenced
    && row.status === row.kind
    && row.takeoverEffects === 0
    && (row.kind !== 'COMMITTED' || (commitReportHeld(row.settled) && row.settledEffects === 1)));
  return { pass, detail };
}
