// SPDX-License-Identifier: Apache-2.0
// Applies kernel SQL in filename order and records it in the journal.
// Kysely's migrator is not this journal (ADR-0002 decision 4).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inspectKernelInternal } from './kernel-internal.ts';
import { inspectTenantTable } from './tenant-table.ts';

const SQL_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/;

const SCOPED_LINK_FK = 'FOREIGN KEY (tenant_id, row_id) REFERENCES kernel.scoped_row(tenant_id, id)';

export async function applyKernelMigrations(connectionString: string): Promise<readonly string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../sql');
  const files = readdirSync(dir).filter((name) => SQL_NAME.test(name)).sort();
  const client = new pg.Client({ connectionString });
  client.on('error', () => undefined);
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS kernel');
    await client.query(
      `CREATE TABLE IF NOT EXISTS kernel.schema_migration (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    );
    const existing = await client.query<{ version: string }>('SELECT version FROM kernel.schema_migration');
    const have = new Set(existing.rows.map((row) => row.version));
    for (const name of files) {
      if (!SQL_NAME.test(name) || have.has(name)) continue;
      await client.query(readFileSync(join(dir, name), 'utf8'));
      await client.query('INSERT INTO kernel.schema_migration (version) VALUES ($1)', [name]);
      applied.push(name);
    }
    const violations = [
      ...(await inspectTenantTable(client, { schema: 'kernel', table: 'scoped_row' })),
      ...(await inspectTenantTable(client, { schema: 'kernel', table: 'scoped_link', foreignKey: SCOPED_LINK_FK })),
      ...(await inspectTenantTable(client, { schema: 'kernel', table: 'audit_record' })),
      ...(await inspectTenantTable(client, { schema: 'kernel', table: 'principal_grant' })),
    ];
    if (violations.length > 0) {
      const summary = violations.map((item) => `${item.table}:${item.code}`).join(', ');
      throw new Error(`kernel tenant tables failed the shape check: ${summary}`);
    }
    const internal = [
      ...(await inspectKernelInternal(client, 'tenants')),
      ...(await inspectKernelInternal(client, 'tenant_idempotency')),
      ...(await inspectKernelInternal(client, 'outbox')),
      ...(await inspectKernelInternal(client, 'outbox_seq')),
      ...(await inspectKernelInternal(client, 'subscription')),
      ...(await inspectKernelInternal(client, 'delivery')),
      ...(await inspectKernelInternal(client, 'dead_letter')),
      ...(await inspectKernelInternal(client, 'plugin_grant')),
      ...(await inspectKernelInternal(client, 'plugin_migration')),
    ];
    if (internal.length > 0) {
      throw new Error(`kernel-internal relations failed the shape check: ${internal.join(', ')}`);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
