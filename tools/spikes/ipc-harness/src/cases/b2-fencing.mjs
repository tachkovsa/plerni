// b2-fencing.mjs — revocation endpoint and the commit predicate (plan §4 B2).
// 1 row → cancelled. 0 rows → lost, never cancelled. Ignore-cancel does not
// invent an acknowledgement. The race battery itself is T5c.

import { fileURLToPath } from 'node:url';
import { FencedError, commitExecution, createExecution, dispatch, getStatus } from '../authority.mjs';
import { connectPair, dbConfigured, useDirectFromEnv } from '../supervisor.mjs';

const ignorePath = fileURLToPath(new URL('../children/ignore-cancel.mjs', import.meta.url));

export async function b2() {
  if (!dbConfigured()) return { pass: false, detail: { error: 'no harness database' } };
  const useDirect = useDirectFromEnv();
  // Smoke owns the ACTIVE→ABANDONED assertion. This case does not claim the sweeper ran.
  const pair = await connectPair({ sweeper: false, useDirect });
  try {
    const lostId = await createExecution('b2-lost', 'tok-lost', useDirect);
    await dispatch(lostId, useDirect);
    await commitExecution(lostId, 'tok-lost', async (c) => {
      await c.query('select 1');
    }, useDirect);
    const lost = await pair.stub.revoke(lostId, useDirect);
    const lostStatus = await getStatus(lostId, useDirect);

    const ackId = await createExecution('b2-ack', 'tok-ack', useDirect);
    await dispatch(ackId, useDirect);
    const ack = await pair.stub.revoke(ackId, useDirect);
    const ackStatus = await getStatus(ackId, useDirect);

    const fenceId = await createExecution('b2-fence', 'tok-fence', useDirect);
    await dispatch(fenceId, useDirect);
    const fenceAck = await pair.stub.revoke(fenceId, useDirect);
    let fenced = false;
    try {
      await commitExecution(fenceId, 'tok-fence', async () => {}, useDirect);
    } catch (e) {
      fenced = e instanceof FencedError;
    }
    const fenceStatus = await getStatus(fenceId, useDirect);

    const spawned = pair.sup.spawn({ pluginId: 'ignore', script: ignorePath });
    const call = {
      pluginId: 'ignore',
      credential: spawned.credential,
      correlationId: 1,
      port: 'db',
      method: 'run',
      payload: { from: 'ignore' },
    };
    const resultP = pair.stub.call(call, 2_000);
    const cancelErr = await pair.stub.cancel(call, 200).catch((e) => e);
    const result = await resultP;

    const detail = {
      lost: lost.outcome,
      lostStatus: lostStatus?.status ?? null,
      ack: ack.outcome,
      ackStatus: ackStatus?.status ?? null,
      fenceAck: fenceAck.outcome,
      fenced,
      fenceStatus: fenceStatus?.status ?? null,
      ignoreResult: result.payload?.from ?? null,
      ignoreCancelCode: cancelErr.code ?? null,
    };
    const pass = lost.outcome === 'lost'
      && lost.outcome !== 'cancelled'
      && lostStatus?.status === 'COMMITTED'
      && ack.outcome === 'cancelled'
      && ackStatus?.status === 'CANCELLED'
      && fenceAck.outcome === 'cancelled'
      && fenced
      && fenceStatus?.status === 'CANCELLED'
      && result.payload?.from === 'ignore'
      && cancelErr.code === 'timeout';
    return { pass, detail };
  } finally {
    await pair.close();
  }
}
