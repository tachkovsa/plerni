// authority.mjs — Five-state fencing authority per plan §4 B2.
// QUEUED→ACTIVE→COMMITTED|CANCELLED|ABANDONED + heartbeat (reserved path) + sweeper + shutdown ordering.
//
// Lifecycle: QUEUED at submission (sweeper never touches QUEUED work — queued longer than lease
// is still queued, not abandoned). Dispatch: QUEUED→ACTIVE stamps heartbeat_at. Executor commit:
// effects + conditional COMMITTED update in one transaction. Revocation: competing CANCELLED.
// Sweeper: conditional ABANDONED on expired lease.
//
// Heartbeat/lease: cadence 5s, lease 20s (≥ 3× cadence + max scheduling delay). Renewals use
// the RESERVED PATH (dedicated direct connection on 5432, never the main pooled datasource).
// Heartbeats never travel inside the effects transaction.
//
// Shutdown ordering: stop renewal scheduling immediately before issuing the conditional COMMITTED
// update → resolve the effects transaction → drain outstanding renewals. Last-renewal→row-lock
// interval bounded and recorded.

import pg from 'pg';

const CADENCE_MS = 5000;
const LEASE_MS = 20000;
const SWEEP_INTERVAL_MS = 3000;

export class AuthorityError extends Error {}
export class FencedError extends AuthorityError {}

function envOrDie(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`spike: missing env var ${name}`);
    process.exit(1);
  }
  return v;
}

// RESERVED PATH: dedicated direct connection for renewals (never shares the main pool).
function reservedConnection() {
  const dsn = process.env.HARNESS_DIRECT_DSN
    ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54320/plerni`;
  return new pg.Client({ connectionString: dsn });
}

// Main connection for effects/commits (pooled).
function mainConnection() {
  const dsn = process.env.HARNESS_POOLED_DSN
    ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54321/plerni`;
  return new pg.Client({ connectionString: dsn });
}

/**
 * Creates a new execution with QUEUED status. Sweeper never touches QUEUED.
 */
export async function createExecution(pluginId, token) {
  const c = mainConnection();
  await c.connect();
  try {
    const r = await c.query(
      `INSERT INTO fencing_authority (id, plugin_id, token, status) VALUES (gen_random_uuid(), $1, $2, 'QUEUED') RETURNING id`,
      [pluginId, token]
    );
    return r.rows[0].id;
  } finally {
    await c.end();
  }
}

/**
 * Dispatch transition: QUEUED→ACTIVE, stamps heartbeat_at.
 */
export async function dispatch(id) {
  const c = mainConnection();
  await c.connect();
  try {
    const r = await c.query(
      `UPDATE fencing_authority SET status = 'ACTIVE', heartbeat_at = clock_timestamp() WHERE id = $1 AND status = 'QUEUED' RETURNING id`,
      [id]
    );
    if (r.rowCount === 0) throw new AuthorityError(`dispatch failed: id=${id} not QUEUED`);
  } finally {
    await c.end();
  }
}

/**
 * Executor: heartbeat renewal on the reserved path.
 */
async function renew(id, reserved) {
  await reserved.query(
    `UPDATE fencing_authority SET heartbeat_at = clock_timestamp() WHERE id = $1 AND status = 'ACTIVE'`,
    [id]
  );
}

/**
 * Executor: conditional COMMITTED update. Returns { committed: boolean, rowCount: number }.
 */
async function conditionalCommit(id, token, c) {
  const r = await c.query(
    `UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING id`,
    [id, token]
  );
  return { committed: r.rowCount === 1, rowCount: r.rowCount };
}

/**
 * Executor commit protocol with shutdown ordering.
 * 1. Stop renewal scheduling immediately before the conditional COMMITTED update.
 * 2. Issue the conditional COMMITTED update (acquires the row lock).
 * 3. Resolve the effects transaction.
 * 4. Drain outstanding renewals.
 * Returns { committed: boolean, lastRenewalToLockMs: number }.
 */
export async function commitExecution(id, token, effectsFn) {
  const reserved = reservedConnection();
  await reserved.connect();
  const c = mainConnection();
  await c.connect();

  let renewalHandle;
  let renewalsStopped = false;
  const metrics = { renewals: 0, lastRenewalAt: null };

  try {
    await c.query('BEGIN');

    // Start renewal loop on the reserved path
    renewalHandle = setInterval(async () => {
      if (renewalsStopped) return;
      try {
        await renew(id, reserved);
        metrics.renewals++;
        metrics.lastRenewalAt = Date.now();
      } catch (e) {
        console.warn(`renewal error: ${e.message}`);
      }
    }, CADENCE_MS);

    // Execute effects inside the transaction
    await effectsFn(c);

    // SHUTDOWN ORDERING: stop renewal scheduling immediately before the conditional update
    renewalsStopped = true;
    clearInterval(renewalHandle);
    const beforeLock = Date.now();

    // Conditional COMMITTED update (acquires row lock)
    const { committed, rowCount } = await conditionalCommit(id, token, c);
    if (!committed) {
      await c.query('ROLLBACK');
      throw new FencedError(`conditional COMMITTED failed: 0 rows (id=${id}, token=${token})`);
    }

    // Resolve the effects transaction
    await c.query('COMMIT');

    // Drain outstanding renewals (none should be scheduled, but wait for any in-flight)
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lastRenewalToLockMs = metrics.lastRenewalAt ? beforeLock - metrics.lastRenewalAt : null;

    return { committed: true, renewals: metrics.renewals, lastRenewalToLockMs };
  } catch (e) {
    if (e instanceof FencedError) throw e;
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (renewalHandle) clearInterval(renewalHandle);
    await reserved.end();
    await c.end();
  }
}

/**
 * Revocation: conditional CANCELLED update. Returns true if the transition won.
 */
export async function cancelExecution(id) {
  const c = mainConnection();
  await c.connect();
  try {
    const r = await c.query(
      `UPDATE fencing_authority SET status = 'CANCELLED' WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
      [id]
    );
    return r.rowCount === 1;
  } finally {
    await c.end();
  }
}

/**
 * Sweeper: conditional ABANDONED on expired lease. Runs periodically.
 * QUEUED work is never abandoned (queued past lease stays QUEUED).
 */
export async function sweepAbandoned() {
  const c = mainConnection();
  await c.connect();
  try {
    const r = await c.query(
      `UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < now() - interval '${LEASE_MS} milliseconds' RETURNING id`,
      []
    );
    return r.rows.map((row) => row.id);
  } finally {
    await c.end();
  }
}

/**
 * Starts a background sweeper that runs every SWEEP_INTERVAL_MS.
 */
export function startSweeper() {
  const handle = setInterval(async () => {
    try {
      const abandoned = await sweepAbandoned();
      if (abandoned.length > 0) {
        console.log(`[sweeper] marked ${abandoned.length} executions ABANDONED`);
      }
    } catch (e) {
      console.warn(`[sweeper] error: ${e.message}`);
    }
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(handle);
}

/**
 * Query the current status of an execution.
 */
export async function getStatus(id) {
  const c = mainConnection();
  await c.connect();
  try {
    const r = await c.query(
      `SELECT status, heartbeat_at, created_at FROM fencing_authority WHERE id = $1`,
      [id]
    );
    return r.rows[0] ?? null;
  } finally {
    await c.end();
  }
}
