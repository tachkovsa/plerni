// SPDX-License-Identifier: Apache-2.0
// Object grant inside one tenant (plan §5, K17). RLS hides other tenants.
// A principal with no grant row receives an empty result and the plugin
// statement does not run. The statement is fixture SQL, not a kernel table.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import { PluginPackageError } from './errors.ts';
import { assertFixtureRead } from './fixture-sql.ts';
import { assertPluginId } from './ident.ts';
import { installPluginRole, inPinnedTransaction } from './session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-z][a-z0-9_]{0,40}$/;

export interface PrincipalGrant {
  tenantId: string;
  principalId: string;
  pluginId: string;
  resource: string;
  action: string;
}

export interface PluginRead {
  tenantId: string;
  principalId: string;
  pluginId: string;
  resource: string;
  action: string;
  statement: string;
}

function assertUuid(value: string, label: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PluginPackageError(`${label} is not a uuid`);
}

function assertToken(value: string, label: string): void {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new PluginPackageError(`${label} is outside the grammar`);
}

async function holdsGrant(trx: Transaction<Database>, grant: PrincipalGrant): Promise<boolean> {
  const approved = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM kernel.plugin_grant
    WHERE plugin_id = ${grant.pluginId} AND grant_name = 'db.own_schema'`.execute(trx);
  if (!approved.rows[0]) throw new PluginPackageError('plugin is missing db.own_schema');
  const row = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM kernel.principal_grant
    WHERE tenant_id = ${grant.tenantId}::uuid
      AND principal_id = ${grant.principalId}::uuid
      AND plugin_id = ${grant.pluginId}
      AND resource = ${grant.resource}
      AND action = ${grant.action}`.execute(trx);
  return Boolean(row.rows[0]);
}

export async function allowPrincipal(
  db: Kysely<Database>,
  grant: PrincipalGrant,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  assertUuid(grant.tenantId, 'tenant id');
  assertUuid(grant.principalId, 'principal id');
  assertPluginId(grant.pluginId);
  assertToken(grant.resource, 'resource');
  assertToken(grant.action, 'action');
  await inPinnedTransaction(db, grant.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const approved = await sql<{ ok: number }>`
      SELECT 1 AS ok FROM kernel.plugin_grant
      WHERE plugin_id = ${grant.pluginId} AND grant_name = 'db.own_schema'`.execute(trx);
    if (!approved.rows[0]) throw new PluginPackageError('plugin is missing db.own_schema');
    await sql`
      INSERT INTO kernel.principal_grant (tenant_id, id, principal_id, plugin_id, resource, action)
      VALUES (
        ${grant.tenantId}::uuid,
        ${randomUUID()}::uuid,
        ${grant.principalId}::uuid,
        ${grant.pluginId},
        ${grant.resource},
        ${grant.action}
      )
      ON CONFLICT (tenant_id, principal_id, plugin_id, resource, action) DO NOTHING`.execute(trx);
  });
}

export async function readPluginRows(
  db: Kysely<Database>,
  read: PluginRead,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<readonly Record<string, unknown>[]> {
  assertUuid(read.tenantId, 'tenant id');
  assertUuid(read.principalId, 'principal id');
  assertPluginId(read.pluginId);
  assertToken(read.resource, 'resource');
  assertToken(read.action, 'action');
  assertFixtureRead(read.pluginId, read.statement);
  return inPinnedTransaction(db, read.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const allowed = await holdsGrant(trx, read);
    if (!allowed) return [];
    await installPluginRole(trx, read.pluginId);
    const result = await sql.raw(read.statement).execute(trx);
    return result.rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new PluginPackageError('plugin read returned a non-object row');
      }
      return row as Record<string, unknown>;
    });
  });
}
