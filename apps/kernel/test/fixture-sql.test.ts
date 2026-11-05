// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Database } from '../src/db/database.ts';
import { PluginPackageError } from '../src/plugin/errors.ts';
import { assertFixtureRead, checkFixtureSql } from '../src/plugin/fixture-sql.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const fixtureSql = readFileSync(join(repo, 'plugins/fixture_alpha/sql/0001_note.sql'), 'utf8');

type PluginTable = Extract<keyof Database, 'note'>;
const databaseHasNoPluginTable: PluginTable extends never ? true : never = true;
void databaseHasNoPluginTable;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

test('the fixture migration is schema-qualified and has no function', () => {
  assert.deepEqual(checkFixtureSql('fixture_alpha', fixtureSql), []);
});

test('unqualified table names are rejected', () => {
  const sqlText = `CREATE TABLE note (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    body text NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );`;
  const codes = checkFixtureSql('fixture_alpha', sqlText).map((item) => item.code);
  assert.ok(codes.includes('unqualified_table'), codes.join(','));
});

test('another plugin schema is rejected', () => {
  const sqlText = `CREATE TABLE plugin_beta.note (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    body text NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );`;
  const codes = checkFixtureSql('fixture_alpha', sqlText).map((item) => item.code);
  assert.ok(codes.includes('foreign_schema'), codes.join(','));
});

test('a quoted unqualified table name is rejected', () => {
  const codes = checkFixtureSql('fixture_alpha', 'CREATE TABLE "note" (id uuid);').map((item) => item.code);
  assert.deepEqual(codes, ['unsupported']);
});

test('an unlogged table in another plugin schema is rejected', () => {
  const codes = checkFixtureSql('fixture_alpha', 'CREATE UNLOGGED TABLE plugin_beta.note (id uuid);').map((item) => item.code);
  assert.deepEqual(codes, ['unsupported']);
});

test('a multi-table drop that includes another schema is rejected', () => {
  const codes = checkFixtureSql(
    'fixture_alpha',
    'DROP TABLE plugin_fixture_alpha.note, plugin_beta.note;',
  ).map((item) => item.code);
  assert.deepEqual(codes, ['unsupported']);
});

test('grant on a table without the table keyword checks every target', () => {
  const foreign = checkFixtureSql(
    'fixture_alpha',
    'GRANT SELECT ON plugin_beta.note TO plerni_plugin_fixture_alpha;',
  );
  assert.ok(foreign.some((item) => item.code === 'foreign_schema' && item.detail === 'plugin_beta.note'));
  const own = checkFixtureSql(
    'fixture_alpha',
    'GRANT SELECT ON plugin_fixture_alpha.note TO plerni_plugin_fixture_alpha;',
  );
  assert.deepEqual(own, []);
  const listed = checkFixtureSql(
    'fixture_alpha',
    'GRANT SELECT ON plugin_fixture_alpha.note, plugin_beta.note TO plerni_plugin_fixture_alpha;',
  );
  assert.ok(listed.some((item) => item.code === 'foreign_schema' && item.detail === 'plugin_beta.note'));
});

test('every relation in a from list is checked', () => {
  const copied = checkFixtureSql(
    'fixture_alpha',
    'CREATE TABLE plugin_fixture_alpha.copy AS SELECT b.* FROM plugin_fixture_alpha.note a, plugin_beta.note b;',
  );
  assert.ok(copied.some((item) => item.code === 'foreign_schema' && item.detail.toLowerCase() === 'plugin_beta.note'));
  const own = checkFixtureSql(
    'fixture_alpha',
    'SELECT id FROM plugin_fixture_alpha.note a, plugin_fixture_alpha.note b;',
  );
  assert.deepEqual(own, []);
});

test('a read that changes the tenant context is rejected', () => {
  const direct = "SELECT set_config('plerni.tenant_id', '22222222-2222-2222-2222-222222222222', true)";
  const nested = `SELECT id FROM plugin_fixture_alpha.note WHERE (
    SELECT set_config('plerni.tenant_id', '22222222-2222-2222-2222-222222222222', true)
  ) IS NOT NULL`;
  for (const sqlText of [direct, nested]) {
    const found = checkFixtureSql('fixture_alpha', sqlText);
    assert.ok(found.some((item) => item.code === 'context'), sqlText);
    assert.throws(
      () => assertFixtureRead('fixture_alpha', sqlText),
      (error: unknown) => error instanceof PluginPackageError,
    );
  }
});

test('alter table set schema to another plugin is rejected', () => {
  const found = checkFixtureSql(
    'fixture_alpha',
    'ALTER TABLE plugin_fixture_alpha.note SET SCHEMA plugin_beta;',
  );
  assert.ok(found.some((item) => item.code === 'foreign_schema' && item.detail === 'plugin_beta'));
});

test('a table query expression from another schema is rejected', () => {
  const found = checkFixtureSql(
    'fixture_alpha',
    'INSERT INTO plugin_fixture_alpha.note TABLE plugin_beta.note;',
  );
  assert.ok(found.some((item) => item.code === 'foreign_schema' && item.detail.toLowerCase() === 'plugin_beta.note'));
});

test('an aliased update of another schema is rejected', () => {
  const found = checkFixtureSql(
    'fixture_alpha',
    "UPDATE plugin_beta.note AS b SET body = 'changed';",
  );
  assert.ok(found.some((item) => item.code === 'foreign_schema' && item.detail.toLowerCase() === 'plugin_beta.note'));
});

test('source relations after union and in a where subquery are checked', () => {
  const union = checkFixtureSql(
    'fixture_alpha',
    'CREATE TABLE plugin_fixture_alpha.copy AS SELECT * FROM plugin_fixture_alpha.note UNION ALL SELECT * FROM plugin_beta.note;',
  );
  assert.ok(union.some((item) => item.code === 'foreign_schema' && item.detail.toLowerCase() === 'plugin_beta.note'));
  const nested = checkFixtureSql(
    'fixture_alpha',
    'SELECT id FROM plugin_fixture_alpha.note WHERE id IN (SELECT id FROM plugin_beta.note);',
  );
  assert.ok(nested.some((item) => item.code === 'foreign_schema' && item.detail.toLowerCase() === 'plugin_beta.note'));
});

test('grant recipients are only the owning plugin role', () => {
  const samples = [
    'GRANT USAGE ON SCHEMA plugin_fixture_alpha TO PUBLIC;',
    'GRANT SELECT ON TABLE plugin_fixture_alpha.note TO PUBLIC;',
    'GRANT SELECT ON TABLE plugin_fixture_alpha.note TO plerni_plugin_beta;',
  ];
  for (const sqlText of samples) {
    const found = checkFixtureSql('fixture_alpha', sqlText);
    assert.ok(found.some((item) => item.code === 'privilege'), sqlText);
  }
  const own = checkFixtureSql(
    'fixture_alpha',
    'GRANT SELECT ON TABLE plugin_fixture_alpha.note TO plerni_plugin_fixture_alpha;',
  );
  assert.deepEqual(own, []);
});

test('grant all and other non-dml privileges are rejected', () => {
  const samples = [
    'GRANT ALL ON TABLE plugin_fixture_alpha.note TO plerni_plugin_fixture_alpha;',
    'GRANT TRUNCATE ON TABLE plugin_fixture_alpha.note TO plerni_plugin_fixture_alpha;',
  ];
  for (const sqlText of samples) {
    const found = checkFixtureSql('fixture_alpha', sqlText);
    assert.ok(found.some((item) => item.code === 'privilege'), sqlText);
  }
});

test('a multi-table truncate that includes another schema is rejected', () => {
  const codes = checkFixtureSql(
    'fixture_alpha',
    'TRUNCATE plugin_fixture_alpha.note, plugin_beta.note;',
  ).map((item) => item.code);
  assert.deepEqual(codes, ['unsupported']);
});

test('functions, triggers, and DO blocks are rejected', () => {
  const samples = [
    'CREATE FUNCTION plugin_fixture_alpha.touch() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
    'CREATE TRIGGER touch BEFORE INSERT ON plugin_fixture_alpha.note EXECUTE FUNCTION plugin_fixture_alpha.touch();',
    'DO $$ BEGIN PERFORM 1; END $$;',
  ];
  for (const sqlText of samples) {
    const codes = checkFixtureSql('fixture_alpha', sqlText).map((item) => item.code);
    assert.ok(codes.includes('function'), sqlText);
  }
});

test('kernel source and kernel sql do not name the fixture schema', () => {
  const roots = [join(repo, 'apps/kernel/src'), join(repo, 'apps/kernel/sql')];
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('fixture_alpha') || text.includes('plugin_fixture')) hits.push(file);
    }
  }
  assert.deepEqual(hits, []);
});
