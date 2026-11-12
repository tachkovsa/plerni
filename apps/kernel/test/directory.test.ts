// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractFailure } from '@plerni/contracts';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Database } from '../src/db/database.ts';
import { brokerTenant } from '../src/directory/access.ts';
import {
  deleteDirectoryEdge,
  insertDirectoryEdge,
  listDirectoryEdges,
  registerDirectoryEdgeType,
} from '../src/directory/edges.ts';
import { DIRECTORY_LABEL_MAX, DIRECTORY_PAGE_MAX } from '../src/directory/errors.ts';
import {
  addDirectoryMember,
  createDirectoryGroup,
  deleteDirectoryGroup,
  listDirectoryGroups,
  listDirectoryMembers,
  removeDirectoryMember,
  updateDirectoryGroup,
} from '../src/directory/groups.ts';
import {
  createDirectoryUser,
  deleteDirectoryUser,
  getDirectoryUser,
  listDirectoryUsers,
  updateDirectoryUser,
} from '../src/directory/users.ts';
import { parseManifest, readManifest, type PluginManifest } from '../src/plugin/manifest.ts';
import { migratePluginPackage } from '../src/plugin/migrate-package.ts';
import { installPluginRole, inPinnedTransaction, resumeSessionRole, withPluginRole } from '../src/plugin/session.ts';
import { inspectTenantTable } from '../src/schema/tenant-table.ts';
import { assertTenantContext } from '../src/tenancy/guard.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { DIRECT, MIGRATE, POOLED, ROOT, TENANT_A, TENANT_B, appDb, ready, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const packageDir = join(repo, 'plugins/fixture_alpha');
const PLUGIN = 'fixture_alpha';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';
const USER_B = '00000000-0000-4000-8000-000000000003';
const GROUP_1 = '00000000-0000-4000-8000-0000000000b1';
const NOTE_1 = '00000000-0000-4000-8000-0000000000d1';
const NOTE_2 = '00000000-0000-4000-8000-0000000000d2';
const NOTE_3 = '00000000-0000-4000-8000-0000000000d3';

function userId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function errorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function failure(error: unknown, code: ContractFailure['code'], message: string): boolean {
  return error instanceof ContractFailure && error.code === code && error.message === message;
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

async function withApp<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const db = appDb(POOLED, 2);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

async function migrateFixture(): Promise<void> {
  const admin = new pg.Client({ connectionString: ROOT });
  const migrate = new pg.Client({ connectionString: MIGRATE });
  admin.on('error', () => undefined);
  migrate.on('error', () => undefined);
  await admin.connect();
  await migrate.connect();
  try {
    await migratePluginPackage({ admin, migrate, packageDir });
  } finally {
    await admin.end();
    await migrate.end();
  }
}

async function resetDirectory(): Promise<void> {
  await ready();
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.directory_edge');
    await client.query('DELETE FROM kernel.directory_membership');
    await client.query('DELETE FROM kernel.directory_edge_type');
    await client.query('DELETE FROM kernel.directory_group');
    await client.query('DELETE FROM kernel.directory_user');
    const note = await client.query<{ rel: string | null }>(
      "SELECT to_regclass('plugin_fixture_alpha.note')::text AS rel",
    );
    if (note.rows[0]?.rel) await client.query('DELETE FROM plugin_fixture_alpha.note');
  });
}

async function counts(): Promise<{ users: number; groups: number; edges: number; notes: number; types: number }> {
  return withRoot(async (client) => {
    const result = await client.query<{
      users: string;
      groups: string;
      edges: string;
      notes: string;
      types: string;
    }>(
      `SELECT
         (SELECT count(*) FROM kernel.directory_user)::text AS users,
         (SELECT count(*) FROM kernel.directory_group)::text AS groups,
         (SELECT count(*) FROM kernel.directory_edge)::text AS edges,
         (SELECT count(*) FROM plugin_fixture_alpha.note)::text AS notes,
         (SELECT count(*) FROM kernel.directory_edge_type)::text AS types`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('count returned no row');
    return {
      users: Number(row.users),
      groups: Number(row.groups),
      edges: Number(row.edges),
      notes: Number(row.notes),
      types: Number(row.types),
    };
  });
}

function listedManifest(id = PLUGIN): PluginManifest {
  const base = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const permissions = id === PLUGIN
    ? base.permissions
    : [{ namespace: id, resource: 'note', action: 'read', suggestedRoleMappings: [] }];
  return parseManifest({
    ...base,
    id,
    permissions,
    migrations: id === PLUGIN ? base.migrations : [],
    grants: ['db.own_schema', 'directory.register_edge_type', 'directory.write_edge:linked'],
  });
}

let chain: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    await run;
  });
}

serial('directory tables match the tenant shape and the plugin role cannot insert', async () => {
  await resetDirectory();
  await migrateFixture();
  const sqlText = readFileSync(join(here, '../sql/0010_directory.sql'), 'utf8');
  const bound = /char_length\(display_name\) BETWEEN 1 AND (\d+)/.exec(sqlText);
  assert.equal(Number(bound?.[1]), DIRECTORY_LABEL_MAX);
  await withRoot(async (client) => {
    for (const table of ['directory_user', 'directory_group', 'directory_edge_type']) {
      assert.deepEqual(await inspectTenantTable(client, { schema: 'kernel', table }), [], table);
    }
    assert.deepEqual(await inspectTenantTable(client, {
      schema: 'kernel',
      table: 'directory_membership',
      tenantForeignKeys: true,
    }), []);
    assert.deepEqual(await inspectTenantTable(client, {
      schema: 'kernel',
      table: 'directory_edge',
      tenantForeignKeys: true,
    }), []);
    const foreignKeys = await client.query<{ rel: string; count: string }>(
      `SELECT c.relname AS rel, count(*)::text AS count
       FROM pg_constraint fk
       JOIN pg_class c ON c.oid = fk.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kernel' AND fk.contype = 'f'
         AND c.relname IN ('directory_membership', 'directory_edge')
       GROUP BY c.relname
       ORDER BY c.relname`,
    );
    assert.deepEqual(foreignKeys.rows, [
      { rel: 'directory_edge', count: '3' },
      { rel: 'directory_membership', count: '2' },
    ]);
    const absent = await client.query<{ rel: string | null }>(
      "SELECT to_regclass('kernel.edge_type')::text AS rel",
    );
    assert.equal(absent.rows[0]?.rel ?? null, null);
    const journal = await client.query<{ version: string }>(
      'SELECT version FROM kernel.schema_migration ORDER BY version',
    );
    assert.equal(journal.rows.some((row) => row.version === '0010_directory.sql'), true);
  });
  await withApp(async (db) => {
    const evidence = blankEvidence();
    await assert.rejects(
      () => withPluginRole(db, TENANT_A, PLUGIN, evidence, terminate, async (trx) => {
        await sql`
          INSERT INTO kernel.directory_user (tenant_id, id, display_name)
          VALUES (${TENANT_A}::uuid, ${USER_1}::uuid, 'nope')`.execute(trx);
      }),
      (error: unknown) => errorCode(error) === '42501',
    );
    await assert.rejects(
      () => withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
        await sql`
          INSERT INTO kernel.directory_group (tenant_id, id, name)
          VALUES (${TENANT_A}::uuid, ${GROUP_1}::uuid, 'nope')`.execute(trx);
      }),
      (error: unknown) => errorCode(error) === '42501',
    );
    await assert.rejects(
      () => withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
        await sql`
          INSERT INTO kernel.directory_edge_type (tenant_id, id, name, plugin_id)
          VALUES (${TENANT_A}::uuid, ${USER_2}::uuid, 'linked', ${PLUGIN})`.execute(trx);
      }),
      (error: unknown) => errorCode(error) === '42501',
    );
  });
  assert.deepEqual(await counts(), { users: 0, groups: 0, edges: 0, notes: 0, types: 0 });
});

serial('one tenant can change its users and groups and the other tenant sees none', async () => {
  await resetDirectory();
  await withApp(async (db) => {
    const evidence = blankEvidence();
    await assert.rejects(
      () => createDirectoryUser(db, TENANT_A, { displayName: '  ' }, evidence, terminate),
      (error: unknown) => failure(error, 'VALIDATION', 'The directory value was rejected.'),
    );
    await assert.rejects(
      () => createDirectoryUser(db, TENANT_A, { displayName: 'x'.repeat(DIRECTORY_LABEL_MAX + 1) }, evidence, terminate),
      (error: unknown) => error instanceof ContractFailure && error.code === 'VALIDATION',
    );
    const created = await createDirectoryUser(
      db, TENANT_A, { id: USER_1, displayName: 'alpha' }, evidence, terminate,
    );
    assert.equal(created.id, USER_1);
    assert.equal(created.displayName, 'alpha');
    const second = await createDirectoryUser(
      db, TENANT_A, { id: USER_2, displayName: 'beta' }, evidence, terminate,
    );
    const sameId = await createDirectoryUser(
      db, TENANT_B, { id: USER_1, displayName: 'same-id' }, evidence, terminate,
    );
    const onlyThere = await createDirectoryUser(
      db, TENANT_B, { id: USER_B, displayName: 'other-side' }, evidence, terminate,
    );
    assert.equal(sameId.displayName, 'same-id');
    const updated = await updateDirectoryUser(db, TENANT_A, USER_1, 'alpha-renamed', evidence, terminate);
    assert.equal(updated.displayName, 'alpha-renamed');
    const again = await getDirectoryUser(db, TENANT_B, USER_1, evidence, terminate);
    assert.equal(again.displayName, 'same-id');
    await assert.rejects(
      () => getDirectoryUser(db, TENANT_B, USER_2, evidence, terminate),
      (error: unknown) => failure(error, 'NOT_FOUND', 'The directory record was not found.'),
    );
    const listed = await listDirectoryUsers(db, TENANT_A, {}, evidence, terminate);
    assert.deepEqual(listed.map((user) => user.displayName), ['alpha-renamed', 'beta']);
    assert.deepEqual(
      (await listDirectoryUsers(db, TENANT_B, {}, evidence, terminate)).map((user) => user.displayName),
      ['same-id', 'other-side'],
    );
    const group = await createDirectoryGroup(
      db, TENANT_A, { id: GROUP_1, name: 'circle' }, evidence, terminate,
    );
    await assert.rejects(
      () => createDirectoryGroup(db, TENANT_A, { name: 'circle' }, evidence, terminate),
      (error: unknown) => failure(error, 'CONCURRENCY_CONFLICT', 'The directory record is in conflict.'),
    );
    const renamed = await updateDirectoryGroup(db, TENANT_A, group.id, 'circle-2', evidence, terminate);
    assert.equal(renamed.name, 'circle-2');
    const member = await addDirectoryMember(
      db, TENANT_A, { groupId: group.id, userId: second.id }, evidence, terminate,
    );
    const memberAgain = await addDirectoryMember(
      db, TENANT_A, { groupId: group.id, userId: second.id }, evidence, terminate,
    );
    assert.equal(memberAgain.id, member.id);
    assert.deepEqual(await listDirectoryMembers(db, TENANT_A, group.id, {}, evidence, terminate), [member]);
    assert.deepEqual(await listDirectoryGroups(db, TENANT_B, {}, evidence, terminate), []);
    await assert.rejects(
      () => addDirectoryMember(db, TENANT_A, { groupId: group.id, userId: onlyThere.id }, evidence, terminate),
      (error: unknown) => failure(error, 'NOT_FOUND', 'The directory record was not found.'),
    );
    await deleteDirectoryUser(db, TENANT_A, second.id, evidence, terminate);
    assert.deepEqual(await listDirectoryMembers(db, TENANT_A, group.id, {}, evidence, terminate), []);
    await assert.rejects(
      () => removeDirectoryMember(db, TENANT_A, member.id, evidence, terminate),
      (error: unknown) => failure(error, 'NOT_FOUND', 'The directory record was not found.'),
    );
    await deleteDirectoryGroup(db, TENANT_A, group.id, evidence, terminate);
    assert.deepEqual(await listDirectoryGroups(db, TENANT_A, {}, evidence, terminate), []);
    await deleteDirectoryUser(db, TENANT_A, USER_1, evidence, terminate);
    await assert.rejects(
      () => getDirectoryUser(db, TENANT_A, USER_1, evidence, terminate),
      (error: unknown) => error instanceof ContractFailure && error.code === 'NOT_FOUND',
    );
    assert.equal((await getDirectoryUser(db, TENANT_B, USER_1, evidence, terminate)).displayName, 'same-id');
  });
  const visible = new pg.Client({ connectionString: DIRECT });
  visible.on('error', () => undefined);
  await visible.connect();
  try {
    const result = await visible.query<{ count: string }>('SELECT count(*)::text AS count FROM kernel.directory_user');
    assert.equal(result.rows[0]?.count, '0');
  } finally {
    await visible.end();
  }
  const stored = await counts();
  assert.equal(stored.users, 2);
});

serial('user list is a bounded keyset', async () => {
  await resetDirectory();
  await withApp(async (db) => {
    const evidence = blankEvidence();
    for (let n = 1; n <= DIRECTORY_PAGE_MAX + 1; n += 1) {
      await createDirectoryUser(db, TENANT_A, { id: userId(n), displayName: `n-${n}` }, evidence, terminate);
    }
    const first = await listDirectoryUsers(db, TENANT_A, {}, evidence, terminate);
    assert.equal(first.length, DIRECTORY_PAGE_MAX);
    assert.equal(first[0]?.id, userId(1));
    assert.equal(first[DIRECTORY_PAGE_MAX - 1]?.id, userId(DIRECTORY_PAGE_MAX));
    const rest = await listDirectoryUsers(
      db, TENANT_A, { afterId: userId(DIRECTORY_PAGE_MAX) }, evidence, terminate,
    );
    assert.deepEqual(rest.map((user) => user.id), [userId(DIRECTORY_PAGE_MAX + 1)]);
    assert.deepEqual(await listDirectoryUsers(db, TENANT_B, {}, evidence, terminate), []);
  });
});

serial('registering an edge type is a row, and write_edge shares the fixture transaction', async () => {
  await resetDirectory();
  await migrateFixture();
  const sqlDir = join(here, '../sql');
  const sqlFiles = (): string[] => readdirSync(sqlDir).filter((name) => name.endsWith('.sql')).sort();
  const filesBefore = sqlFiles();
  const versionsBefore = await withRoot(async (client) => {
    const result = await client.query<{ version: string }>(
      'SELECT version FROM kernel.schema_migration ORDER BY version',
    );
    return result.rows.map((row) => row.version);
  });
  const fixture = readManifest(packageDir);
  const listed = listedManifest();
  assert.deepEqual(fixture.edgeTypes, []);
  assert.deepEqual(listed.edgeTypes, ['linked']);
  await withApp(async (db) => {
    const evidence = blankEvidence();
    await createDirectoryUser(db, TENANT_A, { id: USER_1, displayName: 'alpha' }, evidence, terminate);
    await createDirectoryUser(db, TENANT_A, { id: USER_2, displayName: 'beta' }, evidence, terminate);
    await assert.rejects(
      () => registerDirectoryEdgeType(db, TENANT_A, fixture, 'linked', evidence, terminate),
      (error: unknown) => failure(error, 'FORBIDDEN', 'The caller cannot register an edge type.'),
    );
    const registered = await registerDirectoryEdgeType(db, TENANT_A, listed, 'linked', evidence, terminate);
    assert.equal(registered.name, 'linked');
    assert.equal(registered.pluginId, PLUGIN);
    const again = await registerDirectoryEdgeType(db, TENANT_A, listed, 'linked', evidence, terminate);
    assert.equal(again.id, registered.id);
    await assert.rejects(
      () => registerDirectoryEdgeType(db, TENANT_A, listed, 'other', evidence, terminate),
      (error: unknown) => failure(error, 'FORBIDDEN', 'The edge type is not listed for this caller.'),
    );
    await assert.rejects(
      () => registerDirectoryEdgeType(db, TENANT_A, listedManifest('fixture_beta'), 'linked', evidence, terminate),
      (error: unknown) => failure(error, 'CONCURRENCY_CONFLICT', 'The directory record is in conflict.'),
    );
    await assert.rejects(
      () => withPluginRole(db, TENANT_A, PLUGIN, blankEvidence(), terminate, async (trx) => {
        await sql`
          INSERT INTO kernel.directory_edge (
            tenant_id, id, type_id, subject_user_id, object_user_id
          )
          VALUES (
            ${TENANT_A}::uuid,
            ${NOTE_1}::uuid,
            ${registered.id}::uuid,
            ${USER_1}::uuid,
            ${USER_2}::uuid
          )`.execute(trx);
      }),
      (error: unknown) => errorCode(error) === '42501',
    );
    assert.equal((await counts()).edges, 0);
    const edgeInput = { typeName: 'linked', subjectUserId: USER_1, objectUserId: USER_2 };
    await assert.rejects(
      () => inPinnedTransaction(db, TENANT_A, blankEvidence(), terminate, async (trx) => {
        await assertTenantContext(trx);
        await installPluginRole(trx, PLUGIN);
        await sql`
          INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
          VALUES (${TENANT_A}::uuid, ${NOTE_1}::uuid, 'alpha')`.execute(trx);
        await resumeSessionRole(trx);
        await brokerTenant(trx);
        await insertDirectoryEdge(trx, fixture, edgeInput);
      }),
      (error: unknown) => failure(error, 'FORBIDDEN', 'The edge type is not listed for this caller.'),
    );
    assert.deepEqual(await counts(), { users: 2, groups: 0, edges: 0, notes: 0, types: 1 });
    await assert.rejects(
      () => inPinnedTransaction(db, TENANT_A, blankEvidence(), terminate, async (trx) => {
        await assertTenantContext(trx);
        await insertDirectoryEdge(trx, listed, edgeInput);
        await installPluginRole(trx, PLUGIN);
        await sql`
          INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
          VALUES (${TENANT_A}::uuid, ${NOTE_2}::uuid, 'beta')`.execute(trx);
        throw new Error('rollback both');
      }),
      (error: unknown) => error instanceof Error && error.message === 'rollback both',
    );
    assert.deepEqual(await counts(), { users: 2, groups: 0, edges: 0, notes: 0, types: 1 });
    const written = await inPinnedTransaction(db, TENANT_A, blankEvidence(), terminate, async (trx) => {
      await assertTenantContext(trx);
      const edge = await insertDirectoryEdge(trx, listed, edgeInput);
      await installPluginRole(trx, PLUGIN);
      await sql`
        INSERT INTO plugin_fixture_alpha.note (tenant_id, id, body)
        VALUES (${TENANT_A}::uuid, ${NOTE_3}::uuid, 'kept')`.execute(trx);
      return edge;
    });
    const stored = await counts();
    assert.equal(stored.edges, 1);
    assert.equal(stored.notes, 1);
    const repeat = await inPinnedTransaction(db, TENANT_A, blankEvidence(), terminate, async (trx) => {
      return insertDirectoryEdge(trx, listed, edgeInput);
    });
    assert.equal(repeat.id, written.id);
    assert.equal((await counts()).edges, 1);
    const visible = await listDirectoryEdges(db, TENANT_A, { typeName: 'linked' }, evidence, terminate);
    assert.deepEqual(visible, [written]);
    assert.deepEqual(await listDirectoryEdges(db, TENANT_B, { typeName: 'linked' }, evidence, terminate), []);
    assert.deepEqual(await listDirectoryEdges(db, TENANT_A, { typeName: 'other' }, evidence, terminate), []);
    await deleteDirectoryUser(db, TENANT_A, USER_1, evidence, terminate);
    assert.equal((await counts()).edges, 0);
    assert.equal((await getDirectoryUser(db, TENANT_A, USER_2, evidence, terminate)).displayName, 'beta');
    assert.deepEqual(await listDirectoryEdges(db, TENANT_A, {}, evidence, terminate), []);
    await assert.rejects(
      () => deleteDirectoryEdge(db, TENANT_A, written.id, evidence, terminate),
      (error: unknown) => failure(error, 'NOT_FOUND', 'The directory record was not found.'),
    );
  });
  assert.deepEqual(sqlFiles(), filesBefore);
  const versionsAfter = await withRoot(async (client) => {
    const result = await client.query<{ version: string }>(
      'SELECT version FROM kernel.schema_migration ORDER BY version',
    );
    return result.rows.map((row) => row.version);
  });
  assert.deepEqual(versionsAfter, versionsBefore);
  assert.equal(versionsBefore.includes('0010_directory.sql'), true);
});
