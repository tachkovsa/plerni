// heartbeat-behind-commit (plan B2 / T5c): the production renewal runs on its
// own interval. The effects transaction locks the fencing row, so that
// renewal's UPDATE waits. commitExecution then stops scheduling, issues the
// conditional COMMITTED update, commits, and only then drains the renewal.
// A shutdown order that awaited the renewal first would deadlock, and the
// deadline on this step would fire.

import { randomUUID } from 'node:crypto';
import { commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { countEffects, ensureEffects, insertEffect, waitForQueryLock } from './support.mjs';

export const HEARTBEAT_BOUND_MS = 20_000;
const LOCK_WAIT_MS = 12_000;

export async function heartbeatBehindCommit() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const token = `behind-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-heartbeat', token, true), 'create');
  await timing.run(() => dispatch(id, true), 'dispatch');
  let sawBlocked = false;

  const result = await timing.run(() => commitExecution(id, token, async (client) => {
    await client.query('SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE', [id]);
    await insertEffect(client, id, 'behind');
    await waitForQueryLock('heartbeat_at', LOCK_WAIT_MS);
    sawBlocked = true;
  }, true), 'heartbeat-behind-commit', HEARTBEAT_BOUND_MS);

  const commitBound = timing.bounds.find((item) => item.label === 'heartbeat-behind-commit');
  const detail = {
    id,
    committed: result.committed === true,
    sawBlocked,
    status: (await timing.run(() => getStatus(id, true), 'status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'behind'), 'effects'),
    elapsedMs: commitBound?.elapsedMs ?? null,
    boundMs: commitBound?.boundMs ?? null,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = detail.committed
    && detail.sawBlocked
    && detail.status === 'COMMITTED'
    && detail.effects === 1
    && detail.elapsedMs != null
    && detail.elapsedMs <= detail.boundMs;
  return { pass, detail };
}
