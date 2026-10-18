// healthy-long (plan B2 / T5c): effects stay open for 25s of lease time
// (cadence 5s, lease 20s) while the sweeper runs. Renewals on the manual
// clock advance the durable heartbeat, so the row stays ACTIVE and then
// commits with its effect. The same run with renewals suppressed is fenced
// and the effect rolls back. The clock and the clocked sweep live in the
// race harness. The production sweeper is not given a fake timestamp.

import { randomUUID } from 'node:crypto';
import { FencedError, createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, manualClock, RACE_EPOCH_MS, steps } from './clock.mjs';
import { CADENCE_MS, LEASE_MS, raceCommit, raceSweep, stampHeartbeat } from './control.mjs';
import { countEffects, ensureEffects, insertEffect } from './support.mjs';

const TICKS = 5;
const ELAPSED_MS = CADENCE_MS * TICKS;
const COMMIT_BOUND_MS = 10000;

async function runCase(suppress, timing) {
  const clock = manualClock(RACE_EPOCH_MS);
  const label = suppress ? 'suppressed' : 'healthy';
  const token = `${label}-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-healthy', token, true), `${label} create`);
  await timing.run(() => dispatch(id, true), `${label} dispatch`);
  await stampHeartbeat(id, await clock.now(), timing.bounds);
  const beats = [];
  let sweptDuring = 0;
  let effectsDuring = 0;
  let committed = false;
  let fenced = false;
  try {
    const result = await raceCommit(id, token, async (client) => {
      await insertEffect(client, id, 'long');
      for (let tick = 0; tick < TICKS; tick += 1) {
        await clock.advance(CADENCE_MS);
        const row = await getStatus(id, true);
        beats.push(new Date(row.heartbeat_at).getTime());
        effectsDuring += await countEffects(id, 'long');
        const swept = await raceSweep(true, {
          id,
          now: await clock.now(),
          label: `${label} sweep ${tick}`,
          bounds: timing.bounds,
        });
        if (swept.ids.includes(id)) sweptDuring += 1;
      }
    }, true, {
      clock,
      label: `${label} commit`,
      bounds: timing.bounds,
      boundMs: COMMIT_BOUND_MS,
      ...(suppress ? { renew: async () => null } : {}),
    });
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
    status: (await timing.run(() => getStatus(id, true), `${label} status`))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'long'), `${label} effects`),
    effectsDuring,
    sweptDuring,
    advances: new Set(beats).size,
    elapsedMs: offsets.at(-1) ?? 0,
    increasing: offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]),
  };
}

export async function healthyLong() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const positive = await runCase(false, timing);
  const suppressed = await runCase(true, timing);
  const detail = {
    cadenceMs: CADENCE_MS,
    leaseMs: LEASE_MS,
    elapsedMs: ELAPSED_MS,
    positive,
    suppressed,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
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
  return { pass, detail };
}
