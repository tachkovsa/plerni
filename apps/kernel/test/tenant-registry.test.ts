// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { MAX_RETRY } from '../src/tenancy/constants.ts';
import { blankEvidence, withTenant } from '../src/tenancy/hygiene.ts';
import {
  InvalidIdempotencyKeyError,
  PlatformScopeError,
} from '../src/tenant/errors.ts';
import { bootstrapOperatorTenant, createTenant, type TenantRecord } from '../src/tenant/registry.ts';
import { DIRECT, POOLED, ROOT, appDb, ready, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Snapshot {
  tenants: number;
  operators: number;
  events: number;
  audits: number;
  keys: number;
  scopedRows: number;
  scopedLinks: number;
}

interface LogRow {
  seq: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  type: string;
  version: number;
  payload: { id?: string; kind?: string };
}

async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function drainAppBackends(): Promise<void> {
  await withRoot(async (client) => {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE usename = 'plerni_app' AND pid <> pg_backend_pid()`,
    );
  });
}

async function resetRegistry(): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.tenant_idempotency');
    await client.query('DELETE FROM kernel.audit_record');
    await client.query('DELETE FROM kernel.outbox');
    await client.query('DELETE FROM kernel.tenants');
  });
}

async function snapshot(): Promise<Snapshot> {
  return withRoot(async (client) => {
    const result = await client.query<{
      tenants: string;
      operators: string;
      events: string;
      audits: string;
      keys: string;
      scoped_rows: string;
      scoped_links: string;
    }>(
      `SELECT
         (SELECT count(*) FROM kernel.tenants)::text AS tenants,
         (SELECT count(*) FROM kernel.tenants WHERE kind = 'operator')::text AS operators,
         (SELECT count(*) FROM kernel.outbox)::text AS events,
         (SELECT count(*) FROM kernel.audit_record)::text AS audits,
         (SELECT count(*) FROM kernel.tenant_idempotency)::text AS keys,
         (SELECT count(*) FROM kernel.scoped_row)::text AS scoped_rows,
         (SELECT count(*) FROM kernel.scoped_link)::text AS scoped_links`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('snapshot returned no row');
    return {
      tenants: Number(row.tenants),
      operators: Number(row.operators),
      events: Number(row.events),
      audits: Number(row.audits),
      keys: Number(row.keys),
      scopedRows: Number(row.scoped_rows),
      scopedLinks: Number(row.scoped_links),
    };
  });
}

function errorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function scenario(connection: string): Promise<void> {
  await ready();
  await resetRegistry();
  const db = appDb(connection, 1);
  try {
    const first = blankEvidence();
    const operator = await bootstrapOperatorTenant(db, first, terminate);
    assert.equal(operator.kind, 'operator');
    assert.equal(first.attempts, 1);
    const afterBoot = await snapshot();
    assert.equal(afterBoot.operators, 1);
    assert.equal(afterBoot.tenants, 1);
    assert.equal(afterBoot.events, 1);
    assert.equal(afterBoot.audits, 1);
    assert.equal(afterBoot.keys, 0);

    const second = blankEvidence();
    const repeat = await bootstrapOperatorTenant(db, second, terminate);
    assert.equal(repeat.id, operator.id);
    assert.equal(repeat.kind, 'operator');
    assert.equal(second.attempts, 1);
    assert.equal(second.terminatedBackendPids.length, 0);
    assert.deepEqual(await snapshot(), afterBoot);

    const session = { tenantId: operator.id };
    const customer = await createTenant(
      db,
      session,
      { idempotencyKey: 'customer-1' },
      blankEvidence(),
      terminate,
    );
    assert.equal(customer.kind, 'customer');
    assert.notEqual(customer.id, operator.id);
    const afterCreate = await snapshot();
    assert.equal(afterCreate.operators, 1);
    assert.equal(afterCreate.tenants, 2);
    assert.equal(afterCreate.events, 2);
    assert.equal(afterCreate.audits, 2);
    assert.equal(afterCreate.keys, 1);
    assert.equal(afterCreate.scopedRows, afterBoot.scopedRows);
    assert.equal(afterCreate.scopedLinks, afterBoot.scopedLinks);

    const replay = await createTenant(
      db,
      session,
      { idempotencyKey: 'customer-1' },
      blankEvidence(),
      terminate,
    );
    assert.equal(replay.id, customer.id);
    assert.equal(replay.kind, 'customer');
    assert.ok(replay.createdAt instanceof Date);
    assert.equal(replay.createdAt.getTime(), customer.createdAt.getTime());
    assert.deepEqual(await snapshot(), afterCreate);

    const other = await createTenant(
      db,
      session,
      { idempotencyKey: 'customer-2' },
      blankEvidence(),
      terminate,
    );
    assert.equal(other.kind, 'customer');
    assert.notEqual(other.id, customer.id);
    const afterSecond = await snapshot();
    assert.equal(afterSecond.tenants, 3);
    assert.equal(afterSecond.operators, 1);
    assert.equal(afterSecond.keys, 2);
    assert.equal(afterSecond.events, 3);

    const beforeRefusal = await snapshot();
    const refusedEvidence = blankEvidence();
    await assert.rejects(
      () => createTenant(
        db,
        { tenantId: customer.id },
        { idempotencyKey: 'customer-3' },
        refusedEvidence,
        terminate,
      ),
      (error: unknown) => error instanceof PlatformScopeError,
    );
    assert.equal(refusedEvidence.attempts, 1);
    assert.deepEqual(await snapshot(), beforeRefusal);

    const invalid = blankEvidence();
    await assert.rejects(
      () => createTenant(db, session, { idempotencyKey: '' }, invalid, terminate),
      (error: unknown) => error instanceof InvalidIdempotencyKeyError,
    );
    assert.equal(invalid.attempts, 0);
    await assert.rejects(
      () => createTenant(
        db,
        { tenantId: '33333333-3333-3333-3333-333333333333' },
        { idempotencyKey: 'customer-4' },
        blankEvidence(),
        terminate,
      ),
      (error: unknown) => error instanceof PlatformScopeError,
    );
    assert.deepEqual(await snapshot(), beforeRefusal);

    const logged = await sql<LogRow>`
      SELECT seq::text AS seq, tenant_id::text AS tenant_id, aggregate_type,
             aggregate_id::text AS aggregate_id, aggregate_version::text AS aggregate_version,
             type, version, payload
      FROM kernel.outbox
      WHERE type = 'kernel.tenant.created' AND aggregate_id = ${customer.id}::uuid`.execute(db);
    assert.equal(logged.rows.length, 1);
    const event = logged.rows[0];
    if (!event) throw new Error('customer event missing');
    assert.equal(event.type, 'kernel.tenant.created');
    assert.equal(event.version, 1);
    assert.equal(event.aggregate_type, 'kernel.tenant');
    assert.equal(event.aggregate_id, customer.id);
    assert.equal(event.tenant_id, customer.id);
    assert.equal(event.aggregate_version, '1');
    assert.equal(Number(event.seq) > 0, true);
    assert.deepEqual(event.payload, { id: customer.id, kind: 'customer' });

    const version = await sql<{ aggregate_version: string }>`
      SELECT aggregate_version::text AS aggregate_version
      FROM kernel.tenants
      WHERE id = ${customer.id}::uuid`.execute(db);
    assert.equal(version.rows[0]?.aggregate_version, '1');

    const visible = await withTenant(db, operator.id, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ target: string }>`
        SELECT target_tenant_id::text AS target
        FROM kernel.audit_record
        WHERE action = 'kernel.tenant.created'`.execute(trx);
      return result.rows.map((row) => row.target);
    });
    assert.ok(visible.includes(operator.id));
    assert.ok(visible.includes(customer.id));
    const hidden = await withTenant(db, customer.id, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ id: string }>`SELECT id::text AS id FROM kernel.audit_record`.execute(trx);
      return result.rows.length;
    });
    assert.equal(hidden, 0);

    const app = new pg.Client({ connectionString: connection });
    await app.connect();
    try {
      await app.query('BEGIN');
      await assert.rejects(
        () => app.query('DELETE FROM kernel.tenants WHERE id = $1', [operator.id]),
        (error: unknown) => errorCode(error) === '42501',
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  } finally {
    await db.destroy();
  }
}

let chain: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    await run;
  });
}

test('the create path allocates seq with nextval and does not take an advisory lock', () => {
  const migration = readFileSync(join(here, '../sql/0002_tenant_registry.sql'), 'utf8');
  const source = readFileSync(join(here, '../src/tenant/registry.ts'), 'utf8');
  for (const body of [migration, source]) {
    assert.equal(/pg_advisory/i.test(body), false);
    assert.equal(/\bLOCK TABLE\b/i.test(body), false);
  }
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /nextval\('kernel\.outbox_seq'\)/);
  assert.equal(migration.includes('ENABLE ROW LEVEL SECURITY'), true);
  assert.equal(/ROW LEVEL SECURITY/.test(
    migration.slice(0, migration.indexOf('CREATE TABLE IF NOT EXISTS kernel.tenant_idempotency')),
  ), false);
});

serial('catalog: tenants have no policy, plugin role cannot select, runtime roles have no bypass', async () => {
  await ready();
  await withRoot(async (client) => {
    const relations = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, count(pol.polname)::text AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
       WHERE n.nspname = 'kernel' AND c.relname IN ('tenants', 'outbox', 'tenant_idempotency')
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
       ORDER BY c.relname`,
    );
    assert.deepEqual(
      relations.rows,
      [
        { relname: 'outbox', relrowsecurity: false, relforcerowsecurity: false, policies: '0' },
        { relname: 'tenant_idempotency', relrowsecurity: false, relforcerowsecurity: false, policies: '0' },
        { relname: 'tenants', relrowsecurity: false, relforcerowsecurity: false, policies: '0' },
      ],
    );
    const grants = await client.query<{ grantee: string; privilege_type: string }>(
      `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
              acl.privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(c.relkind, c.relowner))) AS acl
       WHERE n.nspname = 'kernel' AND c.relname = 'tenants'`,
    );
    assert.equal(grants.rows.some((grant) => grant.grantee === 'PUBLIC'), false);
    assert.equal(grants.rows.some((grant) => grant.grantee === 'plerni_plugin_a'), false);
    const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname LIKE 'plerni\\_%' ESCAPE '\\'
       ORDER BY rolname`,
    );
    assert.deepEqual(roles.rows.map((role) => role.rolname), [
      'plerni_admin_ro',
      'plerni_app',
      'plerni_migrate',
      'plerni_plugin_a',
    ]);
    assert.equal(roles.rows.every((role) => role.rolsuper === false && role.rolbypassrls === false), true);
    const routines = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'kernel'`,
    );
    assert.equal(routines.rows[0]?.count, '0');
  });
});

serial('pooled: a plugin role cannot select kernel.tenants', async () => {
  await ready();
  const client = new pg.Client({ connectionString: POOLED });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE plerni_plugin_a');
    await assert.rejects(
      () => client.query('SELECT id FROM kernel.tenants'),
      (error: unknown) => errorCode(error) === '42501',
    );
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});

serial('a failed outbox insert rolls the customer tenant back', async () => {
  await ready();
  await resetRegistry();
  const db = appDb(POOLED, 1);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    await withRoot(async (client) => {
      await client.query('REVOKE INSERT ON TABLE kernel.outbox FROM plerni_app');
    });
    try {
      await assert.rejects(
        () => createTenant(
          db,
          { tenantId: operator.id },
          { idempotencyKey: 'rolled-back' },
          blankEvidence(),
          terminate,
        ),
        (error: unknown) => errorCode(error) === '42501',
      );
    } finally {
      await withRoot(async (client) => {
        await client.query('GRANT INSERT ON TABLE kernel.outbox TO plerni_app');
      });
    }
    const after = await snapshot();
    assert.equal(after.tenants, 1);
    assert.equal(after.operators, 1);
    assert.equal(after.events, 1);
    assert.equal(after.audits, 1);
    assert.equal(after.keys, 0);
    const created: TenantRecord = await createTenant(
      db,
      { tenantId: operator.id },
      { idempotencyKey: 'rolled-back' },
      blankEvidence(),
      terminate,
    );
    assert.equal(created.kind, 'customer');
  } finally {
    await db.destroy();
  }
});

serial('pooled: repeat bootstrap recovers a leaked plugin role and writes nothing', async () => {
  await ready();
  await resetRegistry();
  const db = appDb(POOLED, 1);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    const before = await snapshot();
    await sql`SET ROLE plerni_plugin_a`.execute(db);
    const evidence = blankEvidence();
    const repeat = await bootstrapOperatorTenant(db, evidence, terminate);
    assert.equal(repeat.id, operator.id);
    assert.equal(repeat.kind, 'operator');
    assert.ok(evidence.attempts >= 2);
    assert.ok(evidence.attempts <= MAX_RETRY + 1);
    assert.equal(evidence.terminatedBackendPids.length, 1);
    assert.ok(
      evidence.alerts.some((alert) => alert.includes('role leaked') && alert.includes('plerni_plugin_a')),
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await db.destroy();
    await drainAppBackends();
  }
});

serial('a second operator row is rejected by the partial unique index', async () => {
  await ready();
  await resetRegistry();
  const db = appDb(POOLED, 1);
  try {
    const operator = await bootstrapOperatorTenant(db, blankEvidence(), terminate);
    assert.equal(operator.kind, 'operator');
  } finally {
    await db.destroy();
  }
  await withRoot(async (client) => {
    await client.query('BEGIN');
    try {
      await assert.rejects(
        () => client.query(
          `INSERT INTO kernel.tenants (id, kind, aggregate_version)
           VALUES ('44444444-4444-4444-4444-444444444444', 'operator', 0)`,
        ),
        (error: unknown) => errorCode(error) === '23505',
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

for (const [label, connection] of [['direct', DIRECT], ['pooled', POOLED]] as const) {
  serial(`${label}: bootstrap one operator and create a customer through the API`, async () => {
    await scenario(connection);
  });
}
