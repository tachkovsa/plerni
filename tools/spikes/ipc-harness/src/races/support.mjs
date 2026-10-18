// Shared oracle for the race battery: an effects table the executor writes
// inside its transaction, independent reads, and a lock-wait barrier.
// The effects table is created at run time by the superuser. It is not a
// migration and it is not part of the fencing authority schema.

import pg from 'pg';
import { CADENCE_MS, LEASE_MS, endClient, isAborted, openAppClient, queryWithin } from './control.mjs';

let effectsReady;

function rootClient(connectionTimeoutMillis = 0) {
  const timeout = connectionTimeoutMillis > 0 ? { connectionTimeoutMillis } : {};
  if (process.env.HARNESS_ROOT_DSN) {
    const c = new pg.Client({ connectionString: process.env.HARNESS_ROOT_DSN, ...timeout });
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
    ...timeout,
  });
  c.on('error', () => {});
  return c;
}

export function openAdminClient(connectionTimeoutMillis = 0) {
  const timeout = connectionTimeoutMillis > 0 ? { connectionTimeoutMillis } : {};
  if (process.env.HARNESS_ADMIN_DSN) {
    const client = new pg.Client({ connectionString: process.env.HARNESS_ADMIN_DSN, ...timeout });
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
    ...timeout,
  });
  client.on('error', () => {});
  return client;
}

const PROBE_MS = 2000;

// Connection timeout bounds dialing. This bound covers a server that accepts
// the socket and then never answers the probe statement. Destroying the
// socket is client-side: a pooled probe must not SET a session timeout,
// because PgBouncer transaction mode would reuse that server connection.
export async function probeConnection(open, query, boundMs = PROBE_MS) {
  const client = open();
  if (!client) return 'not configured';
  let timer;
  try {
    await client.connect();
    let settled = false;
    const queryP = client.query(query).then(() => {
      settled = true;
      return null;
    }, () => 'connection failed');
    const timeoutP = new Promise((resolve) => {
      timer = setTimeout(() => {
        client.connection?.stream?.destroy();
        resolve('connection failed');
      }, boundMs);
    });
    const failed = await Promise.race([queryP, timeoutP]);
    if (settled) return null;
    return failed ?? 'connection failed';
  } catch {
    return 'connection failed';
  } finally {
    clearTimeout(timer);
    await endClient(client);
  }
}

function probe(open, query) {
  return probeConnection(open, query, PROBE_MS);
}

export function rootConfigured() {
  return Boolean(process.env.HARNESS_ROOT_DSN || process.env.POSTGRES_PASSWORD);
}

export async function rootProbeReason() {
  if (!rootConfigured()) return 'no root connection configured';
  const failed = await probe(() => rootClient(PROBE_MS), 'SELECT 1');
  return failed ? `root ${failed}` : null;
}

export function appConfigured() {
  return Boolean(process.env.HARNESS_DIRECT_DSN || process.env.PLERNI_APP_PASSWORD);
}

export async function directProbeReason() {
  if (!appConfigured()) return 'no direct harness database configured';
  const failed = await probe(() => openAppClient('direct', PROBE_MS), 'SELECT 1');
  return failed ? `direct harness database ${failed}` : null;
}

export function pooledConfigured() {
  return Boolean(process.env.HARNESS_POOLED_DSN || process.env.PLERNI_APP_PASSWORD);
}

export async function pooledProbeReason() {
  if (!pooledConfigured()) return 'no pooled harness database configured';
  const failed = await probe(() => openAppClient('pooled', PROBE_MS), 'SELECT 1');
  return failed ? `pooled harness database ${failed}` : null;
}

export function adminConfigured() {
  return Boolean(process.env.HARNESS_ADMIN_DSN || process.env.PLERNI_ADMIN_PASSWORD);
}

export async function adminProbeReason() {
  if (!adminConfigured()) return 'no PgBouncer admin connection configured';
  const failed = await probe(() => openAdminClient(PROBE_MS), 'SHOW VERSION');
  return failed ? `PgBouncer admin ${failed}` : null;
}

// Fail closed on any CI marker except an absent, empty, '0', or 'false' CI
// value. A non-empty GITHUB_ACTIONS is itself a marker. There is no shared
// detector in the repo; the benchmark records GITHUB_ACTIONS === 'true' only
// as a measurement label.
export function runningInCi(env = process.env) {
  const marker = env.CI;
  if (marker != null && marker !== '' && marker !== '0' && marker !== 'false') return true;
  const actions = env.GITHUB_ACTIONS;
  return actions != null && actions !== '';
}

// Local runs skip a case whose service is missing. CI is expected to have
// the harness, so a missing service stays runnable and the test fails.
export function raceSkip(missing, ci) {
  const reasons = missing.filter(Boolean);
  if (reasons.length === 0 || ci) return false;
  return reasons.join('; ');
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
      await endClient(c);
    }
  })();
  return effectsReady;
}

export async function withDirect(fn) {
  const c = openAppClient('direct');
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await endClient(c);
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

// Production commitExecution honors `renew` (T5a). A null renewal does not
// extend the lease when the wall-clock cadence fires during a slow run.
export function quietRenew() {
  return { renew: async () => null };
}

// commitExecution reports the shutdown interval. Production sets the bound
// to the cadence (plan B2 / F8: last durable renewal → COMMITTED row lock).
// A count of renewals does not check that interval: null <= 5000 is true,
// and boundViolation stays false when no renewal timestamp was recorded.
export function commitMetrics(result) {
  return {
    committed: result?.committed === true,
    renewals: result?.renewals ?? null,
    lastRenewalToLockMs: result?.lastRenewalToLockMs ?? null,
    boundViolation: result?.boundViolation ?? null,
    bound: result?.bound ?? null,
    lockWaitMs: result?.lockWaitMs ?? null,
  };
}

export function commitReportHeld(result) {
  if (result?.committed !== true) return false;
  if (result.boundViolation !== false) return false;
  if (result.bound !== CADENCE_MS) return false;
  if (!Number.isInteger(result.renewals) || result.renewals < 0) return false;
  if (!Number.isFinite(result.lockWaitMs) || result.lockWaitMs < 0) return false;
  if (result.renewals === 0) return result.lastRenewalToLockMs === null;
  return Number.isFinite(result.lastRenewalToLockMs)
    && result.lastRenewalToLockMs >= 0
    && result.lastRenewalToLockMs <= CADENCE_MS;
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
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(fragment)) throw new Error('bad lock fragment');
  const pattern = `%${fragment.replaceAll('_', '\\_')}%`;
  const c = openAppClient('direct');
  await c.connect();
  const started = Date.now();
  try {
    while (Date.now() - started < deadlineMs) {
      if (isAborted()) throw new Error('aborted');
      const r = await queryWithin(
        c,
        `SELECT pid FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE $1 ESCAPE '\\'`,
        [pattern],
      );
      if (r.rowCount > 0) return Number(r.rows[0].pid);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`deadline: no lock wait matching ${fragment}`);
  } finally {
    await endClient(c);
  }
}
