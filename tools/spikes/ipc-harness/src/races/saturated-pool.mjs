// saturated-pool (plan B2 / T5c): concurrency equals the pinned default_pool_size
// (10). Effects transactions hold every server connection. Renewals still land
// because they use the reserved direct connection, the sweeper on that same
// direct path does not abandon them, and each execution commits.
// A pooled probe stays in cl_waiting for the whole lease crossing
// (PgBouncer transaction mode: the server connection is held until COMMIT).
// https://www.pgbouncer.org/config.html (pool_mode=transaction)
// https://www.pgbouncer.org/usage.html (SHOW POOLS cl_waiting)

import pg from 'pg';
import {
  CADENCE_MS,
  LEASE_MS,
  commitExecution,
  createExecution,
  dispatch,
  getStatus,
  openHarnessClient,
  sweepAbandoned,
} from '../authority.mjs';
import { deferred, manualClock, RACE_EPOCH_MS, withDeadline } from './clock.mjs';
import { countEffects, ensureEffects, insertEffect } from './support.mjs';

const POOL_PIN = 10;
const TICKS = 5;

function adminClient() {
  if (process.env.HARNESS_ADMIN_DSN) {
    const c = new pg.Client({ connectionString: process.env.HARNESS_ADMIN_DSN });
    c.on('error', () => {});
    return c;
  }
  if (!process.env.PLERNI_ADMIN_PASSWORD) return null;
  const c = new pg.Client({
    host: 'localhost',
    port: 54321,
    database: 'pgbouncer',
    user: 'plerni_admin_ro',
    password: process.env.PLERNI_ADMIN_PASSWORD,
  });
  c.on('error', () => {});
  return c;
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

async function pollPool(admin, ready, label, deadlineMs) {
  const started = Date.now();
  for (;;) {
    const row = await poolRow(admin);
    if (ready(row)) return row;
    if (Date.now() - started >= deadlineMs) {
      throw new Error(`${label} (cl_waiting=${row.clWaiting}, sv_active=${row.svActive})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function saturatedPool() {
  await ensureEffects();
  const admin = adminClient();
  if (!admin) return { pass: false, detail: { error: 'no pgbouncer admin datasource' } };
  await admin.connect();
  const release = deferred();
  const execs = [];
  let probe;
  try {
    const configured = await poolSize(admin);
    if (configured !== POOL_PIN) {
      return { pass: false, detail: { error: 'default_pool_size is not the pinned 10', configured } };
    }
    // Other harness cases release the pool as they finish. Proceed on the
    // observation, not after a fixed pause.
    await pollPool(
      admin,
      (row) => row.clWaiting === 0 && row.svActive === 0,
      'deadline: pool not idle',
      20_000,
    );

    const clock = manualClock(RACE_EPOCH_MS);
    const rows = [];
    for (let i = 0; i < configured; i += 1) {
      const token = `sat-${i}-${clock.millis()}`;
      const id = await createExecution('t5c-saturated', token, true);
      await dispatch(id, true, { now: await clock.now() });
      rows.push({ id, token });
    }
    let entered = 0;
    const allEntered = deferred();
    for (const row of rows) {
      execs.push(commitExecution(row.id, row.token, async (client) => {
        await insertEffect(client, row.id, 'sat');
        entered += 1;
        if (entered === rows.length) allEntered.resolve();
        await release.promise;
      }, false, { clock }));
    }
    await withDeadline(allEntered.promise, 5000, 'executions did not fill the pool');

    probe = openHarnessClient('pooled');
    await probe.connect();
    let probeSettled = false;
    const probeDone = probe.query('SELECT 1').then(() => {
      probeSettled = true;
    }, () => {
      probeSettled = true;
    });
    const waiting = await pollPool(
      admin,
      (row) => row.clWaiting >= 1,
      'deadline: pooled probe never entered cl_waiting',
      5000,
    );

    const samples = [];
    let sweptDuring = 0;
    await withDeadline((async () => {
      for (let tick = 0; tick < TICKS; tick += 1) {
        await clock.advance(CADENCE_MS);
        const row = await getStatus(rows[0].id, true);
        samples.push(new Date(row.heartbeat_at).getTime() - RACE_EPOCH_MS);
        const swept = await sweepAbandoned(true, { id: rows[0].id, now: await clock.now() });
        if (swept.includes(rows[0].id)) sweptDuring += 1;
      }
    })(), 10_000, 'reserved renewals did not finish while the pool was saturated');
    const blockedDuringRenewal = probeSettled === false;
    const waitingDuringRenewal = await poolRow(admin);
    const offsets = [];
    for (const row of rows) {
      const status = await getStatus(row.id, true);
      offsets.push(new Date(status.heartbeat_at).getTime() - RACE_EPOCH_MS);
    }

    release.resolve();
    const committed = await Promise.all(execs);
    await withDeadline(probeDone, 5000, 'pooled probe did not drain after commit');

    const statuses = [];
    let effects = 0;
    for (const row of rows) {
      statuses.push((await getStatus(row.id, true))?.status ?? null);
      effects += await countEffects(row.id, 'sat');
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
    };
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
