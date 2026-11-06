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

serial('a read cannot replace the authorized tenant context', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000e1'::uuid, 'alpha')`.execute(trx);
    });
    await withPluginRole(db, TENANT_B, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_B}::uuid, '00000000-0000-4000-8000-0000000000e2'::uuid, 'beta')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = `SELECT set_config('plerni.tenant_id', '${TENANT_B}', true)`;
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('context'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('an indirect read cannot forge the tenant and return the other note', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000f1'::uuid, 'alpha')`.execute(trx);
    });
    await withPluginRole(db, TENANT_B, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_B}::uuid, '00000000-0000-4000-8000-0000000000f2'::uuid, 'beta')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = `SELECT query_to_xml($$SELECT set_config('plerni.tenant_id', '${TENANT_B}', true); SELECT * FROM plugin_fixture_alpha.note$$, false, false, '')`;
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('context'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('an escape string cannot delete through a read', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000f3'::uuid, 'alpha')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = "SELECT E" + String.fromCharCode(0x27, 0x5c, 0x27, 0x27) + "; DELETE FROM plugin_fixture_alpha.note; COMMIT; -- '";
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('escape string'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('a dollar sign in an identifier cannot delete through a read', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000f4'::uuid, 'alpha')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = 'SELECT 1 AS marker$$; DELETE FROM plugin_fixture_alpha.note; COMMIT; -- $$';
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('dollar'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('a nested block comment cannot delete through a read', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000f5'::uuid, 'alpha')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = "SELECT 1 /* /* */ ' */; DELETE FROM plugin_fixture_alpha.note; COMMIT; -- '";
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('unsupported'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('a carriage return cannot hide a delete after a line comment', async () => {
  await ready();
  await migrateFixture();
  await withRoot(async (client) => {
    await client.query('DELETE FROM plugin_fixture_alpha.note');
    await client.query('DELETE FROM kernel.principal_grant');
  });
  const db = appDb(POOLED, 1);
  try {
    await withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, '00000000-0000-4000-8000-0000000000f6'::uuid, 'alpha')`.execute(trx);
    });
    await allowPrincipal(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
    }, blankEvidence(), terminate);
    const forged = 'SELECT 1 -- comment\r; DELETE FROM plugin_fixture_alpha.note; COMMIT;';
    await assert.rejects(
      () => readPluginRows(db, {
        tenantId: TENANT_A,
        principalId: HOLDER,
        pluginId: PLUGIN,
        resource: 'note',
        action: 'read',
        statement: forged,
      }, blankEvidence(), terminate),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('unsupported'),
    );
    const honest = await readPluginRows(db, {
      tenantId: TENANT_A,
      principalId: HOLDER,
      pluginId: PLUGIN,
      resource: 'note',
      action: 'read',
      statement: READ_SQL,
    }, blankEvidence(), terminate);
    assert.deepEqual(honest.map((row) => row.body), ['alpha']);
  } finally {
    await db.destroy();
  }
});

serial('a create schema view subcommand is not applied', async () => {
  await ready();
  const id = 'schema_view';
  const schema = 'plugin_schema_view';
  const role = 'plerni_plugin_schema_view';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-schema-view-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(
    join(dir, 'sql/0001_view.sql'),
    `CREATE SCHEMA ${schema} CREATE VIEW exposed AS SELECT * FROM plugin_beta.note GRANT USAGE ON SCHEMA ${schema} TO ${role} GRANT SELECT ON TABLE ${schema}.exposed TO ${role};\n`,
  );
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ...manifest,
    id,
    permissions: [],
    migrations: ['sql/0001_view.sql'],
  }));
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('unsupported'),
    );
    const view = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.exposed`],
    );
    assert.equal(view.rows[0]?.rel ?? null, null);
    const present = await admin.query<{ name: string | null }>(
      'SELECT nspname AS name FROM pg_namespace WHERE nspname = $1',
      [schema],
    );
    assert.equal(present.rows[0]?.name ?? null, null);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('copying another plugin table with like is not applied', async () => {
  await ready();
  const id = 'like_src';
  const schema = 'plugin_like_src';
  const role = 'plerni_plugin_like_src';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-like-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(
    join(dir, 'sql/0001_copy.sql'),
    `CREATE SCHEMA IF NOT EXISTS ${schema};
CREATE TABLE ${schema}.copy (LIKE plugin_beta.note INCLUDING ALL);
GRANT SELECT ON TABLE ${schema}.copy TO ${role};
`,
  );
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ...manifest,
    id,
    permissions: [],
    migrations: ['sql/0001_copy.sql'],
  }));
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('foreign_schema'),
    );
    const copied = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.copy`],
    );
    assert.equal(copied.rows[0]?.rel ?? null, null);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('attaching another plugin partition does not link the child', async () => {
  await ready();
  const id = 'attach_x';
  const schema = 'plugin_attach_x';
  const role = 'plerni_plugin_attach_x';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-attach-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_note.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${tenantTable(schema, role, 'note', 'body text NOT NULL,')}`);
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
      join(dir, 'sql/0002_attach.sql'),
      `ALTER TABLE ${schema}.note ATTACH PARTITION plugin_beta.note DEFAULT;\n`,
    );
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_note.sql', 'sql/0002_attach.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('foreign_schema'),
    );
    const links = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 OR n.nspname = 'plugin_beta'`,
      [schema],
    );
    assert.equal(links.rows[0]?.count, '0');
    const stayed = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.note`],
    );
    assert.equal(stayed.rows[0]?.rel, `${schema}.note`);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('inheriting another plugin table does not link the child', async () => {
  await ready();
  const id = 'inherit_x';
  const schema = 'plugin_inherit_x';
  const role = 'plerni_plugin_inherit_x';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-inherit-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_note.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${tenantTable(schema, role, 'note', 'body text NOT NULL,')}`);
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
      join(dir, 'sql/0002_inherit.sql'),
      `ALTER TABLE ${schema}.note INHERIT plugin_beta.note;\n`,
    );
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_note.sql', 'sql/0002_inherit.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('unsupported'),
    );
    const links = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1`,
      [schema],
    );
    assert.equal(links.rows[0]?.count, '0');
    const stayed = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.note`],
    );
    assert.equal(stayed.rows[0]?.rel, `${schema}.note`);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('alter table set schema does not move the table', async () => {
  await ready();
  const id = 'schema_move';
  const schema = 'plugin_schema_move';
  const role = 'plerni_plugin_schema_move';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-move-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_note.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${tenantTable(schema, role, 'note', 'body text NOT NULL,')}`);
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
      join(dir, 'sql/0002_move.sql'),
      `ALTER TABLE ${schema}.note SET SCHEMA plugin_beta;\n`,
    );
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_note.sql', 'sql/0002_move.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('foreign_schema'),
    );
    const stayed = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.note`],
    );
    assert.equal(stayed.rows[0]?.rel, `${schema}.note`);
    const journal = await admin.query<{ version: string }>(
      'SELECT version FROM kernel.plugin_migration WHERE plugin_id = $1 ORDER BY version',
      [id],
    );
    assert.deepEqual(journal.rows.map((row) => row.version), ['0001_note.sql']);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

function tenantTable(schema: string, role: string, table: string, body: string): string {
  return `CREATE TABLE ${schema}.${table} (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  ${body}
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${schema}.${table};
CREATE POLICY tenant_isolation ON ${schema}.${table}
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE ${schema}.${table} FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.${table} TO ${role};
`;
}

async function dropPackage(client: pg.Client, id: string, schema: string, role: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query('DELETE FROM kernel.plugin_migration WHERE plugin_id = $1', [id]);
  await client.query('DELETE FROM kernel.plugin_grant WHERE plugin_id = $1', [id]);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if ((exists.rowCount ?? 0) > 0) {
    await client.query(`REVOKE ${role} FROM plerni_app`);
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
  }
}

serial('a maximum-length plugin id migrates its schema', async () => {
  await ready();
  const id = 'a'.repeat(41);
  const schema = `plugin_${id}`;
  const role = `plerni_plugin_${id}`;
  const dir = mkdtempSync(join(tmpdir(), 'plerni-long-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ...manifest,
    id,
    permissions: [],
    migrations: ['sql/0001_note.sql'],
  }));
  writeFileSync(join(dir, 'sql/0001_note.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${tenantTable(schema, role, 'note', '')}`);
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    const applied = await migratePluginPackage({ admin, migrate, packageDir: dir });
    assert.deepEqual(applied, ['0001_note.sql']);
    const present = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.note`],
    );
    assert.equal(present.rows[0]?.rel, `${schema}.note`);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('a cross-tenant cascade foreign key is rolled back', async () => {
  await ready();
  const id = 'fk_cascade';
  const schema = 'plugin_fk_cascade';
  const role = 'plerni_plugin_fk_cascade';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-fk-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const parent = `CREATE TABLE ${schema}.parent (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id)
);
ALTER TABLE ${schema}.parent ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.parent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${schema}.parent;
CREATE POLICY tenant_isolation ON ${schema}.parent
  USING (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('plerni.tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE ${schema}.parent FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.parent TO ${role};
`;
  const child = tenantTable(
    schema,
    role,
    'child',
    `parent_id uuid NOT NULL,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES ${schema}.parent (tenant_id, id),`,
  );
  const bad = `${tenantTable(
    schema,
    role,
    'bad_child',
    `parent_id uuid NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES ${schema}.parent (id) ON DELETE CASCADE,`,
  )}`;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_parent.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${parent}
${child}`);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    ...manifest,
    id,
    permissions: [],
    migrations: ['sql/0001_parent.sql'],
  }));
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    const first = await migratePluginPackage({ admin, migrate, packageDir: dir });
    assert.deepEqual(first, ['0001_parent.sql']);
    writeFileSync(join(dir, 'sql/0002_cascade.sql'), bad);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_parent.sql', 'sql/0002_cascade.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('foreign_key'),
    );
    const childPresent = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.bad_child`],
    );
    assert.equal(childPresent.rows[0]?.rel ?? null, null);
    const parentPresent = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.parent`],
    );
    assert.equal(parentPresent.rows[0]?.rel, `${schema}.parent`);
    const journal = await admin.query<{ version: string }>(
      'SELECT version FROM kernel.plugin_migration WHERE plugin_id = $1 ORDER BY version',
      [id],
    );
    assert.deepEqual(journal.rows.map((row) => row.version), ['0001_parent.sql']);
  } finally {
    await dropPackage(admin, id, schema, role);
    await admin.end();
    await migrate.end();
    rmSync(dir, { recursive: true, force: true });
  }
});

serial('a partitioned parent without row security is rolled back', async () => {
  await ready();
  const id = 'part_leak';
  const schema = 'plugin_part_leak';
  const role = 'plerni_plugin_part_leak';
  const noteA = '00000000-0000-4000-8000-0000000000d1';
  const noteB = '00000000-0000-4000-8000-0000000000d2';
  const dir = mkdtempSync(join(tmpdir(), 'plerni-part-'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  mkdirSync(join(dir, 'sql'));
  writeFileSync(join(dir, 'sql/0001_note.sql'), `CREATE SCHEMA IF NOT EXISTS ${schema};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${role};
${tenantTable(schema, role, 'note', 'body text NOT NULL,')}`);
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
  const db = appDb(POOLED, 1);
  try {
    const first = await migratePluginPackage({ admin, migrate, packageDir: dir });
    assert.deepEqual(first, ['0001_note.sql']);
    await withPluginRole(db, TENANT_A, id, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_part_leak.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, ${noteA}::uuid, 'alpha')`.execute(trx);
    });
    await withPluginRole(db, TENANT_B, id, blankEvidence(), terminate, async (trx) => {
      await sql`
        INSERT INTO plugin_part_leak.note (tenant_id, id, body)
        VALUES (${TENANT_B}::uuid, ${noteB}::uuid, 'beta')`.execute(trx);
    });
    writeFileSync(join(dir, 'sql/0002_parent.sql'), `CREATE TABLE ${schema}.all_notes (LIKE ${schema}.note INCLUDING ALL)
  PARTITION BY LIST (tenant_id);
ALTER TABLE ${schema}.all_notes ATTACH PARTITION ${schema}.note DEFAULT;
GRANT SELECT ON TABLE ${schema}.all_notes TO ${role};
`);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id,
      permissions: [],
      migrations: ['sql/0001_note.sql', 'sql/0002_parent.sql'],
    }));
    await assert.rejects(
      () => migratePluginPackage({ admin, migrate, packageDir: dir }),
      (error: unknown) => error instanceof PluginPackageError && error.message.includes('rls_disabled'),
    );
    const parent = await admin.query<{ rel: string | null }>(
      'SELECT to_regclass($1)::text AS rel',
      [`${schema}.all_notes`],
    );
    assert.equal(parent.rows[0]?.rel ?? null, null);
    const visible = await withPluginRole(db, TENANT_A, id, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ count: string; body: string }>`
        SELECT count(*)::text AS count, min(body) AS body
        FROM plugin_part_leak.note`.execute(trx);
      return result.rows[0];
    });
    assert.equal(visible?.count, '1');
    assert.equal(visible?.body, 'alpha');
    const other = await withPluginRole(db, TENANT_B, id, blankEvidence(), terminate, async (trx) => {
      const result = await sql<{ body: string }>`
        SELECT body FROM plugin_part_leak.note`.execute(trx);
      return result.rows.map((row) => row.body);
    });
    assert.deepEqual(other, ['beta']);
  } finally {
    await db.destroy();
    await dropPackage(admin, id, schema, role);
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
