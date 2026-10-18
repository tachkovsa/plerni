// heartbeat-behind-commit (plan B2 / T5c): a renewal is placed behind the
// uncommitted COMMITTED update and blocks on that row lock. COMMIT is
// observed before the renewal returns. Completion does not wait for the
// renewal's post-lock barrier.

import { randomUUID } from 'node:crypto';
import { commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { deferred } from './clock.mjs';
import { countEffects, ensureEffects, heldClock, insertEffect, waitForQueryLock } from './support.mjs';

export async function heartbeatBehindCommit() {
  await ensureEffects();
  const token = `behind-${randomUUID()}`;
  const id = await createExecution('t5c-heartbeat', token, true);
  await dispatch(id, true);
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

  const result = await commitExecution(id, token, async (client) => {
    await insertEffect(client, id, 'behind');
  }, true, {
    ...heldClock(),
    renew,
    renewBehindLock: true,
    afterLock: async () => {
      await waitForQueryLock('hb-behind');
    },
    afterCommit: async () => {
      const status = (await getStatus(id, true))?.status ?? null;
      sawCommitFirst = status === 'COMMITTED' && renewalReturned === false;
      release.resolve();
    },
  });

  const detail = {
    id,
    committed: result.committed === true,
    sawCommitFirst,
    renewalReturned,
    status: (await getStatus(id, true))?.status ?? null,
    effects: await countEffects(id, 'behind'),
  };
  const pass = detail.committed && detail.sawCommitFirst && detail.renewalReturned
    && detail.status === 'COMMITTED' && detail.effects === 1;
  return { pass, detail };
}
