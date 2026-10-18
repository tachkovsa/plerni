// second-executor-takeover (plan B2 / §11.11): after the row is terminal, a
// second executor holding the stale token issues the conditional COMMITTED
// update. Zero rows, FENCED, and the takeover effect is absent on an
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
import { countEffects, ensureEffects, expireHeartbeat, heldClock, insertEffect } from './support.mjs';

async function settle(kind, id, token) {
  if (kind === 'COMMITTED') {
    await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'settled');
    }, true, heldClock());
    return;
  }
  if (kind === 'CANCELLED') {
    const won = await cancelExecution(id, true);
    if (!won) throw new Error('cancel did not win');
    return;
  }
  await expireHeartbeat(id);
  const swept = await sweepAbandoned(true, { id });
  if (!swept.includes(id)) throw new Error('sweeper did not abandon the settled row');
}

async function one(kind) {
  const token = `stale-${kind}-${randomUUID()}`;
  const id = await createExecution('t5c-takeover', token, true);
  await dispatch(id, true);
  await settle(kind, id, token);
  let fenced = false;
  try {
    await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'takeover');
    }, true, heldClock());
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }
  return {
    kind,
    fenced,
    status: (await getStatus(id, true))?.status ?? null,
    takeoverEffects: await countEffects(id, 'takeover'),
    settledEffects: kind === 'COMMITTED' ? await countEffects(id, 'settled') : null,
  };
}

export async function secondExecutorTakeover() {
  await ensureEffects();
  const rows = [];
  for (const kind of ['COMMITTED', 'CANCELLED', 'ABANDONED']) {
    rows.push(await one(kind));
  }
  const pass = rows.every((row) => row.fenced
    && row.status === row.kind
    && row.takeoverEffects === 0
    && (row.kind !== 'COMMITTED' || row.settledEffects === 1));
  return { pass, detail: { rows } };
}
