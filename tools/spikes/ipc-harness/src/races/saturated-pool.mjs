// saturated-pool (plan B2 / T5c): default_pool_size healthy executors (10,
// pinned by T2) each run production commitExecution on the pooled datasource
// and keep it past a real lease. Renewals use that execution's reserved
// direct connection. One more pooled client waits in cl_waiting, which is
// the saturation witness, not an executor. The production sweeper on the
// direct path does not abandon any of them.
// https://www.pgbouncer.org/config.html (pool_mode=transaction)
// https://www.pgbouncer.org/usage.html (SHOW POOLS cl_waiting)

import { randomUUID } from 'node:crypto';
import { commitExecution, createExecution, dispatch, getStatus, sweepAbandoned } from '../authority.mjs';
import { assertBounds, deferred, steps, withDeadline } from './clock.mjs';
import { CADENCE_MS, LEASE_MS, abortInFlight, endClient, isAborted, openAppClient, settleAll } from './control.mjs';
import { commitMetrics, commitReportHeld, countEffects, ensureEffects, insertEffect, openAdminClient } from './support.mjs';

const POOL_PIN = 10;
const HOLD_LIMIT_MS = 35_000;
const SAMPLE_MS = 1000;

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

function startExecutor(index, saturated, release) {
  const token = `sat-${index}-${randomUUID()}`;
  const note = `sat-${index}`;
  const entered = deferred();
  const held = deferred();
  const state = {
    index,
    id: null,
    note,
    entered,
    held,
    holdMs: 0,
    beats: [],
    result: null,
  };
  const done = (async () => {
    state.id = await createExecution('t5c-saturated', token, true);
    await dispatch(state.id, true);
    state.result = await commitExecution(state.id, token, async (client) => {
      await insertEffect(client, state.id, note);
      entered.resolve();
      await saturated.promise;
      const opened = Date.now();
      for (;;) {
        if (isAborted()) throw new Error('aborted');
        const row = await getStatus(state.id, true);
        if (row?.status !== 'ACTIVE') throw new Error(`abandoned during saturation: ${row?.status}`);
        const beat = new Date(row.heartbeat_at).getTime();
        if (state.beats.at(-1) !== beat) state.beats.push(beat);
        state.holdMs = Date.now() - opened;
        if (state.holdMs > LEASE_MS && state.beats.length >= 5) break;
        if (state.holdMs > HOLD_LIMIT_MS) {
          throw new Error(`lease crossing missed for executor ${index} (${state.holdMs}ms, beats ${state.beats.length})`);
        }
        await sleep(SAMPLE_MS);
      }
      held.resolve();
      await release.promise;
    }, false);
    return state;
  })();
  done.catch(() => {});
  state.done = done;
  return state;
}

export async function saturatedPool() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const admin = openAdminClient();
  if (!admin) return { pass: false, detail: { error: 'no pgbouncer admin datasource', bounds: [] } };
  await timing.run(() => admin.connect(), 'admin connect');
  const saturated = deferred();
  const release = deferred();
  const executors = [];
  let probe;
  let probeDone = Promise.resolve();
  let probeSettled = false;
  let sweptDuring = 0;
  let watch = false;
  let watcherError = null;
  let watcher = Promise.resolve();
  try {
    const configured = await timing.run(() => poolSize(admin), 'read pool size');
    if (configured !== POOL_PIN) {
      return {
        pass: false,
        detail: { error: 'default_pool_size is not the pinned 10', configured, bounds: timing.bounds },
      };
    }
    await timing.run(
      () => pollPool(
        admin,
        (row) => row.clWaiting === 0 && row.svActive === 0,
        'pool idle',
        20_000,
        timing.bounds,
      ),
      'pool idle',
      22_000,
    );

    for (let index = 0; index < configured; index += 1) {
      executors.push(startExecutor(index, saturated, release));
    }
    await timing.run(
      () => Promise.all(executors.map((item) => item.entered.promise)),
      'executors entered',
      15_000,
    );
    watch = true;
    watcher = (async () => {
      while (watch) {
        if (isAborted()) return;
        let swept;
        try {
          swept = await withDeadline(sweepAbandoned(true), 5_000, 'saturation sweep');
        } catch (err) {
          await abortInFlight();
          throw err;
        }
        for (const item of executors) {
          if (item.id && swept.includes(item.id)) sweptDuring += 1;
        }
        await sleep(SAMPLE_MS);
      }
    })().catch((err) => {
      watcherError = err;
    });

    probe = openAppClient('pooled');
    await timing.run(() => probe.connect(), 'probe connect');
    probeDone = probe.query('SELECT 1').then(() => {
      probeSettled = true;
    }, () => {
      probeSettled = true;
    });
    const waiting = await timing.run(
      () => pollPool(
        admin,
        (row) => row.clWaiting >= 1,
        'pooled probe entered cl_waiting',
        5_000,
        timing.bounds,
      ),
      'pooled probe entered cl_waiting',
      7_000,
    );
    saturated.resolve();

    await timing.run(
      () => Promise.all(executors.map((item) => item.held.promise)),
      'lease crossing',
      45_000,
    );
    const still = await timing.run(() => poolRow(admin), 'saturation still held');
    if (still.clWaiting < 1 || probeSettled) {
      throw new Error(`saturation dropped (cl_waiting=${still.clWaiting}, probeSettled=${probeSettled})`);
    }
    release.resolve();
    const finished = await timing.run(
      () => Promise.all(executors.map((item) => item.done)),
      'saturated commits',
      15_000,
    );
    await timing.run(() => probeDone, 'probe drained', 5_000);

    const reports = [];
    for (const item of finished) {
      const status = (await timing.run(() => getStatus(item.id, true), `status ${item.index}`))?.status ?? null;
      const effects = await timing.run(() => countEffects(item.id, item.note), `effects ${item.index}`);
      const increasing = item.beats.every((beat, index) => index === 0 || beat > item.beats[index - 1]);
      reports.push({
        index: item.index,
        ...commitMetrics(item.result),
        holdMs: item.holdMs,
        beats: item.beats.length,
        increasing,
        status,
        effects,
      });
    }
    const detail = {
      configured,
      executors: reports.length,
      waiting: waiting.clWaiting,
      waitingAtEnd: still.clWaiting,
      sweptDuring,
      leaseMs: LEASE_MS,
      reports,
      bounds: timing.bounds,
    };
    if (watcherError) throw watcherError;
    assertBounds(detail.bounds);
    const pass = configured === POOL_PIN
      && reports.length === POOL_PIN
      && waiting.clWaiting >= 1
      && still.clWaiting >= 1
      && sweptDuring === 0
      && reports.every((report) => report.holdMs > LEASE_MS
        && report.beats >= 5
        && report.increasing
        && report.renewals >= 4
        && report.boundViolation === false
        && report.bound === CADENCE_MS
        && Number.isFinite(report.lastRenewalToLockMs)
        && report.lastRenewalToLockMs >= 0
        && report.lastRenewalToLockMs <= CADENCE_MS
        && commitReportHeld(report)
        && report.committed === true
        && report.status === 'COMMITTED'
        && report.effects === 1);
    return { pass, detail };
  } finally {
    watch = false;
    saturated.resolve();
    release.resolve();
    const tasks = [
      ['saturation watcher', watcher],
      ['saturation probe', probeDone],
      ...executors.map((item) => [`saturation executor ${item.index}`, item.done]),
    ];
    try {
      await abortInFlight();
      await settleAll(tasks);
    } finally {
      if (probe) await endClient(probe);
      await endClient(admin);
    }
  }
}
