// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type pg from 'pg';
import { migratePluginPackage } from '../src/plugin/migrate-package.ts';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

function recordingClient(scripts: string[]): Queryable {
  return {
    async query(text: string) {
      scripts.push(text);
      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as pg.QueryResult;
    },
  };
}

test('package migrations run in bytewise path order when the manifest lists them reversed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plerni-order-'));
  const adminSql: string[] = [];
  const migrateSql: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(
      join(import.meta.dirname, '../../../plugins/fixture_alpha/manifest.json'),
      'utf8',
    )) as Record<string, unknown>;
    mkdirSync(join(dir, 'sql'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      ...manifest,
      id: 'sort_check',
      permissions: [],
      migrations: ['sql/0002_second.sql', 'sql/0001_first.sql'],
    }));
    writeFileSync(
      join(dir, 'sql/0002_second.sql'),
      'CREATE TABLE plugin_sort_check.second_table (id uuid);\n',
    );
    writeFileSync(
      join(dir, 'sql/0001_first.sql'),
      'CREATE TABLE plugin_sort_check.first_table (id uuid);\n',
    );
    const applied = await migratePluginPackage({
      admin: recordingClient(adminSql),
      migrate: recordingClient(migrateSql),
      packageDir: dir,
    });
    assert.deepEqual(applied, ['0001_first.sql', '0002_second.sql']);
    const first = migrateSql.findIndex((sql) => sql.includes('first_table'));
    const second = migrateSql.findIndex((sql) => sql.includes('second_table'));
    assert.ok(first >= 0 && second >= 0);
    assert.ok(first < second, migrateSql.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
