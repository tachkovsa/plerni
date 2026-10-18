// saturated-pool (plan B2 / T5c): concurrency equals the pinned default_pool_size
// (10). Effects transactions hold every server connection. Renewals still land
// because they use the reserved direct connection, the sweeper on that same
// direct path does not abandon them, and each execution commits.
// A pooled probe stays in cl_waiting for the whole lease crossing
// (PgBouncer transaction mode: the server connection is held until COMMIT).
// The lease crossing is the manual clock. Each wait has a deadline.
// https://www.pgbouncer.org/config.html (pool_mode=transaction)
// https://www.pgbouncer.org/usage.html (SHOW POOLS cl_waiting)

import pg from 'pg';
import { createExecution, dispatch, getStatus } from '../authority.mjs';
import { assertBounds, bounded, deferred, manualClock, RACE_EPOCH_MS, steps } from './clock.mjs';
import { CADENCE_MS, LEASE_MS, openAppClient, raceCommit, raceSweep, stampHeartbeat } from './control.mjs';
import { countEffects, ensureEffects, insertEffect } from './support.mjs';

const POOL_PIN = 10;
const TICKS = 5;
const HOLD_BOUND_MS = 45000;

function adminClient() {
  if (process.env.HARNESS_ADMIN_DSN) {
    const client = new pg.Client({ connectionString: process.env.HARNESS_ADMIN_DSN });
    client.on('error', () => {});
    return client;
  }
  if (!process.env.PLERNI_ADMIN_PASSWORD) return null;
  const client = new pg.Client({
    host: 'localhost',
    port: 54321,
    database: 'pgbouncer',
    user: 'plerni_admin_ro',
    password: process.env.PLERNI_ADMIN_PASSWORD,
  });
  client.on('error', () => {});
  return client;
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
    const row = await poolRow(admin);
    if (ready(row)) {
      bounds.push({ label, elapsedMs: Date.now() - started, boundMs: deadlineMs });
      return row;
    }
    if (Date.now() - started >= deadlineMs) {
      throw new Error(`deadline exceeded: ${label} (cl_waiting=${row.clWaiting}, sv_active=${row.svActive})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function saturatedPool() {
  const timing = steps();
  await timing.run(() => ensureEffects(), 'effects fixture');
  const admin = adminClient();
  if (!admin) return { pass: false, detail: { error: 'no pgbouncer admin datasource', bounds: [] } };
  await timing.run(() => admin.connect(), 'admin connect');
  const release = deferred();
  const execs = [];
  const cancels = [];
  let probe;
  try {
    const configured = await timing.run(() => poolSize(admin), 'read pool size');
    if (configured !== POOL_PIN) {
      return { pass: false, detail: { error: 'default_pool_size is not the pinned 10', configured, bounds: timing.bounds } };
    }
    await pollPool(
      admin,
      (row) => row.clWaiting === 0 && row.svActive === 0,
      'pool idle',
      20_000,
      timing.bounds,
    );

    const clock = manualClock(RACE_EPOCH_MS);
    const rows = [];
    for (let i = 0; i < configured; i += 1) {
      const token = `sat-${i}-${clock.millis()}`;
      const id = await timing.run(() => createExecution('t5c-saturated', token, true), `create ${i}`);
      await timing.run(() => dispatch(id, true), `dispatch ${i}`);
      await stampHeartbeat(id, await clock.now(), timing.bounds);
      rows.push({ id, token });
    }
    let entered = 0;
    const allEntered = deferred();
    for (const [index, row] of rows.entries()) {
      execs.push(raceCommit(row.id, row.token, async (client) => {
        await insertEffect(client, row.id, 'sat');
        entered += 1;
        if (entered === rows.length) allEntered.resolve();
        await release.promise;
      }, false, {
        clock,
        label: `saturated commit ${index}`,
        bounds: timing.bounds,
        boundMs: HOLD_BOUND_MS,
        register: (cancel) => cancels.push(cancel),
      }));
    }
    await timing.run(() => allEntered.promise, 'executions filled the pool', 5000);

    probe = openAppClient('pooled');
    await timing.run(() => probe.connect(), 'probe connect');
    let probeSettled = false;
    const probeDone = probe.query('SELECT 1').then(() => {
      probeSettled = true;
    }, () => {
      probeSettled = true;
    });
    const waiting = await pollPool(
      admin,
      (row) => row.clWaiting >= 1,
      'pooled probe entered cl_waiting',
      5000,
      timing.bounds,
    );

    const samples = [];
    let sweptDuring = 0;
    const renewal = await bounded(async () => {
      for (let tick = 0; tick < TICKS; tick += 1) {
        await clock.advance(CADENCE_MS);
        const row = await getStatus(rows[0].id, true);
        samples.push(new Date(row.heartbeat_at).getTime() - RACE_EPOCH_MS);
        const swept = await raceSweep(true, {
          id: rows[0].id,
          now: await clock.now(),
          label: `saturated sweep ${tick}`,
          bounds: timing.bounds,
        });
        if (swept.ids.includes(rows[0].id)) sweptDuring += 1;
      }
    }, 10_000, 'reserved renewals while the pool is saturated', () => {
      for (const cancel of cancels) cancel();
    });
    timing.bounds.push({
      label: renewal.label,
      elapsedMs: renewal.elapsedMs,
      boundMs: renewal.boundMs,
    });
    const blockedDuringRenewal = probeSettled === false;
    const waitingDuringRenewal = await timing.run(() => poolRow(admin), 'pool during renewal');
    const offsets = [];
    for (const row of rows) {
      const status = await timing.run(() => getStatus(row.id, true), 'heartbeat before release');
      offsets.push(new Date(status.heartbeat_at).getTime() - RACE_EPOCH_MS);
    }

    release.resolve();
    const committed = await timing.run(() => Promise.all(execs), 'commits drained', 10_000);
    await timing.run(() => probeDone, 'probe drained', 5000);

    const statuses = [];
    let effects = 0;
    for (const row of rows) {
      statuses.push((await timing.run(() => getStatus(row.id, true), 'status after commit'))?.status ?? null);
      effects += await timing.run(() => countEffects(row.id, 'sat'), 'effects after commit');
    }
    const detail = {
      configured,
      waiting: waiting.clWaiting,
      blockedDuringRenewal,
      waitingDuringRenewal: waitingDuringRenewal.clWaiting,
      samples,
      offsets,
      sweptDuring,
      commits: committed.filter((item) => item.committed).length,
      statuses,
      effects,
      leaseMs: LEASE_MS,
      bounds: timing.bounds,
    };
    assertBounds(detail.bounds);
    const pass = configured === POOL_PIN
      && waiting.clWaiting >= 1
      && blockedDuringRenewal
      && waitingDuringRenewal.clWaiting >= 1
      && samples.length === TICKS
      && new Set(samples).size === TICKS
      && samples.at(-1) === CADENCE_MS * TICKS
      && samples.at(-1) > LEASE_MS
      && offsets.every((offset) => offset > LEASE_MS)
      && sweptDuring === 0
      && detail.commits === configured
      && statuses.every((status) => status === 'COMMITTED')
      && effects === configured;
    return { pass, detail };
  } finally {
    release.resolve();
    await Promise.allSettled(execs);
    if (probe) {
      probe.connection?.stream?.destroy();
      await probe.end().catch(() => {});
    }
    await admin.end().catch(() => {});
  }
}
