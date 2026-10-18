// Shared oracle for the race battery: an effects table the executor writes
// inside its transaction, independent reads, and a lock-wait barrier.
// The effects table is created at run time by the superuser. It is not a
// migration and it is not part of the fencing authority schema.

import pg from 'pg';
import { LEASE_MS, openHarnessClient } from '../authority.mjs';
import { manualClock } from './clock.mjs';

let effectsReady;

function rootClient() {
  if (process.env.HARNESS_ROOT_DSN) {
    const c = new pg.Client({ connectionString: process.env.HARNESS_ROOT_DSN });
    c.on('error', () => {});
    return c;
  }
  if (!process.env.POSTGRES_PASSWORD) {
    throw new Error('spike: missing POSTGRES_PASSWORD or HARNESS_ROOT_DSN for the effects fixture');
  }
  const c = new pg.Client({
    host: 'localhost',
    port: 54320,
    database: 'plerni',
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD,
  });
  c.on('error', () => {});
  return c;
}

export async function ensureEffects() {
  effectsReady ??= (async () => {
    const c = rootClient();
    await c.connect();
    try {
      await c.query(`CREATE TABLE IF NOT EXISTS spike_ipc_effect (
        execution_id uuid NOT NULL,
        note text NOT NULL,
        PRIMARY KEY (execution_id, note)
      )`);
      await c.query('GRANT SELECT, INSERT ON spike_ipc_effect TO plerni_app');
    } finally {
      await c.end();
    }
  })();
  return effectsReady;
}

export async function withDirect(fn) {
  const c = openHarnessClient('direct');
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function insertEffect(client, executionId, note) {
  await client.query(
    'INSERT INTO spike_ipc_effect (execution_id, note) VALUES ($1, $2)',
    [executionId, note],
  );
}

export async function countEffects(executionId, note) {
  return withDirect(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM spike_ipc_effect
       WHERE execution_id = $1 AND note = $2`,
      [executionId, note],
    );
    return Number(r.rows[0].n);
  });
}

// Fault-inject an expired lease using the server clock, so the production
// sweeper predicate matches without waiting out the 20s lease.
export async function expireHeartbeat(id) {
  await withDirect(async (c) => {
    const r = await c.query(
      `UPDATE fencing_authority
       SET heartbeat_at = clock_timestamp() - make_interval(secs => $2)
       WHERE id = $1`,
      [id, LEASE_MS / 1000 + 1],
    );
    if (r.rowCount !== 1) throw new Error('expire heartbeat matched no row');
  });
}

// Wall-clock renewals would heal a backdated lease if a case ran long.
// A manual clock that the case does not advance cannot.
export function heldClock(extra = {}) {
  return { clock: manualClock(), renew: async () => null, ...extra };
}

export async function killClient(client) {
  const stream = client.connection?.stream;
  if (!stream) throw new Error('client has no socket to kill');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deadline: executor socket did not close')), 5000);
    client.once('end', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.destroy();
  });
}

// Poll until some other backend is blocked on a lock and its query carries
// `fragment`. The deadline fails a missed barrier; it is not the synchronization.
export async function waitForQueryLock(fragment, deadlineMs = 5000) {
  if (!/^[a-z0-9-]{1,40}$/.test(fragment)) throw new Error('bad lock fragment');
  const c = openHarnessClient('direct');
  await c.connect();
  const started = Date.now();
  try {
    while (Date.now() - started < deadlineMs) {
      const r = await c.query(
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (r.rowCount > 0) return Number(r.rows[0].pid);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`deadline: no lock wait matching ${fragment}`);
  } finally {
    await c.end();
  }
}
