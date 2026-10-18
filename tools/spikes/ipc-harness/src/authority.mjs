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

function epochMs(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
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
  if (process.env.HARNESS_DIRECT_DSN) {
    return new pg.Client({ connectionString: process.env.HARNESS_DIRECT_DSN });
  }
  return new pg.Client({
    host: 'localhost',
    port: 54320,
    database: 'plerni',
    user: 'plerni_app',
    password: envOrDie('PLERNI_APP_PASSWORD'),
  });
}

// Main connection for effects/commits (pooled through PgBouncer).
function mainConnection() {
  if (process.env.HARNESS_POOLED_DSN) {
    return new pg.Client({ connectionString: process.env.HARNESS_POOLED_DSN });
  }
  return new pg.Client({
    host: 'localhost',
    port: 54321,
    database: 'plerni',
    user: 'plerni_app',
    password: envOrDie('PLERNI_APP_PASSWORD'),
  });
}

// Direct connection fallback (for VMs where PgBouncer setup fails).
function directConnection() {
  if (process.env.HARNESS_DIRECT_DSN) {
    return new pg.Client({ connectionString: process.env.HARNESS_DIRECT_DSN });
  }
  return new pg.Client({
    host: 'localhost',
    port: 54320,
    database: 'plerni',
    user: 'plerni_app',
    password: envOrDie('PLERNI_APP_PASSWORD'),
  });
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
 * Returns the server timestamp if exactly 1 ACTIVE row with this token was updated, null otherwise.
 * The token is part of the predicate so a stale holder who only knows the id cannot extend the lease.
 */
async function renew(id, token, reserved) {
  const r = await reserved.query(
    `UPDATE fencing_authority SET heartbeat_at = clock_timestamp() WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS renewed_at`,
    [id, token]
  );
  return r.rowCount === 1 ? r.rows[0].renewed_at : null;
}

/**
 * One renewal on the reserved path. Returns the server timestamp, or null when the token lost.
 * Renewals always use the reserved connection; the pooled flag does not apply.
 */
export async function renewExecution(id, token) {
  const reserved = reservedConnection();
  await reserved.connect();
  try {
    return await renew(id, token, reserved);
  } finally {
    await reserved.end();
  }
}

/**
 * Executor: conditional COMMITTED update.
 * Returns { committed, lockedAt } where lockedAt is the server clock at the update.
 */
async function conditionalCommit(id, token, c) {
  const r = await c.query(
    `UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING clock_timestamp() AS locked_at`,
    [id, token]
  );
  return { committed: r.rowCount === 1, lockedAt: r.rowCount === 1 ? r.rows[0].locked_at : null };
}

/**
 * Executor commit protocol with shutdown ordering.
 * 1. Stop renewal scheduling immediately before the conditional COMMITTED update.
 * 2. Issue the conditional COMMITTED update (acquires the row lock).
 * 3. Resolve the effects transaction.
 * 4. Await in-flight renewals.
 * Returns { committed: boolean, renewals: number, lastRenewalToLockMs: number, boundViolation: boolean }.
 * @param {boolean} useDirect - use direct connection for main path (fallback when pooled unavailable)
 * @param {{ renew?: Function, beforeCommit?: Function }} [options]
 *   renew replaces the heartbeat update (smoke passes the slow-lock override).
 *   beforeCommit runs after scheduling stops and before the COMMITTED update.
 */
export async function commitExecution(id, token, effectsFn, useDirect = false, options = {}) {
  const renewFn = options.renew ?? renew;
  const beforeCommit = options.beforeCommit ?? (async () => {});
  const reserved = reservedConnection();
  await reserved.connect();

  let renewalHandle;
  let renewalsStopped = false;
  let inflightRenewal = null;
  const metrics = { renewals: 0, lastRenewalAt: null };
  const renewalCtl = { stop: false };

  // BOUND: last durable renewal and the COMMITTED update are both clock_timestamp()
  // values from PostgreSQL, so the interval does not depend on which client callback runs first.
  const LAST_RENEWAL_TO_LOCK_BOUND_MS = CADENCE_MS;

  // Start renewal loop on the reserved path BEFORE waiting on the pooled connection
  // (under pool saturation, the lease could expire before renewals start)
  // Single-flight: skip ticks if previous renewal still in progress
  renewalHandle = setInterval(async () => {
    if (renewalsStopped || inflightRenewal) return;
    const renewalPromise = (async () => {
      try {
        const renewalCompletedAt = await renewFn(id, token, reserved, renewalCtl);
        if (renewalCompletedAt) {
          // Count only durable renewals (1-row UPDATEs)
          metrics.renewals++;
          metrics.lastRenewalAt = renewalCompletedAt;
        }
      } catch (e) {
        console.warn(`[renewal] error: ${e.message}`);
      }
    })();
    inflightRenewal = renewalPromise;
    await renewalPromise;
    if (inflightRenewal === renewalPromise) inflightRenewal = null;
  }, CADENCE_MS);

  const c = useDirect ? directConnection() : mainConnection();
  try {
    await c.connect();
    await c.query('BEGIN');

    // Execute effects inside the transaction
    await effectsFn(c);

    // SHUTDOWN ORDERING per plan line 158:
    // 1. Stop renewal scheduling
    renewalsStopped = true;
    clearInterval(renewalHandle);

    // 2. Optional test hook, then the conditional COMMITTED update (acquires row lock).
    await beforeCommit();
    const commitAttemptAt = Date.now();
    const { committed, lockedAt } = await conditionalCommit(id, token, c);
    const lockWaitMs = Date.now() - commitAttemptAt;
    if (!committed) {
      await c.query('ROLLBACK');
      // Drain any renewal still blocked on the row lock
      if (inflightRenewal) await inflightRenewal;
      throw new FencedError(`conditional COMMITTED failed: 0 rows (id=${id})`);
    }

    // 3. Resolve (COMMIT) the effects transaction
    await c.query('COMMIT');

    // 4. THEN drain renewals (renewal blocked on the lock can now proceed and fail benignly)
    if (inflightRenewal) {
      await inflightRenewal;
    }

    const lockMs = epochMs(lockedAt);
    const renewedMs = epochMs(metrics.lastRenewalAt);
    const lastRenewalToLockMs = lockMs !== null && renewedMs !== null ? lockMs - renewedMs : null;
    const boundViolation = lastRenewalToLockMs !== null && lastRenewalToLockMs > LAST_RENEWAL_TO_LOCK_BOUND_MS;

    return {
      committed: true,
      renewals: metrics.renewals,
      lastRenewalToLockMs,
      boundViolation,
      bound: LAST_RENEWAL_TO_LOCK_BOUND_MS,
      lockWaitMs,
    };
  } catch (e) {
    renewalsStopped = true;
    if (renewalHandle) clearInterval(renewalHandle);
    renewalCtl.stop = true;
    if (!(e instanceof FencedError)) {
      await c.query('ROLLBACK').catch(() => {});
    }
    if (inflightRenewal) await inflightRenewal;
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
    // make_interval's duration argument is secs (double precision). PostgreSQL 18
    // has no msecs parameter: https://www.postgresql.org/docs/18/functions-datetime.html
    const r = await c.query(
      `UPDATE fencing_authority SET status = 'ABANDONED' WHERE status = 'ACTIVE' AND heartbeat_at < now() - make_interval(secs => $1) RETURNING id`,
      [LEASE_MS / 1000]
    );
    return r.rows.map((row) => row.id);
  } finally {
    await c.end();
  }
}

/**
 * Starts a background sweeper that runs every SWEEP_INTERVAL_MS.
 * Single-flight: no overlapping iterations.
 * @param {boolean} useDirect - use direct connection (fallback when pooled unavailable)
 */
export function startSweeper(useDirect = false) {
  let inFlight = false;
  const handle = setInterval(async () => {
    if (inFlight) return; // skip overlapping iterations
    inFlight = true;
    try {
      const abandoned = await sweepAbandoned(useDirect);
      if (abandoned.length > 0) {
        console.log(`[sweeper] marked ${abandoned.length} executions ABANDONED`);
      }
    } catch (e) {
      console.warn(`[sweeper] error: ${e.message}`);
    } finally {
      inFlight = false;
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
