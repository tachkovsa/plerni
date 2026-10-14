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

// Main connection for effects/commits (pooled in production).
function mainConnection() {
  const dsn = process.env.HARNESS_POOLED_DSN
    ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54321/plerni`;
  return new pg.Client({ connectionString: dsn });
}

// Fallback for direct-only mode when PgBouncer auth is not working
function directConnection() {
  const dsn = process.env.HARNESS_DIRECT_DSN
    ?? `postgres://plerni_app:${envOrDie('PLERNI_APP_PASSWORD')}@localhost:54320/plerni`;
  return new pg.Client({ connectionString: dsn });
}

/**
 * Creates a new execution with QUEUED status. Sweeper never touches QUEUED.
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export async function createExecution(pluginId, token, useDirect = false) {
  const c = useDirect ? directConnection() : mainConnection();
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
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export async function dispatch(id, useDirect = false) {
  const c = useDirect ? directConnection() : mainConnection();
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
 * 4. Await in-flight renewals.
 * Returns { committed: boolean, renewals: number, lastRenewalToLockMs: number, boundViolation: boolean }.
 * @param {boolean} useDirect - use direct connection for main path (fallback when pooled unavailable)
 */
export async function commitExecution(id, token, effectsFn, useDirect = false) {
  const reserved = reservedConnection();
  await reserved.connect();
  const c = useDirect ? directConnection() : mainConnection();
  await c.connect();

  let renewalHandle;
  let renewalsStopped = false;
  let inflightRenewal = null;
  const metrics = { renewals: 0, lastRenewalAt: null };

  // BOUND: last-renewal→row-lock interval must be < CADENCE_MS (5s). If a renewal ran within
  // the cadence window, it cannot still be in flight when we take the lock (renewal queries
  // are fast, O(10ms)). A slow renewal racing the lock would block our COMMITTED update, but
  // PG serializes: one waits, then the predicate rechecks. Our WHERE status='ACTIVE' ensures
  // correctness even if the renewal is delayed.
  const LAST_RENEWAL_TO_LOCK_BOUND_MS = CADENCE_MS;

  try {
    await c.query('BEGIN');

    // Start renewal loop on the reserved path
    renewalHandle = setInterval(async () => {
      if (renewalsStopped) return;
      const renewalPromise = (async () => {
        try {
          await renew(id, reserved);
          metrics.renewals++;
          metrics.lastRenewalAt = Date.now();
        } catch (e) {
          console.warn(`renewal error: ${e.message}`);
        }
      })();
      inflightRenewal = renewalPromise;
      await renewalPromise;
      if (inflightRenewal === renewalPromise) inflightRenewal = null;
    }, CADENCE_MS);

    // Execute effects inside the transaction
    await effectsFn(c);

    // SHUTDOWN ORDERING: stop renewal scheduling immediately before the conditional update
    renewalsStopped = true;
    clearInterval(renewalHandle);
    const beforeLock = Date.now();

    // Await any in-flight renewal before taking the lock
    if (inflightRenewal) {
      await inflightRenewal;
    }

    // Conditional COMMITTED update (acquires row lock)
    const { committed, rowCount } = await conditionalCommit(id, token, c);
    if (!committed) {
      await c.query('ROLLBACK');
      throw new FencedError(`conditional COMMITTED failed: 0 rows (id=${id}, token=${token})`);
    }

    // Resolve the effects transaction
    await c.query('COMMIT');

    const lastRenewalToLockMs = metrics.lastRenewalAt ? beforeLock - metrics.lastRenewalAt : null;
    const boundViolation = lastRenewalToLockMs !== null && lastRenewalToLockMs > LAST_RENEWAL_TO_LOCK_BOUND_MS;

    return {
      committed: true,
      renewals: metrics.renewals,
      lastRenewalToLockMs,
      boundViolation,
      bound: LAST_RENEWAL_TO_LOCK_BOUND_MS,
    };
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
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export async function cancelExecution(id, useDirect = false) {
  const c = useDirect ? directConnection() : mainConnection();
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
 *
 * Uses now() (transaction start time) for the lease check, while renewals use clock_timestamp()
 * (actual current time). This is intentional: now() gives the sweeper a consistent view within
 * its transaction, and the lease margin (20s, 4× the cadence) absorbs clock skew and scheduling
 * jitter. A renewal racing the sweeper will update heartbeat_at with clock_timestamp(), and
 * PG's conflicting-update serialization ensures exactly one transition wins.
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export async function sweepAbandoned(useDirect = false) {
  const c = useDirect ? directConnection() : mainConnection();
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
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export function startSweeper(useDirect = false) {
  const handle = setInterval(async () => {
    try {
      const abandoned = await sweepAbandoned(useDirect);
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
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export async function getStatus(id, useDirect = false) {
  const c = useDirect ? directConnection() : mainConnection();
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
