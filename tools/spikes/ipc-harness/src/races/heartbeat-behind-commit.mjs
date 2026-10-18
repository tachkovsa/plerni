// heartbeat-behind-commit (plan B2 / T5c): a renewal is placed behind the
// uncommitted COMMITTED update and blocks on that row lock. COMMIT is
// observed before the renewal returns. The whole commit is inside a deadline;
// a shutdown-order regression that waits on the parked renewal never reaches
// the boolean checks, and the observed elapsed time is asserted against the bound.

import { randomUUID } from 'node:crypto';
import { createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, COMPLETION_BOUND_MS, deferred, steps } from './clock.mjs';
import { raceCommit } from './control.mjs';
import { countEffects, ensureEffects, heldClock, insertEffect, waitForQueryLock } from './support.mjs';

const BARRIER_MS = 2000;

export async function heartbeatBehindCommit() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const token = `behind-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-heartbeat', token, true), 'create');
  await timing.run(() => dispatch(id, true), 'dispatch');
  const release = deferred();
  let renewalReturned = false;
  let sawCommitFirst = false;

  const renew = async (rowId, rowToken, reserved, ctl) => {
    const updated = await reserved.query(
      `UPDATE fencing_authority SET heartbeat_at = clock_timestamp()
       WHERE id = $1 AND token = $2 AND status = 'ACTIVE'
       RETURNING heartbeat_at /* hb-behind */`,
      [rowId, rowToken],
    );
    if (ctl?.stop) return null;
    await release.promise;
    renewalReturned = true;
    return updated.rowCount === 1 ? updated.rows[0].heartbeat_at : null;
  };

  const result = await raceCommit(id, token, async (client) => {
    await insertEffect(client, id, 'behind');
  }, true, {
    ...heldClock(),
    renew,
    renewBehindLock: true,
    label: 'heartbeat-behind-commit',
    bounds: timing.bounds,
    boundMs: COMPLETION_BOUND_MS,
    afterLock: async () => {
      await waitForQueryLock('hb-behind', BARRIER_MS);
    },
    afterCommit: async () => {
      const status = (await getStatus(id, true))?.status ?? null;
      sawCommitFirst = status === 'COMMITTED' && renewalReturned === false;
      release.resolve();
    },
  });

  const commitBound = timing.bounds.find((item) => item.label === 'heartbeat-behind-commit');
  const detail = {
    id,
    committed: result.committed === true,
    sawCommitFirst,
    renewalReturned,
    status: (await timing.run(() => getStatus(id, true), 'status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'behind'), 'effects'),
    elapsedMs: commitBound?.elapsedMs ?? null,
    boundMs: commitBound?.boundMs ?? null,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = detail.committed && detail.sawCommitFirst && detail.renewalReturned
    && detail.status === 'COMMITTED' && detail.effects === 1
    && detail.elapsedMs != null
    && detail.elapsedMs <= detail.boundMs;
  return { pass, detail };
}
