// saturated-pool (plan B2 / T5c): one production commitExecution holds a
// pooled server connection past a real lease. The other server connections
// are held by explicit transactions, and a pooled probe stays in cl_waiting.
// Renewals still land because commitExecution uses the reserved direct
// connection. The production sweeper, on that same direct path, does not
// abandon the row.
// https://www.pgbouncer.org/config.html (pool_mode=transaction)
// https://www.pgbouncer.org/usage.html (SHOW POOLS cl_waiting)

import { randomUUID } from 'node:crypto';
import { commitExecution, createExecution, dispatch, getStatus, sweepAbandoned } from '../authority.mjs';
import { assertBounds, deferred, steps } from './clock.mjs';
import { LEASE_MS, isAborted, openAppClient } from './control.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, insertEffect, openAdminClient } from './support.mjs';

const POOL_PIN = 10;
const HOLD_BOUND_MS = 50_000;
const SAMPLE_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poolSize(admin) {
  const found = await admin.query('SHOW CONFIG');
  const row = found.rows.find((item) => item.key === 'default_pool_size');
  if (!row) throw new Error('SHOW CONFIG has no default_pool_size');
  return Number(row.value);
}

async function poolRow(admin) {
  const found = await admin.query('SHOW POOLS');
  const row = found.rows.find((item) => item.database === 'plerni' && item.user === 'plerni_app');
  if (!row) return { present: false, clWaiting: 0, svActive: 0 };
  return {
    present: true,
    clWaiting: Number(row.cl_waiting),
    svActive: Number(row.sv_active),
  };
}

async function pollPool(admin, ready, label, deadlineMs, bounds) {
  const started = Date.now();
  for (;;) {
    if (isAborted()) throw new Error('aborted');
    const row = await poolRow(admin);
    if (ready(row)) {
      bounds.push({ label, elapsedMs: Date.now() - started, boundMs: deadlineMs });
      return row;
    }
    if (Date.now() - started >= deadlineMs) {
      throw new Error(`deadline exceeded: ${label} (cl_waiting=${row.clWaiting}, sv_active=${row.svActive})`);
    }
    await sleep(20);
  }
}

function holdServer(release) {
  const client = openAppClient('pooled');
  let markReady;
  let failReady;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  const done = (async () => {
    try {
      await client.connect();
      await client.query('BEGIN');
      markReady();
      await release.promise;
      await client.query('COMMIT');
    } catch (err) {
      failReady(err);
      throw err;
    } finally {
      await client.end().catch(() => {});
    }
  })();
  done.catch(() => {});
  return { ready, done };
}

export async function saturatedPool() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const admin = openAdminClient();
  if (!admin) return { pass: false, detail: { error: 'no pgbouncer admin datasource', bounds: [] } };
  await timing.run(() => admin.connect(), 'admin connect');
  const release = deferred();
  const entered = deferred();
  const saturated = deferred();
  const fillers = [];
  let probe;
  let probeDone = Promise.resolve();
  let probeSettled = false;
  let commitP = Promise.resolve(null);
  try {
    const configured = await timing.run(() => poolSize(admin), 'read pool size');
    if (configured !== POOL_PIN) {
      return {
        pass: false,
        detail: { error: 'default_pool_size is not the pinned 10', configured, bounds: timing.bounds },
      };
    }
    await pollPool(
      admin,
      (row) => row.clWaiting === 0 && row.svActive === 0,
      'pool idle',
      20_000,
      timing.bounds,
    );

    const token = `sat-${randomUUID()}`;
    const id = await timing.run(() => createExecution('t5c-saturated', token, true), 'create');
    await timing.run(() => dispatch(id, true), 'dispatch');
    const beats = [];
    let sweptDuring = 0;
    let holdMs = 0;
    let waitingAtEnd = 0;
    commitP = commitExecution(id, token, async (client) => {
      await insertEffect(client, id, 'sat');
      entered.resolve();
      await saturated.promise;
      const opened = Date.now();
      for (;;) {
        if (isAborted()) throw new Error('aborted');
        const row = await getStatus(id, true);
        if (row?.status !== 'ACTIVE') throw new Error(`abandoned during saturation: ${row?.status}`);
        const beat = new Date(row.heartbeat_at).getTime();
        if (beats.at(-1) !== beat) beats.push(beat);
        const swept = await sweepAbandoned(true);
        if (swept.includes(id)) sweptDuring += 1;
        holdMs = Date.now() - opened;
        if (holdMs > LEASE_MS && beats.length >= 5) break;
        if (holdMs > 35_000) {
          throw new Error(`lease crossing missed (${holdMs}ms, beats ${beats.length})`);
        }
        await sleep(SAMPLE_MS);
      }
      const still = await poolRow(admin);
      waitingAtEnd = still.clWaiting;
      if (waitingAtEnd < 1 || probeSettled) {
        throw new Error(`saturation dropped (cl_waiting=${waitingAtEnd}, probeSettled=${probeSettled})`);
      }
    }, false);
    commitP.catch(() => {});

    await timing.run(() => entered.promise, 'execution entered', 10_000);
    for (let i = 0; i < configured - 1; i += 1) fillers.push(holdServer(release));
    await timing.run(() => Promise.all(fillers.map((item) => item.ready)), 'fillers began', 10_000);

    probe = openAppClient('pooled');
    await timing.run(() => probe.connect(), 'probe connect');
    probeDone = probe.query('SELECT 1').then(() => {
      probeSettled = true;
    }, () => {
      probeSettled = true;
    });
    const waiting = await pollPool(
      admin,
      (row) => row.clWaiting >= 1,
      'pooled probe entered cl_waiting',
      5_000,
      timing.bounds,
    );
    saturated.resolve();

    const result = await timing.run(() => commitP, 'saturated commit', HOLD_BOUND_MS);
    release.resolve();
    await timing.run(() => Promise.all(fillers.map((item) => item.done)), 'fillers drained', 10_000);
    await timing.run(() => probeDone, 'probe drained', 5_000);

    const status = (await timing.run(() => getStatus(id, true), 'status'))?.status ?? null;
    const effects = await timing.run(() => countEffects(id, 'sat'), 'effects');
    const increasing = beats.every((beat, index) => index === 0 || beat > beats[index - 1]);
    const detail = {
      configured,
      waiting: waiting.clWaiting,
      waitingAtEnd,
      holdMs,
      beats: beats.length,
      increasing,
      ...commitMetrics(result),
      sweptDuring,
      status,
      effects,
      leaseMs: LEASE_MS,
      bounds: timing.bounds,
    };
    assertBounds(detail.bounds);
    const pass = configured === POOL_PIN
      && waiting.clWaiting >= 1
      && waitingAtEnd >= 1
      && holdMs > LEASE_MS
      && beats.length >= 5
      && increasing
      && result.renewals >= 4
      && result.boundViolation === false
      && Number.isFinite(result.lastRenewalToLockMs)
      && result.lastRenewalToLockMs >= 0
      && result.lastRenewalToLockMs <= result.bound
      && commitReportHeld(result)
      && sweptDuring === 0
      && result.committed === true
      && status === 'COMMITTED'
      && effects === 1;
    return { pass, detail };
  } finally {
    entered.resolve();
    saturated.resolve();
    release.resolve();
    await Promise.allSettled([commitP, probeDone, ...fillers.map((item) => item.done)]);
    if (probe) await probe.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}
