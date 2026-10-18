// healthy-long (plan B2 / T5c): effects stay open for 25s of lease time
// (cadence 5s, lease 20s) while the sweeper runs. Renewals on the injected
// clock advance the durable heartbeat, so the row stays ACTIVE and then
// commits with its effect. The same run with renewals suppressed is fenced
// and the effect rolls back.

import { randomUUID } from 'node:crypto';
import {
  CADENCE_MS,
  FencedError,
  LEASE_MS,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  sweepAbandoned,
} from '../authority.mjs';
import { manualClock, RACE_EPOCH_MS } from './clock.mjs';
import { countEffects, ensureEffects, insertEffect } from './support.mjs';

const TICKS = 5;
const ELAPSED_MS = CADENCE_MS * TICKS;

async function run(suppress) {
  const clock = manualClock(RACE_EPOCH_MS);
  const token = `${suppress ? 'suppressed' : 'healthy'}-${randomUUID()}`;
  const id = await createExecution('t5c-healthy', token, true);
  await dispatch(id, true, { now: await clock.now() });
  const beats = [];
  let sweptDuring = 0;
  let effectsDuring = 0;
  let committed = false;
  let fenced = false;
  try {
    const result = await commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'long');
      for (let tick = 0; tick < TICKS; tick += 1) {
        await clock.advance(CADENCE_MS);
        const row = await getStatus(id, true);
        beats.push(new Date(row.heartbeat_at).getTime());
        effectsDuring += await countEffects(id, 'long');
        const swept = await sweepAbandoned(true, { id, now: await clock.now() });
        if (swept.includes(id)) sweptDuring += 1;
      }
    }, true, suppress ? { clock, renew: async () => null } : { clock });
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  }
  const offsets = beats.map((beat) => beat - RACE_EPOCH_MS);
  return {
    suppress,
    committed,
    fenced,
    status: (await getStatus(id, true))?.status ?? null,
    effects: await countEffects(id, 'long'),
    effectsDuring,
    sweptDuring,
    advances: new Set(beats).size,
    elapsedMs: offsets.at(-1) ?? 0,
    increasing: offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]),
  };
}

export async function healthyLong() {
  await ensureEffects();
  const positive = await run(false);
  const suppressed = await run(true);
  const pass = ELAPSED_MS > LEASE_MS
    && ELAPSED_MS >= 25_000
    && ELAPSED_MS <= 30_000
    && positive.committed === true
    && positive.fenced === false
    && positive.status === 'COMMITTED'
    && positive.effects === 1
    && positive.effectsDuring === 0
    && positive.sweptDuring === 0
    && positive.advances === TICKS
    && positive.elapsedMs === ELAPSED_MS
    && positive.increasing === true
    && suppressed.committed === false
    && suppressed.fenced === true
    && suppressed.status === 'ABANDONED'
    && suppressed.effects === 0
    && suppressed.sweptDuring >= 1;
  return {
    pass,
    detail: { cadenceMs: CADENCE_MS, leaseMs: LEASE_MS, elapsedMs: ELAPSED_MS, positive, suppressed },
  };
}
