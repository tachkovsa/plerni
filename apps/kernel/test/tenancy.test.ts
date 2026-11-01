// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { sql, type Kysely, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from '../src/db/database.ts';
import { MissingTenantContextError } from '../src/tenancy/errors.ts';
import { assertTenantContext } from '../src/tenancy/guard.ts';
import { MAX_RETRY } from '../src/tenancy/constants.ts';
import { blankEvidence, withTenant, type HygieneEvidence } from '../src/tenancy/hygiene.ts';
import {
  DIRECT, POOLED, ROOT, SHARED_ID, TENANT_A, TENANT_B, appDb, ready, terminate,
} from './support.ts';

interface Row {
  tenant_id: string;
  id: string;
  marker: string;
}

async function readRows(trx: Transaction<Database>): Promise<Row[]> {
  const result = await trx.withSchema('kernel').selectFrom('scoped_row').select(['tenant_id', 'id', 'marker']).orderBy('marker').execute();
  return result;
}

async function readLinks(trx: Transaction<Database>): Promise<Row[]> {
  const result = await sql<Row>`
    SELECT l.tenant_id::text AS tenant_id, l.id::text AS id, l.marker
    FROM kernel.scoped_link l
    JOIN kernel.scoped_row r ON r.tenant_id = l.tenant_id AND r.id = l.row_id
    ORDER BY l.marker`.execute(trx);
  return result.rows;
}

async function clear(db: Kysely<Database>, ev: HygieneEvidence): Promise<void> {
  for (const tenant of [TENANT_A, TENANT_B]) {
    await withTenant(db, tenant, ev, terminate, async (trx) => {
      await trx.withSchema('kernel').deleteFrom('scoped_link').execute();
      await trx.withSchema('kernel').deleteFrom('scoped_row').execute();
    });
  }
}

async function seed(db: Kysely<Database>, ev: HygieneEvidence): Promise<void> {
  await clear(db, ev);
  await withTenant(db, TENANT_A, ev, terminate, async (trx) => {
    await trx.withSchema('kernel').insertInto('scoped_row').values({ tenant_id: TENANT_A, id: SHARED_ID, marker: 'alpha' }).execute();
    await trx.withSchema('kernel').insertInto('scoped_link').values({
      tenant_id: TENANT_A, id: SHARED_ID, row_id: SHARED_ID, marker: 'alpha-link',
    }).execute();
  });
  await withTenant(db, TENANT_B, ev, terminate, async (trx) => {
    await trx.withSchema('kernel').insertInto('scoped_row').values({ tenant_id: TENANT_B, id: SHARED_ID, marker: 'beta' }).execute();
    await trx.withSchema('kernel').insertInto('scoped_link').values({
      tenant_id: TENANT_B, id: SHARED_ID, row_id: SHARED_ID, marker: 'beta-link',
    }).execute();
  });
}

async function rootQuery(text: string, values?: unknown[]): Promise<void> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    await client.query(text, values);
  } finally {
    await client.end();
  }
}

async function drainAppBackends(): Promise<void> {
  await rootQuery(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE usename = 'plerni_app' AND pid <> pg_backend_pid()`,
  );
}

async function setAppTenantDefault(tenant: string): Promise<void> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    const built = await client.query<{ stmt: string }>(
      `SELECT format('ALTER ROLE plerni_app SET plerni.tenant_id = %L', $1::text) AS stmt`,
      [tenant],
    );
    const statement = built.rows[0]?.stmt;
    if (typeof statement !== 'string' || !statement.startsWith('ALTER ROLE plerni_app SET plerni.tenant_id = ')) {
      throw new Error('refusing unexpected role-default statement');
    }
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function resetAppTenantDefault(): Promise<void> {
  await rootQuery('ALTER ROLE plerni_app RESET plerni.tenant_id');
  await drainAppBackends();
}

let chain: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    await run;
  });
}

for (const [label, connection] of [['direct', DIRECT], ['pooled', POOLED]] as const) {
  serial(`${label}: overlapping ids stay inside the tenant`, async () => {
    await ready();
    const db = appDb(connection, 1);
    const ev = blankEvidence();
    try {
      await seed(db, ev);
      const pids: number[] = [];
      const alpha = await withTenant(db, TENANT_A, ev, terminate, async (trx) => {
        for (let i = 0; i < 3; i += 1) {
          const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
          const value = pid.rows[0]?.pid;
          if (value === undefined) throw new Error('pid missing');
          pids.push(Number(value));
        }
        return readRows(trx);
      });
      const beta = await withTenant(db, TENANT_B, ev, terminate, readRows);
      assert.deepEqual(alpha.map((row) => row.marker), ['alpha']);
      assert.deepEqual(beta.map((row) => row.marker), ['beta']);
      assert.equal(alpha[0]?.id, SHARED_ID);
      assert.equal(beta[0]?.id, SHARED_ID);
      assert.equal(alpha[0]?.tenant_id, TENANT_A);
      assert.equal(beta[0]?.tenant_id, TENANT_B);
      assert.equal(new Set(pids).size, 1);
      const alphaLinks = await withTenant(db, TENANT_A, ev, terminate, readLinks);
      const betaLinks = await withTenant(db, TENANT_B, ev, terminate, readLinks);
      assert.deepEqual(alphaLinks.map((row) => row.marker), ['alpha-link']);
      assert.deepEqual(betaLinks.map((row) => row.marker), ['beta-link']);
      const stolen = await withTenant(db, TENANT_B, ev, terminate, async (trx) => {
        const updated = await trx.withSchema('kernel').updateTable('scoped_row').set({ marker: 'stolen' }).where('id', '=', SHARED_ID).where('marker', '=', 'alpha').executeTakeFirst();
        return Number(updated.numUpdatedRows);
      });
      assert.equal(stolen, 0);
      const still = await withTenant(db, TENANT_A, ev, terminate, readRows);
      assert.deepEqual(still.map((row) => row.marker), ['alpha']);
      assert.equal(ev.terminatedBackendPids.length, 0);
    } finally {
      await db.destroy();
    }
  });

  serial(`${label}: missing context returns no rows and the guard raises`, async () => {
    await ready();
    const db = appDb(connection, 1);
    const ev = blankEvidence();
    try {
      await seed(db, ev);
      let rows = -1;
      let guardRaised = false;
      await db.transaction().execute(async (trx) => {
        rows = (await readRows(trx)).length;
        try {
          await assertTenantContext(trx);
        } catch (error) {
          guardRaised = error instanceof MissingTenantContextError;
        }
      });
      assert.equal(rows, 0);
      assert.equal(guardRaised, true);
    } finally {
      await db.destroy();
    }
  });

  serial(`${label}: context does not survive commit`, async () => {
    await ready();
    const db = appDb(connection, 1);
    const ev = blankEvidence();
    try {
      await seed(db, ev);
      await withTenant(db, TENANT_B, ev, terminate, readRows);
      const follow = await db.transaction().execute(async (trx) => {
        const absent = await sql<{ absent: boolean }>`
          SELECT NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL AS absent`.execute(trx);
        return { absent: absent.rows[0]?.absent, rows: (await readRows(trx)).length };
      });
      assert.equal(follow.absent, true);
      assert.equal(follow.rows, 0);
    } finally {
      await db.destroy();
    }
  });

  serial(`${label}: a rolled-back write leaves no row`, async () => {
    await ready();
    const db = appDb(connection, 1);
    const ev = blankEvidence();
    try {
      await clear(db, ev);
      await assert.rejects(
        () => withTenant(db, TENANT_A, ev, terminate, async (trx) => {
          await trx.withSchema('kernel').insertInto('scoped_row').values({
            tenant_id: TENANT_A, id: SHARED_ID, marker: 'alpha',
          }).execute();
          throw new Error('rollback marker');
        }),
        /rollback marker/,
      );
      const rows = await withTenant(db, TENANT_A, ev, terminate, readRows);
      assert.deepEqual(rows, []);
    } finally {
      await db.destroy();
    }
  });

  serial(`${label}: vacuity control fails when the guard is skipped`, async () => {
    await ready();
    const db = appDb(connection, 1);
    const ev = blankEvidence();
    try {
      await seed(db, ev);
      const proof = async (callGuard: boolean) => db.transaction().execute(async (trx) => {
        const rows = (await readRows(trx)).length;
        let guardRaised = false;
        if (callGuard) {
          try {
            await assertTenantContext(trx);
          } catch (error) {
            guardRaised = error instanceof MissingTenantContextError;
          }
        }
        return { rows, guardRaised, pass: rows === 0 && guardRaised };
      });
      const skipped = await proof(false);
      assert.equal(skipped.rows, 0);
      assert.equal(skipped.guardRaised, false);
      assert.equal(skipped.pass, false);
      const held = await proof(true);
      assert.equal(held.pass, true);
    } finally {
      await db.destroy();
    }
  });
}

serial('pooled: session contamination terminates the backend and retries at most twice', async () => {
  await ready();
  const db = appDb(POOLED, 1);
  const ev = blankEvidence();
  try {
    await seed(db, ev);
    await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(db);
    const before = ev.terminatedBackendPids.length;
    const rows = await withTenant(db, TENANT_B, ev, terminate, readRows);
    assert.deepEqual(rows.map((row) => row.marker), ['beta']);
    assert.equal(ev.terminatedBackendPids.length - before, 1);
    assert.ok(ev.attempts >= 2);
    assert.ok(ev.attempts <= MAX_RETRY + 1);
    const dead = ev.terminatedBackendPids.at(-1);
    assert.ok(dead !== undefined);
    const client = new pg.Client({ connectionString: ROOT });
    await client.connect();
    try {
      const alive = await client.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [dead]);
      assert.equal(alive.rows.length, 0);
    } finally {
      await client.end();
    }
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
});

serial('pooled: a leaked role is contamination and does not authorize the other tenant', async () => {
  await ready();
  const db = appDb(POOLED, 1);
  const ev = blankEvidence();
  try {
    await seed(db, ev);
    await sql`SET ROLE plerni_plugin_a`.execute(db);
    const rows = await withTenant(db, TENANT_B, ev, terminate, readRows);
    assert.deepEqual(rows.map((row) => row.marker), ['beta']);
    assert.ok(ev.alerts.some((alert) => alert.includes('role leaked') && alert.includes('plerni_plugin_a')));
    assert.ok(ev.attempts <= MAX_RETRY + 1);
    assert.equal(ev.terminatedBackendPids.length, 1);
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
});

serial('pooled: a leaked search_path is contamination and retries inside the budget', async () => {
  await ready();
  const db = appDb(POOLED, 1);
  const ev = blankEvidence();
  try {
    await seed(db, ev);
    await sql`SET search_path TO pg_catalog`.execute(db);
    const rows = await withTenant(db, TENANT_B, ev, terminate, readRows);
    assert.deepEqual(rows.map((row) => row.marker), ['beta']);
    assert.ok(ev.alerts.some((alert) => alert.includes('search_path')));
    assert.equal(ev.terminatedBackendPids.length, 1);
    assert.ok(ev.attempts <= MAX_RETRY + 1);
    // A linked kill on this pooler closes the client before discard runs, so
    // this counter stays 0. surviving-client.test.ts is the discard proof.
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
});

serial('direct: session contamination terminates the backend and reads the authorized tenant', async () => {
  await ready();
  const db = appDb(DIRECT, 1);
  const ev = blankEvidence();
  try {
    await seed(db, ev);
    await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(db);
    const rows = await withTenant(db, TENANT_B, ev, terminate, readRows);
    assert.deepEqual(rows.map((row) => row.marker), ['beta']);
    assert.equal(ev.terminatedBackendPids.length, 1);
    assert.ok(ev.attempts <= MAX_RETRY + 1);
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
});

serial('a role default that reapplies on login fails loud after two retries', async () => {
  await ready();
  await setAppTenantDefault(TENANT_A);
  await drainAppBackends();
  const db = appDb(POOLED, 1);
  const ev = blankEvidence();
  try {
    await assert.rejects(
      () => withTenant(db, TENANT_B, ev, terminate, readRows),
      (error: unknown) => error instanceof Error && error.message.includes('loud failure') && error.message.includes(`${MAX_RETRY} retries`),
    );
    assert.equal(ev.terminatedBackendPids.length, MAX_RETRY + 1);
    assert.equal(ev.attempts, MAX_RETRY + 1);
  } finally {
    await db.destroy();
    await resetAppTenantDefault();
  }
});

serial('negative fixture: skipping the guard on a table without RLS fails the vacuity predicate', async () => {
  await ready();
  const root = new pg.Client({ connectionString: ROOT });
  await root.connect();
  const db = appDb(DIRECT, 1);
  try {
    await root.query('DROP TABLE IF EXISTS kernel.fixture_unguarded');
    await root.query(`
      CREATE TABLE kernel.fixture_unguarded (
        tenant_id uuid NOT NULL,
        id uuid NOT NULL,
        marker text NOT NULL,
        PRIMARY KEY (tenant_id, id)
      )`);
    await root.query('GRANT SELECT ON kernel.fixture_unguarded TO plerni_app');
    await root.query(
      `INSERT INTO kernel.fixture_unguarded (tenant_id, id, marker) VALUES ($1, $2, 'alpha'), ($3, $2, 'beta')`,
      [TENANT_A, SHARED_ID, TENANT_B],
    );
    const leaked = await db.transaction().execute(async (trx) => {
      const result = await sql<{ marker: string }>`
        SELECT marker FROM kernel.fixture_unguarded ORDER BY marker`.execute(trx);
      return result.rows.map((row) => row.marker);
    });
    const vacuityPass = leaked.length === 0;
    assert.equal(vacuityPass, false);
    assert.deepEqual(leaked, ['alpha', 'beta']);
  } finally {
    await db.destroy();
    await root.query('DROP TABLE IF EXISTS kernel.fixture_unguarded');
    await root.end();
  }
});
