// SPDX-License-Identifier: Apache-2.0
// Controlled driver for issue #36. On this PgBouncer a kill while the server is
// linked closes the client, so the in-transaction battery records
// discardedPoolerSessions 0 and would still pass if withTenant stopped discarding.
// This driver keeps the socket open across the kill and replays search_path onto
// the next backend until that socket is destroyed. withTenant is the only cleanup.
// There is no sleep and no outside discard.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sql, type Kysely } from 'kysely';
import type pg from 'pg';
import { kyselyOfPool, type Db } from './client.ts';
import { MAX_RETRY, PINNED_SEARCH_PATH, withTenant, type HygieneEvidence } from './context.ts';
import { TENANT_A, TENANT_B } from './cases/a2-oracle.ts';

const SESSION_USER = 'plerni_app';
const LEAKED_ROLE = 'plerni_plugin_a';

interface Backend {
  pid: number;
  tenant_guc: string | null;
  current_user: string;
  session_user: string;
  dead: boolean;
}

interface AccessRow {
  phase: string;
  tenant_guc: string | null;
  session_tenant: string | null;
  current_user: string;
  session_user: string;
  search_path: string;
  pid: number;
}

interface FakeClient {
  connection: { stream: { destroyed: boolean; destroy: () => void } };
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  release: () => void;
  on: (event: string, cb: (err: Error) => void) => FakeClient;
}

interface Session {
  client: FakeClient;
  varcache: { search_path: string };
  leakArmed: boolean;
  backend: Backend | null;
  localTenant: string | null;
  checkedOut: boolean;
}

class SurvivingClientPool {
  readonly _clients: FakeClient[] = [];
  private readonly sessions: Session[] = [];
  private nextPid = 1;

  constructor(seed: { searchPath: string; leak: boolean }) {
    this.add(seed.searchPath, seed.leak);
  }

  /** Kill the backend and leave the client socket up. The variable cache stays. */
  readonly terminate = async (pid: number): Promise<void> => {
    const session = this.sessions.find((s) => s.backend?.pid === pid && s.backend.dead === false);
    if (!session?.backend) throw new Error(`backend ${pid} was not live`);
    session.backend.dead = true;
  };

  async connect(): Promise<FakeClient> {
    const live = this.sessions.find((s) => !s.client.connection.stream.destroyed && !s.checkedOut);
    const session = live ?? this.add(PINNED_SEARCH_PATH, false);
    session.checkedOut = true;
    return session.client;
  }

  async end(): Promise<void> {}

  on(): this {
    return this;
  }

  private add(searchPath: string, leak: boolean): Session {
    const stream = {
      destroyed: false,
      destroy: () => { stream.destroyed = true; },
    };
    const session: Session = {
      client: undefined as unknown as FakeClient,
      varcache: { search_path: searchPath },
      leakArmed: leak,
      backend: null,
      localTenant: null,
      checkedOut: false,
    };
    const client: FakeClient = {
      connection: { stream },
      on: () => client,
      release: () => { session.checkedOut = false; },
      query: (text, values) => this.query(session, text, values),
    };
    session.client = client;
    this.sessions.push(session);
    this._clients.push(client);
    return session;
  }

  private link(session: Session): Backend {
    const leak = session.leakArmed;
    session.leakArmed = false;
    const backend: Backend = {
      pid: this.nextPid,
      tenant_guc: leak ? TENANT_A : null,
      current_user: leak ? LEAKED_ROLE : SESSION_USER,
      session_user: SESSION_USER,
      dead: false,
    };
    this.nextPid += 1;
    return backend;
  }

  private async query(session: Session, text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    if (session.client.connection.stream.destroyed) throw death();
    const statement = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (statement === 'begin') {
      if (!session.backend || session.backend.dead) session.backend = this.link(session);
      session.localTenant = null;
      return { rows: [], rowCount: 0 };
    }
    if (!session.backend || session.backend.dead) throw death();
    if (statement === 'commit' || statement === 'rollback') {
      session.localTenant = null;
      return { rows: [], rowCount: 0 };
    }
    if (statement === 'select 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (statement.includes('set_config')) {
      const tenant = values?.[0];
      if (typeof tenant !== 'string' || !statement.includes(', true)')) {
        throw new Error(`unexpected set_config: ${text}`);
      }
      session.localTenant = tenant;
      return { rows: [{ set_config: tenant }], rowCount: 1 };
    }
    if (statement.includes('tenant-access') || statement.includes("current_setting('plerni.tenant_id'")) {
      return { rows: [this.snapshot(session, statement.includes('tenant-access'))], rowCount: 1 };
    }
    throw new Error(`unrecognized SQL: ${text}`);
  }

  private snapshot(session: Session, access: boolean): Record<string, unknown> {
    const backend = session.backend;
    if (!backend) throw death();
    const effective = session.localTenant ?? backend.tenant_guc;
    const row: Record<string, unknown> = {
      tenant_guc: effective,
      current_user: backend.current_user,
      session_user: backend.session_user,
      search_path: session.varcache.search_path,
      pid: backend.pid,
    };
    if (access) {
      // Session-level value, not the transaction-local override. current_setting
      // cannot show it once set_config(..., true) has masked it.
      row.phase = 'tenant-access';
      row.session_tenant = backend.tenant_guc;
    }
    return row;
  }
}

function death(): Error {
  return new Error('server conn crashed?');
}

function blankEv(): HygieneEvidence {
  return { terminatedBackendPids: [], attempts: 0, alerts: [], discardedPoolerSessions: 0 };
}

function poolFor(seed: { searchPath: string; leak: boolean }): { db: Kysely<Db>; pool: SurvivingClientPool } {
  const pool = new SurvivingClientPool(seed);
  const db = kyselyOfPool(pool as unknown as pg.Pool);
  return { db, pool };
}

const ACCESS = sql<AccessRow>`SELECT 'tenant-access' AS phase,
  current_setting('plerni.tenant_id', true) AS tenant_guc,
  NULL::text AS session_tenant,
  current_user, session_user,
  current_setting('search_path') AS search_path,
  pg_backend_pid() AS pid`;

function assertCleanAccess(row: AccessRow | undefined): void {
  assert.ok(row, 'tenant access did not run');
  assert.equal(row.phase, 'tenant-access');
  assert.equal(row.tenant_guc, TENANT_B);
  assert.equal(row.session_tenant, null);
  assert.notEqual(row.tenant_guc, TENANT_A);
  assert.notEqual(row.session_tenant, TENANT_A);
  assert.equal(row.current_user, SESSION_USER);
  assert.equal(row.session_user, SESSION_USER);
  assert.notEqual(row.current_user, LEAKED_ROLE);
  assert.equal(row.search_path, PINNED_SEARCH_PATH);
}

test('withTenant discards a surviving client and recovers inside the retry budget', async () => {
  const { db, pool } = poolFor({ searchPath: 'pg_catalog', leak: true });
  const ev = blankEv();
  const seen: AccessRow[] = [];
  const row = await withTenant(db, TENANT_B, ev, pool.terminate, async (trx) => {
    const r = await ACCESS.execute(trx);
    const access = r.rows[0];
    if (access) seen.push(access);
    return access;
  });
  assert.equal(seen.length, 1);
  assertCleanAccess(row);
  assert.equal(row?.pid, seen[0]?.pid);
  assert.ok(ev.discardedPoolerSessions >= 1);
  assert.equal(ev.terminatedBackendPids.length, 1);
  assert.notEqual(row?.pid, ev.terminatedBackendPids[0]);
  assert.equal(ev.attempts, 2);
  assert.ok(ev.attempts <= MAX_RETRY + 1);
  assert.ok(ev.alerts.some((alert) => alert.includes('search_path') && alert.includes(TENANT_A) && alert.includes('role leaked')));
  await db.destroy();
});

test('withTenant does not run access on another tenant id or a leaked role', async () => {
  const { db, pool } = poolFor({ searchPath: PINNED_SEARCH_PATH, leak: true });
  const ev = blankEv();
  const seen: AccessRow[] = [];
  const row = await withTenant(db, TENANT_B, ev, pool.terminate, async (trx) => {
    const r = await ACCESS.execute(trx);
    const access = r.rows[0];
    if (access) seen.push(access);
    return access;
  });
  assert.equal(seen.length, 1);
  assertCleanAccess(row);
  assert.notEqual(row?.pid, ev.terminatedBackendPids[0]);
  assert.ok(ev.alerts.some((alert) => alert.includes(TENANT_A) && alert.includes('role leaked') && alert.includes(LEAKED_ROLE)));
  assert.ok(!ev.alerts.some((alert) => alert.includes('search_path')));
  assert.ok(ev.attempts <= MAX_RETRY + 1);
  assert.ok(ev.terminatedBackendPids.length >= 1);
  assert.ok(ev.terminatedBackendPids.length <= MAX_RETRY);
  await db.destroy();
});
