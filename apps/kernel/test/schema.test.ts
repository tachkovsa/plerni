// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyKernelMigrations } from '../src/schema/migrate.ts';
import { inspectTenantTable, type ViolationCode } from '../src/schema/tenant-table.ts';
import { DIRECT, MIGRATE, ROOT, ready } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
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

async function codesFor(sql: string, table: string): Promise<ViolationCode[]> {
  return withRoot(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      const violations = await inspectTenantTable(client, { schema: 'kernel', table });
      return violations.map((item) => item.code);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

test('kernel tenant tables match the canonical shape and runtime roles have no bypass', async () => {
  await ready();
  await withRoot(async (client) => {
    const rowViolations = await inspectTenantTable(client, { schema: 'kernel', table: 'scoped_row' });
    assert.deepEqual(rowViolations, [], 'scoped_row');
    const linkViolations = await inspectTenantTable(client, {
      schema: 'kernel',
      table: 'scoped_link',
      foreignKey: 'FOREIGN KEY (tenant_id, row_id) REFERENCES kernel.scoped_row(tenant_id, id)',
    });
    assert.deepEqual(linkViolations, [], 'scoped_link');
    const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname IN ('plerni_app', 'plerni_migrate')
       ORDER BY rolname`,
    );
    assert.deepEqual(roles.rows, [
      { rolname: 'plerni_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'plerni_migrate', rolsuper: false, rolbypassrls: false },
    ]);
    const journal = await client.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kernel' AND c.relname = 'schema_migration'`,
    );
    assert.equal(journal.rows[0]?.relrowsecurity, false);
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'kernel' AND table_name IN ('scoped_row', 'scoped_link')
       ORDER BY table_name, ordinal_position`,
    );
    assert.deepEqual(
      columns.rows.map((item) => `${item.table_name}.${item.column_name}`),
      [
        'scoped_link.tenant_id',
        'scoped_link.id',
        'scoped_link.row_id',
        'scoped_link.marker',
        'scoped_row.tenant_id',
        'scoped_row.id',
        'scoped_row.marker',
      ],
    );
  });
});

test('applying the journal twice records nothing new', async () => {
  await ready();
  const again = await applyKernelMigrations(MIGRATE);
  assert.deepEqual(again, []);
});

test('the app role cannot read the migration journal', async () => {
  await ready();
  const client = new pg.Client({ connectionString: DIRECT });
  await client.connect();
  try {
    await assert.rejects(
      () => client.query('SELECT version FROM kernel.schema_migration'),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
    );
  } finally {
    await client.end();
  }
});

test('a second permissive policy fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('second-policy.sql'), 'fixture_second_policy');
  assert.ok(codes.includes('policy_count'), codes.join(','));
});

test('a policy that exists with the wrong text fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('open-policy.sql'), 'fixture_open_policy');
  assert.ok(codes.includes('policy_text'), codes.join(','));
  assert.ok(!codes.includes('policy_count'), codes.join(','));
});

test('RLS without FORCE fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('no-force.sql'), 'fixture_no_force');
  assert.ok(codes.includes('rls_not_forced'), codes.join(','));
});

test('a nullable tenant id fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('nullable-tenant.sql'), 'fixture_nullable');
  assert.ok(codes.includes('tenant_id_nullable'), codes.join(','));
  assert.ok(codes.includes('primary_key'), codes.join(','));
});

test('GRANT ALL fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('grant-all.sql'), 'fixture_grant_all');
  assert.ok(codes.includes('privilege'), codes.join(','));
});

test('a table without row security fails the checker', async () => {
  await ready();
  const codes = await codesFor(fixture('unguarded.sql'), 'fixture_unguarded');
  assert.ok(codes.includes('rls_disabled'), codes.join(','));
});

test('a PUBLIC truncate grant is rejected when the inspecting role is not the grantor', async () => {
  await ready();
  const root = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  await root.connect();
  await migrate.connect();
  try {
    await root.query('DROP TABLE IF EXISTS kernel.fixture_public_truncate');
    await root.query(fixture('public-truncate.sql'));
    const violations = await inspectTenantTable(migrate, {
      schema: 'kernel',
      table: 'fixture_public_truncate',
    });
    const privilege = violations.filter((item) => item.code === 'privilege');
    assert.ok(privilege.length > 0, violations.map((item) => item.code).join(','));
    assert.ok(
      privilege.some((item) => item.detail.includes('PUBLIC') && item.detail.includes('TRUNCATE')),
      privilege.map((item) => item.detail).join(','),
    );
  } finally {
    await root.query('DROP TABLE IF EXISTS kernel.fixture_public_truncate');
    await migrate.end();
    await root.end();
  }
});
