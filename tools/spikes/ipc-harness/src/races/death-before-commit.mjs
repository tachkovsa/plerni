// death-before-commit (plan B2 / T5c): the executor dies after the effect
// write and before COMMIT. The open transaction rolls back. The production
// sweeper leaves the row ACTIVE until the lease is expired, then settles
// ABANDONED. An independent connection sees zero effects.

import { createExecution, dispatch, getStatus, sweepAbandoned } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { openAppClient } from './control.mjs';
import { countEffects, ensureEffects, expireHeartbeat, insertEffect, killClient } from './support.mjs';

export async function deathBeforeCommit() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const id = await timing.run(
    () => createExecution('t5c-death', 'death-before-commit', true),
    'create',
  );
  await timing.run(() => dispatch(id, true), 'dispatch');
  const beforeExpiry = await timing.run(() => sweepAbandoned(true), 'sweep before expiry');

  const client = openAppClient('direct');
  try {
    await timing.run(async () => {
      await client.connect();
      await client.query('BEGIN');
      await insertEffect(client, id, 'died');
    }, 'begin effects');
    await timing.run(() => killClient(client), 'kill executor', 8000);
  } finally {
    client.connection?.stream?.destroy();
    await client.end().catch(() => {});
  }

  const afterDeath = await timing.run(() => getStatus(id, true), 'status after death');
  const effectsAfterDeath = await timing.run(() => countEffects(id, 'died'), 'effects after death');
  await timing.run(() => expireHeartbeat(id), 'expire heartbeat');
  const settled = await timing.run(() => sweepAbandoned(true), 'sweep after expiry');
  const afterSweep = await timing.run(() => getStatus(id, true), 'status after sweep');
  const effects = await timing.run(() => countEffects(id, 'died'), 'effects after sweep');

  const detail = {
    id,
    sweptBeforeExpiry: beforeExpiry.includes(id),
    statusAfterDeath: afterDeath?.status ?? null,
    effectsAfterDeath,
    swept: settled.includes(id),
    status: afterSweep?.status ?? null,
    effects,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = detail.sweptBeforeExpiry === false
    && detail.statusAfterDeath === 'ACTIVE'
    && effectsAfterDeath === 0
    && detail.swept === true
    && detail.status === 'ABANDONED'
    && effects === 0;
  return { pass, detail };
}
