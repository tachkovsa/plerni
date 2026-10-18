// healthy-long (plan B2 / T5c): the positive control keeps one production
// commitExecution open for 25–30s of wall time. Production renewals (cadence
// 5s, lease 20s) and the production sweeper run while it is open. The row
// stays ACTIVE, then commits with its effect. The renewal-suppressed control
// uses quietRenew and the same production sweeper, stays open past the real
// lease, and the conditional commit is fenced.

import { randomUUID } from 'node:crypto';
import {
  FencedError,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  startSweeper,
} from '../authority.mjs';
import { assertBounds, steps } from './clock.mjs';
import { CADENCE_MS, LEASE_MS, isAborted } from './control.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, insertEffect, quietRenew } from './support.mjs';

const OPEN_MIN_MS = 25_000;
const OPEN_MAX_MS = 30_000;
const POSITIVE_BOUND_MS = 40_000;
const SUPPRESSED_BOUND_MS = 50_000;
const SUPPRESSED_LIMIT_MS = 40_000;
const SAMPLE_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function positive(timing) {
  const token = `healthy-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-healthy', token, true), 'healthy create');
  await timing.run(() => dispatch(id, true), 'healthy dispatch');
  const stop = startSweeper(true);
  const beats = [];
  let effectsDuring = 0;
  let wallMs = 0;
  let committed = false;
  let fenced = false;
  let report = commitMetrics(null);
  try {
    const result = await timing.run(() => commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'long');
      const opened = Date.now();
      for (;;) {
        if (isAborted()) throw new Error('aborted');
        const row = await getStatus(id, true);
        if (row?.status !== 'ACTIVE') throw new Error(`sweeper rewrote a healthy row: ${row?.status}`);
        const beat = new Date(row.heartbeat_at).getTime();
        if (beats.at(-1) !== beat) beats.push(beat);
        const visible = await countEffects(id, 'long');
        effectsDuring += visible;
        wallMs = Date.now() - opened;
        if (wallMs >= OPEN_MIN_MS && beats.length >= 5) {
          if (wallMs > OPEN_MAX_MS) throw new Error(`healthy window closed at ${wallMs}ms`);
          return;
        }
        if (wallMs > OPEN_MAX_MS) {
          throw new Error(`healthy window missed renewals at ${wallMs}ms (beats ${beats.length})`);
        }
        await sleep(SAMPLE_MS);
      }
    }, true), 'healthy commit', POSITIVE_BOUND_MS);
    report = commitMetrics(result);
    committed = report.committed;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  } finally {
    stop();
  }
  const increasing = beats.every((beat, index) => index === 0 || beat > beats[index - 1]);
  return {
    committed,
    fenced,
    ...report,
    wallMs,
    advances: beats.length,
    increasing,
    effectsDuring,
    status: (await timing.run(() => getStatus(id, true), 'healthy status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'long'), 'healthy effects'),
  };
}

async function suppressed(timing) {
  const token = `suppressed-${randomUUID()}`;
  const id = await timing.run(() => createExecution('t5c-healthy', token, true), 'suppressed create');
  await timing.run(() => dispatch(id, true), 'suppressed dispatch');
  const stop = startSweeper(true);
  let wallMs = 0;
  let committed = false;
  let fenced = false;
  let abandoned = false;
  try {
    const result = await timing.run(() => commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'long');
      const opened = Date.now();
      for (;;) {
        if (isAborted()) throw new Error('aborted');
        const row = await getStatus(id, true);
        if (row?.status === 'ABANDONED') abandoned = true;
        if (row?.status === 'COMMITTED') throw new Error('suppressed execution committed');
        const visible = await countEffects(id, 'long');
        if (visible !== 0) throw new Error('uncommitted effect was visible');
        wallMs = Date.now() - opened;
        if (abandoned && wallMs > LEASE_MS) return;
        if (wallMs > SUPPRESSED_LIMIT_MS) {
          throw new Error(`suppressed sweeper left the row ${row?.status} at ${wallMs}ms`);
        }
        await sleep(SAMPLE_MS);
      }
    }, true, quietRenew()), 'suppressed commit', SUPPRESSED_BOUND_MS);
    committed = result.committed === true;
  } catch (err) {
    fenced = err instanceof FencedError;
    if (!fenced) throw err;
  } finally {
    stop();
  }
  return {
    committed,
    fenced,
    abandoned,
    wallMs,
    status: (await timing.run(() => getStatus(id, true), 'suppressed status'))?.status ?? null,
    effects: await timing.run(() => countEffects(id, 'long'), 'suppressed effects'),
  };
}

export async function healthyLong() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const held = await positive(timing);
  const dropped = await suppressed(timing);
  const detail = {
    cadenceMs: CADENCE_MS,
    leaseMs: LEASE_MS,
    positive: held,
    suppressed: dropped,
    bounds: timing.bounds,
  };
  assertBounds(detail.bounds);
  const pass = held.wallMs >= OPEN_MIN_MS
    && held.wallMs <= OPEN_MAX_MS
    && held.wallMs > LEASE_MS
    && held.committed === true
    && held.fenced === false
    && held.renewals >= 4
    && held.boundViolation === false
    && Number.isFinite(held.lastRenewalToLockMs)
    && held.lastRenewalToLockMs >= 0
    && held.lastRenewalToLockMs <= CADENCE_MS
    && commitReportHeld(held)
    && held.advances >= 5
    && held.increasing === true
    && held.status === 'COMMITTED'
    && held.effects === 1
    && held.effectsDuring === 0
    && dropped.committed === false
    && dropped.fenced === true
    && dropped.abandoned === true
    && dropped.wallMs > LEASE_MS
    && dropped.status === 'ABANDONED'
    && dropped.effects === 0;
  return { pass, detail };
}
