// death-before-commit (plan B2 / T5c): the executor dies after the effect
// write and before COMMIT. The open transaction rolls back. The sweeper
// leaves the row ACTIVE until the lease is expired, then settles ABANDONED.
// An independent connection sees zero effects.

import {
  createExecution,
  dispatch,
  getStatus,
  openHarnessClient,
  sweepAbandoned,
} from '../authority.mjs';
import { countEffects, ensureEffects, expireHeartbeat, insertEffect, killClient } from './support.mjs';

export async function deathBeforeCommit() {
  await ensureEffects();
  const token = 'death-before-commit';
  const id = await createExecution('t5c-death', token, true);
  await dispatch(id, true);

  const beforeExpiry = await sweepAbandoned(true, { id });
  const client = openHarnessClient('direct');
  await client.connect();
  await client.query('BEGIN');
  await insertEffect(client, id, 'died');
  await killClient(client);

  const afterDeath = await getStatus(id, true);
  const effectsAfterDeath = await countEffects(id, 'died');
  await expireHeartbeat(id);
  const settled = await sweepAbandoned(true, { id });
  const afterSweep = await getStatus(id, true);
  const effects = await countEffects(id, 'died');

  const detail = {
    id,
    sweptBeforeExpiry: beforeExpiry.includes(id),
    statusAfterDeath: afterDeath?.status ?? null,
    effectsAfterDeath,
    swept: settled.includes(id),
    status: afterSweep?.status ?? null,
    effects,
  };
  const pass = detail.sweptBeforeExpiry === false
    && detail.statusAfterDeath === 'ACTIVE'
    && effectsAfterDeath === 0
    && detail.swept === true
    && detail.status === 'ABANDONED'
    && effects === 0;
  return { pass, detail };
}
