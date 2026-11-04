// SPDX-License-Identifier: Apache-2.0
// One NOBYPASSRLS role per plugin (ADR-0008 decision 2). Membership is
// INHERIT FALSE, SET TRUE so the app role gains the privileges only while
// SET LOCAL ROLE is in force. The migration role cannot create roles.
import type pg from 'pg';
import { pluginRoleName, quoteIdent } from './ident.ts';

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export async function ensurePluginRole(admin: Queryable, pluginId: string): Promise<void> {
  const role = pluginRoleName(pluginId);
  const ident = quoteIdent(role);
  const attributes = 'NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE';
  const existing = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if ((existing.rowCount ?? 0) === 0) {
    await admin.query(`CREATE ROLE ${ident} ${attributes}`);
  } else {
    await admin.query(`ALTER ROLE ${ident} ${attributes}`);
  }
  await admin.query(`GRANT ${ident} TO plerni_app WITH INHERIT FALSE, SET TRUE`);
}
