// Test-only authority for the race battery. The production module
// (../authority.mjs, owned by T5a) stays free of clock, barrier, and
// vacuity parameters. This file owns those controls.
//
// The no-option SQL text is the production statement. A tag is a comment
// so a barrier can see its own query in pg_stat_activity. requireActive
// false is the vacuity variant and is never a production call.
// Cadence and lease match the spike pins in authority.mjs (5s / 20s).

import pg from 'pg';
import { FencedError } from '../authority.mjs';
import { COMPLETION_BOUND_MS } from './clock.mjs';

export const CADENCE_MS = 5000;
export const LEASE_MS = 20000;

function sqlComment(tag) {
  if (tag == null) return '';
  if (typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag)) {
    throw new Error('sql tag must match [a-z0-9-]{1,40}');
  }
  return ` /* ${tag} */`;
}

export function committedSql({ requireActive = true, tag = null } = {}) {
  const status = requireActive ? ` AND status = 'ACTIVE'` : '';
  return `UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2${status} RETURNING clock_timestamp() AS locked_at${sqlComment(tag)}`;
}

export function renewSql({ clocked = false, tag = null } = {}) {
  const stamp = clocked ? '$3' : 'clock_timestamp()';
  const returning = clocked ? 'heartbeat_at' : 'clock_timestamp()';
  return `UPDATE fencing_authority SET heartbeat_at = ${stamp} WHERE id = $1 AND token = $2 AND status = 'ACTIVE' RETURNING ${returning} AS renewed_at${sqlComment(tag)}`;
}

export function sweepSql({ requireActive = true, clocked = false, scoped = false, tag = null } = {}) {
  const status = requireActive ? `status = 'ACTIVE' AND ` : '';
  const nowExpr = clocked ? '$2::timestamptz' : 'now()';
  const idClause = scoped ? (clocked ? ' AND id = $3' : ' AND id = $2') : '';
  return `UPDATE fencing_authority SET status = 'ABANDONED' WHERE ${status}heartbeat_at < ${nowExpr} - make_interval(secs => $1)${idClause} RETURNING id${sqlComment(tag)}`;
}

function appClient(pooled) {
  const dsn = pooled ? process.env.HARNESS_POOLED_DSN : process.env.HARNESS_DIRECT_DSN;
  const client = dsn
    ? new pg.Client({ connectionString: dsn })
    : new pg.Client({
      host: 'localhost',
      port: pooled ? 54321 : 54320,
      database: 'plerni',
      user: 'plerni_app',
      password: process.env.PLERNI_APP_PASSWORD,
    });
  client.on('error', () => {});
  return client;
}

export function openAppClient(kind = 'direct') {
  if (kind !== 'direct' && kind !== 'reserved' && kind !== 'pooled') {
    throw new Error('unknown harness client kind');
  }
  return appClient(kind === 'pooled');
}

function destroy(client) {
  client?.connection?.stream?.destroy();
}

// Settles with the value, or with a deadline error that has already cancelled
// the clients. A fenced error keeps the elapsed time so the case can record it.
async function until(work, ms, label, cancel) {
  const started = Date.now();
  let timedOut = false;
  const task = Promise.resolve().then(work).then(
    (value) => ({ kind: 'value', value }),
    (error) => ({ kind: 'error', error }),
  );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { cancel?.(); } catch { /* the deadline is the failure */ }
      resolve({ kind: 'timeout' });
    }, ms);
  });
  const outcome = await Promise.race([task, timeout]);
  clearTimeout(timer);
  const elapsedMs = Date.now() - started;
  if (outcome.kind === 'value') {
    if (elapsedMs > ms) throw new Error(`bound exceeded: ${label} (${elapsedMs}ms)`);
    return { value: outcome.value, elapsedMs, boundMs: ms };
  }
  if (timedOut || outcome.kind === 'timeout') {
    throw new Error(`deadline exceeded: ${label} (bound ${ms}ms)`);
  }
  outcome.error.elapsedMs = elapsedMs;
  outcome.error.boundMs = ms;
  throw outcome.error;
}

async function arm(client, boundMs) {
  await client.connect();
  const limit = String(boundMs + 1000);
  await client.query('SELECT set_config($1, $2, false)', ['lock_timeout', limit]);
  await client.query('SELECT set_config($1, $2, false)', ['statement_timeout', limit]);
}

function remember(bounds, label, elapsedMs, boundMs) {
  bounds?.push({ label, elapsedMs, boundMs });
}

export async function stampHeartbeat(id, when, bounds, boundMs = COMPLETION_BOUND_MS) {
  const client = openAppClient('direct');
  const label = 'stamp heartbeat';
  const result = await until(async () => {
    try {
      await arm(client, boundMs);
      const updated = await client.query(
        `UPDATE fencing_authority SET heartbeat_at = $2 WHERE id = $1 AND status = 'ACTIVE'`,
        [id, when],
      );
      if (updated.rowCount !== 1) throw new Error('stamp heartbeat matched no row');
    } finally {
      await client.end().catch(() => {});
    }
  }, boundMs, label, () => destroy(client));
  remember(bounds, label, result.elapsedMs, result.boundMs);
}

// Harness commit: same shutdown order as the production executor, plus the
// race controls (manual clock, lock barrier, renewal parked behind the update,
// vacuity predicate). Renewals use the direct connection. Effects use the
// pooled datasource unless useDirect is set.
export async function raceCommit(id, token, effectsFn, useDirect = false, options = {}) {
  const boundMs = options.boundMs ?? COMPLETION_BOUND_MS;
  const label = options.label ?? 'race commit';
  const clock = options.clock ?? null;
  const schedule = clock ?? { setInterval, clearInterval };
  const renewFn = options.renew ?? (async (rowId, rowToken, reserved, ctl) => {
    if (ctl?.stop) return null;
    if (clock) {
      const now = await clock.now();
      const updated = await reserved.query(renewSql({ clocked: true }), [rowId, rowToken, now]);
      return updated.rowCount === 1 ? updated.rows[0].renewed_at : null;
    }
    const updated = await reserved.query(renewSql(), [rowId, rowToken]);
    return updated.rowCount === 1 ? updated.rows[0].renewed_at : null;
  });
  const beforeCommit = options.beforeCommit ?? (async () => {});
  const reserved = openAppClient('reserved');
  const main = openAppClient(useDirect ? 'direct' : 'pooled');
  const cancel = () => {
    destroy(reserved);
    destroy(main);
  };
  if (typeof options.register === 'function') options.register(cancel);

  let renewalHandle;
  let renewalsStopped = false;
  let inflight = null;
  let parked = null;
  const renewalCtl = { stop: false };

  const run = async () => {
    try {
      await arm(reserved, boundMs);
      renewalHandle = schedule.setInterval(async () => {
        if (renewalsStopped || inflight) return;
        const current = (async () => {
          if (renewalCtl.stop) return;
          await renewFn(id, token, reserved, renewalCtl);
        })();
        inflight = current;
        try {
          await current;
        } finally {
          if (inflight === current) inflight = null;
        }
      }, CADENCE_MS);

      await arm(main, boundMs);
      await main.query('BEGIN');
      await effectsFn(main);

      renewalsStopped = true;
      schedule.clearInterval(renewalHandle);
      await beforeCommit();
      const committed = await main.query(
        committedSql({ requireActive: options.requireActive !== false, tag: options.tag ?? null }),
        [id, token],
      );
      if (committed.rowCount !== 1) {
        await main.query('ROLLBACK');
        if (inflight) await inflight;
        if (parked) await parked;
        throw new FencedError(`conditional COMMITTED failed: 0 rows (id=${id})`);
      }
      if (options.renewBehindLock) {
        if (inflight) throw new Error('renewBehindLock while a renewal is in flight');
        parked = renewFn(id, token, reserved, renewalCtl);
      }
      if (options.afterLock) await options.afterLock();
      await main.query('COMMIT');
      if (options.afterCommit) await options.afterCommit();
      if (inflight) await inflight;
      if (parked) await parked;
      return { committed: true };
    } catch (err) {
      renewalsStopped = true;
      if (renewalHandle) schedule.clearInterval(renewalHandle);
      renewalCtl.stop = true;
      if (!(err instanceof FencedError)) await main.query('ROLLBACK').catch(() => {});
      if (inflight) await inflight.catch(() => {});
      if (parked) await parked.catch(() => {});
      throw err;
    } finally {
      if (renewalHandle) schedule.clearInterval(renewalHandle);
      await reserved.end().catch(() => {});
      await main.end().catch(() => {});
    }
  };

  try {
    const result = await until(run, boundMs, label, cancel);
    remember(options.bounds, label, result.elapsedMs, result.boundMs);
    return { ...result.value, elapsedMs: result.elapsedMs, boundMs: result.boundMs };
  } catch (err) {
    if (err instanceof FencedError && err.boundMs != null) {
      remember(options.bounds, label, err.elapsedMs, err.boundMs);
    }
    throw err;
  }
}

// Harness sweep. afterLock holds the update open so the other side can observe
// the row lock. now / id / requireActive are race controls, not production arguments.
export async function raceSweep(useDirect = false, options = {}) {
  const boundMs = options.boundMs ?? COMPLETION_BOUND_MS;
  const label = options.label ?? 'race sweep';
  const client = openAppClient(useDirect ? 'direct' : 'pooled');
  const hold = typeof options.afterLock === 'function';
  const clocked = options.now != null;
  const scoped = options.id != null;
  const requireActive = options.requireActive !== false;
  const sql = sweepSql({ requireActive, clocked, scoped, tag: options.tag ?? null });
  const params = [LEASE_MS / 1000];
  if (clocked) params.push(options.now);
  if (scoped) params.push(options.id);

  const run = async () => {
    let began = false;
    try {
      await arm(client, boundMs);
      if (hold) {
        await client.query('BEGIN');
        began = true;
      }
      const updated = await client.query(sql, params);
      const ids = updated.rows.map((row) => row.id);
      if (began) {
        await options.afterLock(ids);
        await client.query('COMMIT');
        began = false;
      }
      return ids;
    } catch (err) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await client.end().catch(() => {});
    }
  };

  const result = await until(run, boundMs, label, () => destroy(client));
  remember(options.bounds, label, result.elapsedMs, result.boundMs);
  return { ids: result.value, elapsedMs: result.elapsedMs, boundMs: result.boundMs };
}
