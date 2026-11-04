// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Database } from '../src/db/database.ts';
import { checkFixtureSql } from '../src/plugin/fixture-sql.ts';

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
