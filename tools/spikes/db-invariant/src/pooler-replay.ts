// SPDX-License-Identifier: Apache-2.0
// pooler-replay.ts — issue #36. PgBouncer 1.26 tracks search_path in its built-in
// variable cache on PostgreSQL 18 (src/varcache.c), whether or not track_extra_parameters
// is empty. A surviving client session has that cache replayed onto the next backend.
// Killing an unlinked server does not clear it. Killing a linked server closes the
// client on this pooler (objects.c unlink_server). The recovery closes the client
// socket either way, then the next checkout is a new pooler session.
import { sql, type Kysely } from 'kysely';
import {
  adminShow, discardPoolerSessions, pooled, rawApp, rawAppPooled, terminateBackendByPid, type Db,
} from './client.ts';
import { MAX_RETRY, PINNED_SEARCH_PATH, withTenant } from './context.ts';
import { TENANT_A, TENANT_B } from './cases/a2-oracle.ts';
import { blankEv, drainAppBackends, onlyTenant, readRows, recordProbe } from './cases/a3-pgbouncer.ts';

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
}

interface SessionSnap {
  pid: number;
  search_path: string;
  timezone: string;
  application_name: string;
  intervalstyle: string;
  datestyle: string;
  ro: string;
  tenant_guc: string | null;
  current_user: string;
  session_user: string;
}

const SNAP_SQL = `SELECT pg_backend_pid() AS pid,
  current_setting('search_path') AS search_path,
  current_setting('TimeZone') AS timezone,
  current_setting('application_name') AS application_name,
  current_setting('IntervalStyle') AS intervalstyle,
  current_setting('DateStyle') AS datestyle,
  current_setting('default_transaction_read_only') AS ro,
  NULLIF(current_setting('plerni.tenant_id', true), '') AS tenant_guc,
  current_user, session_user`;

const TRACKED_SQL = [
  `SET search_path TO pg_catalog`,
  `SET TimeZone TO 'Asia/Tokyo'`,
  `SET application_name TO 'plerni_replay_probe'`,
  `SET IntervalStyle TO sql_standard`,
  `SET DateStyle TO 'SQL, DMY'`,
  `SET default_transaction_read_only TO on`,
] as const;

function asSnap(row: Record<string, unknown> | undefined): SessionSnap {
  if (!row) throw new Error('session read returned no row');
  const tenant = row.tenant_guc;
  return {
    pid: Number(row.pid),
    search_path: String(row.search_path),
    timezone: String(row.timezone),
    application_name: String(row.application_name),
    intervalstyle: String(row.intervalstyle),
    datestyle: String(row.datestyle),
    ro: String(row.ro),
    tenant_guc: tenant == null || tenant === '' ? null : String(tenant),
    current_user: String(row.current_user),
    session_user: String(row.session_user),
  };
}

async function snapRaw(c: Queryable): Promise<SessionSnap> {
  const r = await c.query(SNAP_SQL);
  return asSnap(r.rows[0]);
}

async function snapKysely(db: Kysely<Db>): Promise<SessionSnap> {
  const r = await sql<Record<string, unknown>>`${sql.raw(SNAP_SQL)}`.execute(db);
  return asSnap(r.rows[0]);
}

async function applyTracked(run: (text: string) => Promise<unknown>): Promise<void> {
  for (const text of TRACKED_SQL) await run(text);
}

function trackedMatch(a: SessionSnap, b: SessionSnap): boolean {
  return a.search_path === b.search_path
    && a.timezone === b.timezone
    && a.application_name === b.application_name
    && a.intervalstyle === b.intervalstyle
    && a.datestyle === b.datestyle
    && a.ro === b.ro;
}

function trackedChanged(baseline: SessionSnap, dirty: SessionSnap): boolean {
  return baseline.search_path !== dirty.search_path
    && baseline.timezone !== dirty.timezone
    && baseline.application_name !== dirty.application_name
    && baseline.intervalstyle !== dirty.intervalstyle
    && baseline.datestyle !== dirty.datestyle
    && baseline.ro !== dirty.ro;
}

/** A new direct session does not keep search_path. Pooled replay is the pooler's cache. */
async function rawNewDirectSession(): Promise<unknown> {
  const first = rawApp();
  await first.connect();
  try {
    await first.query(`SET search_path TO pg_catalog`);
    const same = await first.query(`SELECT current_setting('search_path') AS search_path`);
    const sameSession = same.rows[0]?.search_path ?? null;
    await first.end();
    const second = rawApp();
    await second.connect();
    try {
      const fresh = await second.query(`SELECT current_setting('search_path') AS search_path`);
      return { sameSession, newDirectSession: fresh.rows[0]?.search_path ?? null };
    } finally {
      await second.end();
    }
  } catch (e) {
    await first.end().catch(() => {});
    throw e;
  }
}

function shown(config: Record<string, unknown>[], key: string): { value: unknown; default: unknown; changeable: unknown } | null {
  const row = config.find((r) => r.key === key);
  if (!row) return null;
  return { value: row.value ?? null, default: row.default ?? null, changeable: row.changeable ?? null };
}

async function configProbe(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  const config = await adminShow('CONFIG') as Record<string, unknown>[];
  const versionRows = await adminShow('VERSION') as Record<string, unknown>[];
  const app = rawApp();
  await app.connect();
  let postgresVersion: string | null = null;
  try {
    const pg = await app.query(`SELECT current_setting('server_version') AS version`);
    const raw = String(pg.rows[0]?.version ?? '');
    postgresVersion = /^[0-9]+(?:\.[0-9]+)*/.exec(raw)?.[0] ?? null;
  } finally {
    await app.end();
  }
  const detail = {
    pool_mode: shown(config, 'pool_mode'),
    track_extra_parameters: shown(config, 'track_extra_parameters'),
    server_reset_query: shown(config, 'server_reset_query'),
    server_reset_query_always: shown(config, 'server_reset_query_always'),
    ignore_startup_parameters: shown(config, 'ignore_startup_parameters'),
    max_prepared_statements: shown(config, 'max_prepared_statements'),
    default_pool_size: shown(config, 'default_pool_size'),
    pgbouncerVersion: versionRows[0]?.version ?? null,
    postgresVersion,
  };
  const pass = detail.pool_mode?.value === 'transaction'
    && detail.track_extra_parameters?.value === ''
    && detail.track_extra_parameters?.changeable === 'no'
    && detail.server_reset_query?.value === 'DISCARD ALL'
    && detail.server_reset_query_always?.value === '0'
    && detail.pgbouncerVersion === 'PgBouncer 1.26.0'
    && typeof postgresVersion === 'string'
    && postgresVersion.startsWith('18.');
  return { pass, detail };
}

async function sameClientReplay(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  await drainAppBackends();
  const c = rawAppPooled();
  await c.connect();
  try {
    const baseline = await snapRaw(c);
    await applyTracked((text) => c.query(text));
    await c.query(`SELECT set_config('plerni.tenant_id', $1, false)`, [TENANT_A]);
    await c.query(`SET ROLE plerni_plugin_a`);
    const dirty = await snapRaw(c);
    await terminateBackendByPid(dirty.pid);
    const replayed = await snapRaw(c);
    const pass = baseline.search_path === PINNED_SEARCH_PATH
      && trackedChanged(baseline, dirty)
      && dirty.tenant_guc === TENANT_A
      && dirty.current_user === 'plerni_plugin_a'
      && replayed.pid !== dirty.pid
      && trackedMatch(replayed, dirty)
      && replayed.tenant_guc === baseline.tenant_guc
      && replayed.current_user === baseline.current_user
      && replayed.current_user === replayed.session_user;
    return { pass, detail: { baseline, dirty, replayed } };
  } finally {
    await c.end().catch(() => {});
    await drainAppBackends();
  }
}

async function crossClientLeak(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  await drainAppBackends();
  const a = rawAppPooled();
  const b = rawAppPooled();
  await a.connect();
  try {
    const baseline = await snapRaw(a);
    await applyTracked((text) => a.query(text));
    await a.query(`SELECT set_config('plerni.tenant_id', $1, false)`, [TENANT_A]);
    await a.query(`SET ROLE plerni_plugin_a`);
    const dirty = await snapRaw(a);
    await b.connect();
    const other = await snapRaw(b);
    const pass = other.pid === dirty.pid
      && trackedMatch(other, baseline)
      && other.search_path === PINNED_SEARCH_PATH
      && other.tenant_guc === TENANT_A
      && other.current_user === 'plerni_plugin_a'
      && other.current_user !== other.session_user;
    return { pass, detail: { baseline, dirty, other } };
  } finally {
    await b.end().catch(() => {});
    await a.end().catch(() => {});
    await drainAppBackends();
  }
}

async function activeKillClosesClient(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  await drainAppBackends();
  const c = rawAppPooled();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET search_path TO pg_catalog`);
    const open = await snapRaw(c);
    await terminateBackendByPid(open.pid);
    let follow: string | null = null;
    try {
      await c.query('SELECT 1');
      follow = 'queryable';
    } catch (e) {
      follow = e instanceof Error ? e.message : String(e);
    }
    const destroyed = c.connection?.stream?.destroyed === true;
    return {
      pass: follow !== 'queryable' && destroyed && open.search_path === 'pg_catalog',
      detail: { pid: open.pid, follow, destroyed },
    };
  } finally {
    await c.end().catch(() => {});
    await drainAppBackends();
  }
}

async function readAfterDiscard(db: Kysely<Db>): Promise<SessionSnap> {
  const deadline = performance.now() + 1000;
  let last = 'no attempt';
  for (;;) {
    try {
      return await snapKysely(db);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (performance.now() >= deadline) throw new Error(`session read after discard failed: ${last}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function discardClearsReplay(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  await drainAppBackends();
  const db = pooled(1);
  try {
    const baseline = await snapKysely(db);
    await applyTracked((text) => sql.raw(text).execute(db));
    const dirty = await snapKysely(db);
    await terminateBackendByPid(dirty.pid);
    const replayed = await snapKysely(db);
    // This probe measures the cache. It discards by hand, then polls for a clean
    // checkout, then calls withTenant. It does not exercise withTenant's discard.
    // surviving-client.test.ts is the protocol regression.
    const closed = discardPoolerSessions(db);
    const cleaned = await readAfterDiscard(db);
    const ev = blankEv();
    const rows = await withTenant(db, TENANT_B, ev, terminateBackendByPid, readRows);
    const pass = baseline.search_path === PINNED_SEARCH_PATH
      && trackedChanged(baseline, dirty)
      && replayed.pid !== dirty.pid
      && trackedMatch(replayed, dirty)
      && closed >= 1
      && trackedMatch(cleaned, baseline)
      && cleaned.search_path === PINNED_SEARCH_PATH
      && ev.terminatedBackendPids.length === 0
      && ev.alerts.length === 0
      && onlyTenant(rows, TENANT_B);
    return {
      pass,
      detail: {
        baseline, dirty, replayed, closed, cleaned,
        terminations: ev.terminatedBackendPids.length,
        alerts: ev.alerts,
        positive: onlyTenant(rows, TENANT_B),
      },
    };
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
}

interface AccessIdentity {
  pid: number;
  tenant_guc: string | null;
  current_user: string;
  session_user: string;
  search_path: string;
}

const ACCESS_SQL = `SELECT pg_backend_pid() AS pid,
  NULLIF(current_setting('plerni.tenant_id', true), '') AS tenant_guc,
  current_user, session_user,
  current_setting('search_path') AS search_path,
  'tenant-access' AS phase`;

/**
 * A second client on the backend that still holds another tenant's session GUC
 * and SET ROLE. withTenant must not run tenant access on that backend.
 */
async function withTenantRejectsLeakedIdentity(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  await drainAppBackends();
  const contaminator = rawAppPooled();
  const db = pooled(1);
  await contaminator.connect();
  try {
    await contaminator.query(`SELECT set_config('plerni.tenant_id', $1, false)`, [TENANT_A]);
    await contaminator.query(`SET ROLE plerni_plugin_a`);
    const dirty = await snapRaw(contaminator);
    const seen: AccessIdentity[] = [];
    const ev = blankEv();
    const rows = await withTenant(db, TENANT_B, ev, terminateBackendByPid, async (trx) => {
      const r = await sql<AccessIdentity>`${sql.raw(ACCESS_SQL)}`.execute(trx);
      const row = r.rows[0];
      if (!row) throw new Error('tenant access returned no identity row');
      seen.push({
        pid: Number(row.pid),
        tenant_guc: row.tenant_guc == null || row.tenant_guc === '' ? null : String(row.tenant_guc),
        current_user: String(row.current_user),
        session_user: String(row.session_user),
        search_path: String(row.search_path),
      });
      return readRows(trx);
    });
    const access = seen[0];
    const foreignAccess = seen.some((row) =>
      row.pid === dirty.pid
      || row.tenant_guc === TENANT_A
      || row.tenant_guc !== TENANT_B
      || row.current_user !== row.session_user
      || row.current_user === 'plerni_plugin_a'
      || row.current_user !== 'plerni_app'
      || row.search_path !== PINNED_SEARCH_PATH);
    const accessClean = seen.length === 1 && access !== undefined && !foreignAccess;
    const sawLeak = ev.alerts.some((alert) =>
      alert.includes(String(dirty.pid))
      && alert.includes(TENANT_A)
      && alert.includes('role leaked')
      && alert.includes('plerni_plugin_a'));
    const pass = dirty.tenant_guc === TENANT_A
      && dirty.current_user === 'plerni_plugin_a'
      && dirty.current_user !== dirty.session_user
      && sawLeak
      && ev.terminatedBackendPids.includes(dirty.pid)
      && ev.terminatedBackendPids.length <= MAX_RETRY
      && ev.attempts <= MAX_RETRY + 1
      && accessClean
      && onlyTenant(rows, TENANT_B);
    return {
      pass,
      detail: {
        dirtyPid: dirty.pid,
        seen,
        attempts: ev.attempts,
        terminations: ev.terminatedBackendPids.length,
        discardedPoolerSessions: ev.discardedPoolerSessions,
        alerts: ev.alerts,
        positive: onlyTenant(rows, TENANT_B),
      },
    };
  } finally {
    await contaminator.end().catch(() => {});
    await db.destroy();
    await drainAppBackends();
  }
}

export async function poolerReplay(): Promise<void> {
  try {
    await recordProbe(
      { case: 'pooler admin config', datasource: 'admin' },
      configProbe,
      rawNewDirectSession,
    );
    await recordProbe(
      { case: 'pooler same-client replay', datasource: 'pooled' },
      sameClientReplay,
      rawNewDirectSession,
    );
    await recordProbe(
      { case: 'pooler cross-client session leak', datasource: 'pooled' },
      crossClientLeak,
      rawNewDirectSession,
    );
    await recordProbe(
      { case: 'pooler withTenant rejects leaked identity', datasource: 'pooled(1)' },
      withTenantRejectsLeakedIdentity,
      rawNewDirectSession,
    );
    await recordProbe(
      { case: 'pooler active terminate closes the client', datasource: 'pooled' },
      activeKillClosesClient,
      rawNewDirectSession,
    );
    await recordProbe(
      { case: 'pooler discard clears replay', datasource: 'pooled(1)' },
      discardClearsReplay,
      rawNewDirectSession,
    );
  } finally {
    await drainAppBackends();
  }
}
