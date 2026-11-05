// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { inspectTenantTable } from '../src/schema/tenant-table.ts';
import { PluginPackageError } from '../src/plugin/errors.ts';
import { migratePluginPackage } from '../src/plugin/migrate-package.ts';
import { allowPrincipal, readPluginRows } from '../src/plugin/read.ts';
import { applyReplayDecision, roleReplay, withPluginRole } from '../src/plugin/session.ts';
import { blankEvidence, readSessionState } from '../src/tenancy/hygiene.ts';
import { PINNED_SEARCH_PATH } from '../src/tenancy/constants.ts';
import { DIRECT, MIGRATE, POOLED, ROOT, TENANT_A, TENANT_B, appDb, ready, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const packageDir = join(repo, 'plugins/fixture_alpha');
const PLUGIN = 'fixture_alpha';
const ROLE = 'plerni_plugin_fixture_alpha';
const NOTE_1 = '00000000-0000-4000-8000-0000000000b1';
const NOTE_2 = '00000000-0000-4000-8000-0000000000b2';
const HOLDER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const READ_SQL = 'SELECT id::text AS id, body FROM plugin_fixture_alpha.note ORDER BY id';

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

async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function migrateFixture(): Promise<readonly string[]> {
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    return await migratePluginPackage({ admin, migrate, packageDir });
  } finally {
    await admin.end();
    await migrate.end();
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

serial('fixture_alpha migrates its schema without a kernel migration', async () => {
  await ready();
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.plugin_migration WHERE plugin_id = $1', [PLUGIN]);
    await client.query('DROP SCHEMA IF EXISTS plugin_fixture_alpha CASCADE');
  });
  const first = await migrateFixture();
  assert.deepEqual(first, ['0001_note.sql']);
  const second = await migrateFixture();
  assert.deepEqual(second, []);
  await withRoot(async (client) => {
    const kernel = await client.query<{ version: string }>(
      'SELECT version FROM kernel.schema_migration ORDER BY version',
    );
    assert.deepEqual(kernel.rows.map((row) => row.version), [
      '0001_kernel_schema.sql',
      '0002_tenant_registry.sql',
      '0003_plugin_grant.sql',
    ]);
    const plugin = await client.query<{ version: string }>(
      'SELECT version FROM kernel.plugin_migration WHERE plugin_id = $1',
      [PLUGIN],
    );
    assert.deepEqual(plugin.rows.map((row) => row.version), ['0001_note.sql']);
    const role = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
      [ROLE],
    );
    assert.deepEqual(role.rows, [{
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: false,
    }]);
    const member = await client.query<{ inherit_option: boolean; set_option: boolean }>(
      `SELECT m.inherit_option, m.set_option
       FROM pg_auth_members m
       JOIN pg_roles granted ON granted.oid = m.roleid
       JOIN pg_roles who ON who.oid = m.member
       WHERE granted.rolname = $1 AND who.rolname = 'plerni_app'`,
      [ROLE],
    );
    assert.deepEqual(member.rows, [{ inherit_option: false, set_option: true }]);
    const shape = await inspectTenantTable(client, {
      schema: 'plugin_fixture_alpha',
      table: 'note',
      runtimeRole: ROLE,
    });
    assert.deepEqual(shape, []);
    const routines = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'plugin_fixture_alpha'`,
    );
    assert.equal(routines.rows[0]?.count, '0');
    const edge = await client.query<{ rel: string | null }>(
      "SELECT to_regclass('kernel.edge_type')::text AS rel",
    );
    assert.equal(edge.rows[0]?.rel ?? null, null);
  });
  const app = new pg.Client({ connectionString: DIRECT });
  app.on('error', () => undefined);
  await app.connect();
  try {
    await assert.rejects(
      () => app.query("INSERT INTO kernel.plugin_grant (plugin_id, grant_name) VALUES ('fixture_alpha', 'directory.read')"),
      (error: unknown) => errorCode(error) === '42501',
    );
  } finally {
    await app.end();
  }
});

serial('a principal without the grant reads zero notes in a tenant that has two', async () => {
  await ready();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    const evidence = blankEvidence();
    await withPluginRole(db, TENANT_A, PLUGIN, evidence, terminate, async (trx) => {
      const state = await readSessionState(trx);
      assert.equal(state.current_user, ROLE);
      assert.equal(state.session_user, 'plerni_app');
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, ${NOTE_1}::uuid, 'one')`.execute(trx);
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, ${NOTE_2}::uuid, 'two')`.execute(trx);
    });
    await assert.rejects(
      () => withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
        await sql`
          INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
          VALUES (${TENANT_B}::uuid, ${NOTE_1}::uuid, 'stolen')`.execute(trx);
      }),
      (error: unknown) => errorCode(error) === '42501',
    );
    const replay = roleReplay(evidence);
    assert.equal(replay?.replayed, false);
    assert.equal(replay?.afterSearchPath, PINNED_SEARCH_PATH);
    assert.equal(replay?.afterUser, 'plerni_app');
    assert.equal(replay?.afterSessionUser, 'plerni_app');
    assert.equal(evidence.discardedPoolerSessions, 0);
    const visible = await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM plugin_fixture_alpha.note`.execute(trx);
      return result.rows[0]?.count;
    });
    assert.equal(visible, '2');
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    await allowPrincipal(db, {
      tenantId: TENANT_B,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const held = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(held.map((row) => row.body), ['one', 'two']);
    const denied = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: OTHER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(denied, []);
    const otherTenant = await readPluginRows(db, {
      tenantId: TENANT_B,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(otherTenant, []);
    const app = new pg.Client({ connectionString: POOLED });
    await app.connect();
    try {
      await assert.rejects(
        () => app.query('SELECT id FROM plugin_fixture_alpha.note'),
        (error: unknown) => errorCode(error) === '42501',
      );
      await app.query('BEGIN');
      await app.query(`SET LOCAL ROLE ${ROLE}`);
      await assert.rejects(
        () => app.query('SELECT id FROM kernel.tenants'),
        (error: unknown) => errorCode(error) === '42501',
      );
      await app.query('ROLLBACK');
      await app.query('BEGIN');
      await app.query(`SET LOCAL ROLE ${ROLE}`);
      await assert.rejects(
        () => app.query('SELECT id FROM kernel.principal_grant'),
        (error: unknown) => errorCode(error) === '42501',
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  } finally {
    await db.destroy();
  }
});

serial('a session search_path replay is discarded and SET LOCAL ROLE is not', async () => {
  await ready();
  const client = new pg.Client({ connectionString: POOLED });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query("SELECT set_config('search_path', 'pg_catalog', false)");
    const dirty = await client.query<{ search_path: string; current_user: string; session_user: string }>(
      'SELECT current_setting(\'search_path\') AS search_path, current_user, session_user',
    );
    const row = dirty.rows[0];
    assert.ok(row);
    assert.equal(row.search_path, 'pg_catalog');
    const evidence = blankEvidence();
    const closed = applyReplayDecision(true, evidence, () => {
      const stream = (client as unknown as {
        connection?: { stream?: { destroyed?: boolean; destroy: () => void } };
      }).connection?.stream;
      if (!stream || stream.destroyed) return 0;
      stream.destroy();
      return 1;
    });
    assert.equal(closed, 1);
    assert.equal(evidence.discardedPoolerSessions, 1);
    assert.ok(evidence.alerts.some((item) => item.includes('replay')));
  } finally {
    await client.end().catch(() => undefined);
  }
  const fresh = new pg.Client({ connectionString: POOLED });
  fresh.on('error', () => undefined);
  await fresh.connect();
  try {
    const path = await fresh.query<{ search_path: string }>(
      "SELECT current_setting('search_path') AS search_path",
    );
    assert.equal(path.rows[0]?.search_path, PINNED_SEARCH_PATH);
  } finally {
    await fresh.end();
  }
  const skipped = blankEvidence();
  assert.equal(applyReplayDecision(false, skipped, () => 1), 0);
  assert.equal(skipped.discardedPoolerSessions, 0);
});

serial('a package file that names an unqualified table is not applied', async () => {
  await ready();
  const dir = mkdtempSync(join(tmpdir(), 'plerni-fixture-'));
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id: 'bad_unqualified',
      permissions: [],
      migrations: ['sql/0001_note.sql'],
    }));
    writeFileSync(join(dir, 'sql/0001_note.sql'), 'CREATE TABLE note (tenant_id uuid, id uuid, body text);\n');
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('unqualified_table'),
    );
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['plerni_plugin_bad_unqualified']);
    assert.equal(role.rowCount, 0);
    const schema = await admin.query<{ rel: string | null }>(
      "SELECT to_regnamespace('plugin_bad_unqualified')::text AS rel",
    );
    assert.equal(schema.rows[0]?.rel ?? null, null);
  } finally {
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('an upgrade that disables row security is rolled back', async () => {
  await ready();
  const id = 'rls_drop';
  const schema = 'plugin_rls_drop';
  const role = 'plerni_plugin_rls_drop';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-rls-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const noteSql = `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
CREATE TABLE IF NOT EXISTS ${schema}.note (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE ${schema}.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.note FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${schema}.note;
CREATE POLICY tenant_isolation ON ${schema}.note
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE ${schema}.note FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.note TO ${role};
`;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_note.sql'), noteSql);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ...manifest,
    id,
    permissions: [],
    migrations: ['sql/0001_note.sql'],
  }));
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    const first = await migratePluginPackage({ admin, migrate, packageDir: dir });
    assert.deepEqual(first, ['0001_note.sql']);
    writeFileSync(
      join(dir, 'sql/0002_disable.sql'),
      `ALTER TABLE ${schema}.note DISABLE ROW LEVEL SECURITY;\n`,
    );
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_note.sql', 'sql/0002_disable.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('rls_disabled'),
    );
    const shape = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'note'`,
      [schema],
    );
    assert.equal(shape.rows[0]?.relrowsecurity, true);
    assert.equal(shape.rows[0]?.relforcerowsecurity, true);
    const journal = await admin.query<{ version: string }>(
      'SELECT version FROM kernel.plugin_migration WHERE plugin_id = $1 ORDER BY version',
      [id],
    );
    assert.deepEqual(journal.rows.map((row) => row.version), ['0001_note.sql']);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query('DELETE FROM kernel.plugin_migration WHERE plugin_id = $1', [id]);
    await admin.query('DELETE FROM kernel.plugin_grant WHERE plugin_id = $1', [id]);
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if ((exists.rowCount ?? 0) > 0) {
      await admin.query(`REVOKE ${role} FROM plerni_app`);
      await admin.query(`DROP OWNED BY ${role}`);
      await admin.query(`DROP ROLE ${role}`);
    }
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

function redact(text: string): string {
  return text.replace(/postgres:\/\/[^@\s]+@/g, 'postgres://[redacted]@');
}

function codegen(pattern: string, outFile: string): string {
  const binary = join(repo, 'tools/spikes/db-invariant/node_modules/.bin/kysely-codegen');
  const result = spawnSync(binary, [
    '--dialect', 'postgres',
    '--date-parser', 'timestamp',
    '--numeric-parser', 'string',
    '--type-only-imports',
    '--log-level', 'silent',
    '--include-pattern', pattern,
    '--out-file', outFile,
  ], {
    cwd: repo,
    env: { ...process.env, DATABASE_URL: ROOT },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(redact(`${result.stderr}\n${result.stdout}`));
  }
  const text = readFileSync(outFile, 'utf8');
  for (const name of ['POSTGRES_PASSWORD', 'PLERNI_APP_PASSWORD', 'PLERNI_MIGRATE_PASSWORD', 'PLERNI_ADMIN_PASSWORD']) {
    const value = process.env[name];
    if (value && text.includes(value)) throw new Error('codegen output contains a secret');
  }
  return text;
}

serial('codegen of the kernel schema is stable and excludes the fixture schema', async () => {
  await ready();
  await migrateFixture();
  const dir = mkdtempSync(join(tmpdir(), 'plerni-codegen-'));
  try {
    const first = codegen('kernel.*', join(dir, 'kernel-a.ts'));
    const second = codegen('kernel.*', join(dir, 'kernel-b.ts'));
    assert.equal(second, first);
    assert.match(first, /principal_grant/);
    assert.equal(first.includes('plugin_fixture_alpha'), false);
    assert.equal(first.includes('body:'), false);
    const plugin = codegen('plugin_fixture_alpha.*', join(dir, 'plugin.ts'));
    assert.match(plugin, /note/);
    assert.match(plugin, /body/);
    assert.notEqual(plugin, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
