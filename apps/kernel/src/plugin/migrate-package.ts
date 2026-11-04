// SPDX-License-Identifier: Apache-2.0
// Apply one in-repo package. Kernel SQL and the kernel Database interface are
// not edited to name the package schema (ADR-0008 decision 5, plan K17).
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type pg from 'pg';
import { PluginPackageError } from './errors.ts';
import { checkFixtureSql } from './fixture-sql.ts';
import { readManifest } from './manifest.ts';
import { ensurePluginRole } from './role.ts';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export interface MigratePluginOptions {
  /** Direct connection allowed to CREATE ROLE. Not the request role and not plerni_migrate. */
  admin: Queryable;
  /** Unpooled migration role. CREATE on the package schema only. */
  migrate: Queryable;
  packageDir: string;
}

function packageFile(packageDir: string, rel: string): string {
  const root = resolve(packageDir);
  const full = resolve(root, rel);
  const fromRoot = relative(root, full);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || fromRoot.split(sep).includes('..')) {
    throw new PluginPackageError('migration path leaves the package');
  }
  return full;
}

export async function migratePluginPackage(options: MigratePluginOptions): Promise<readonly string[]> {
  const manifest = readManifest(options.packageDir);
  const files = manifest.migrations.map((rel) => {
    const full = packageFile(options.packageDir, rel);
    const sqlText = readFileSync(full, 'utf8');
    const violations = checkFixtureSql(manifest.id, sqlText);
    if (violations.length > 0) {
      const summary = violations.map((item) => `${item.code}:${item.detail}`).join(', ');
      throw new PluginPackageError(`fixture sql rejected: ${summary}`);
    }
    return { version: rel.slice('sql/'.length), sqlText };
  });
  await ensurePluginRole(options.admin, manifest.id);
  const applied: string[] = [];
  await options.migrate.query('BEGIN');
  try {
    const existing = await options.migrate.query<{ version: string }>(
      'SELECT version FROM kernel.plugin_migration WHERE plugin_id = $1',
      [manifest.id],
    );
    const have = new Set(existing.rows.map((row) => row.version));
    for (const file of files) {
      if (have.has(file.version)) continue;
      await options.migrate.query(file.sqlText);
      await options.migrate.query(
        'INSERT INTO kernel.plugin_migration (plugin_id, version) VALUES ($1, $2)',
        [manifest.id, file.version],
      );
      applied.push(file.version);
    }
    await options.migrate.query('DELETE FROM kernel.plugin_grant WHERE plugin_id = $1', [manifest.id]);
    for (const grant of manifest.grants) {
      await options.migrate.query(
        'INSERT INTO kernel.plugin_grant (plugin_id, grant_name) VALUES ($1, $2)',
        [manifest.id, grant],
      );
    }
    await options.migrate.query('COMMIT');
    return applied;
  } catch (error) {
    await options.migrate.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
