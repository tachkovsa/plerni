// SPDX-License-Identifier: Apache-2.0
import { openKernelDb } from '../src/db/pool.ts';
import { terminateBackendByPid } from '../src/db/terminate.ts';
import { applyKernelMigrations } from '../src/schema/migrate.ts';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/database.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function dsn(user: string, password: string, port: number, database: string): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

const appPassword = required('PLERNI_APP_PASSWORD');
const migratePassword = required('PLERNI_MIGRATE_PASSWORD');
const rootPassword = required('POSTGRES_PASSWORD');

export const DIRECT = dsn('plerni_app', appPassword, 54320, 'plerni');
export const POOLED = dsn('plerni_app', appPassword, 54321, 'plerni');
export const MIGRATE = dsn('plerni_migrate', migratePassword, 54320, 'plerni');
export const ROOT = dsn('postgres', rootPassword, 54320, 'plerni');

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';
export const SHARED_ID = '00000000-0000-4000-8000-0000000000a1';

export const terminate = terminateBackendByPid(ROOT);

export function appDb(connectionString: string, max = 4): Kysely<Database> {
  return openKernelDb(connectionString, max);
}

let migrated: Promise<void> | undefined;

export function ready(): Promise<void> {
  migrated ??= applyKernelMigrations(MIGRATE).then(() => undefined);
  return migrated;
}
