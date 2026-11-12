// SPDX-License-Identifier: Apache-2.0
// Tenant-scoped service principals (plan §5.2, K5). The credential is returned
// once and stored as sha256. The scope is the declared permission list.
// K7 denies this credential on sensitive and destructive routes.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { PluginPackageError } from '../plugin/errors.ts';
import { assertGrantName } from '../plugin/grants.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalUuid, leaseOf, type IdentityContext } from './context.ts';
import { IdentityForbiddenError, IdentityValidationError, PrincipalNotFoundError, SessionRejectedError } from './errors.ts';
import { requireSession } from './session.ts';
import { postgresCode, writeAuditRecord } from './store.ts';
import { newSecretToken, presentedToken, sha256Hex } from './token.ts';

const MAX_PERMISSIONS = 16;
const MAX_DAYS = 90;

export interface ServicePrincipalRecord {
  id: string;
  permissions: readonly string[];
  expiresAt: string;
  credential: string;
}

export interface AuthenticatedPrincipal {
  tenantId: string;
  principalId: string;
  permissions: readonly string[];
}

interface PrincipalRow {
  id: string;
  revoked: boolean;
  expired: boolean;
  expires_at: Date | string;
}

function declaredPermissions(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_PERMISSIONS) throw new IdentityValidationError();
  const seen = new Set<string>();
  for (const value of values) {
    try {
      assertGrantName(value);
    } catch (error) {
      if (error instanceof PluginPackageError) throw new IdentityValidationError();
      throw error;
    }
    if (seen.has(value)) throw new IdentityValidationError();
    seen.add(value);
  }
  return [...seen].sort();
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('service principal expiry is unreadable');
  return date.toISOString();
}

function isDateError(error: unknown): boolean {
  const code = postgresCode(error);
  return code === '22007' || code === '22008' || code === '22009';
}

async function requireAdmin(
  trx: Transaction<Database>,
  tenantId: string,
  token: string,
  ctx: IdentityContext,
): Promise<string> {
  const live = await requireSession(trx, tenantId, token, 'sensitive', leaseOf(ctx));
  if (live.sessionKind !== 'admin') throw new IdentityForbiddenError();
  return live.userId;
}

async function permissionsOf(
  trx: Transaction<Database>,
  tenantId: string,
  principalId: string,
): Promise<string[]> {
  const result = await sql<{ permission: string }>`
    SELECT permission
    FROM kernel.service_principal_scope
    WHERE tenant_id = ${tenantId}::uuid AND principal_id = ${principalId}::uuid
    ORDER BY permission`.execute(trx);
  return result.rows.map((row) => row.permission);
}

async function assertExpiry(trx: Transaction<Database>, expiresAt: string): Promise<void> {
  try {
    const window = await sql<{ future: boolean; bounded: boolean }>`
      SELECT
        ${expiresAt}::timestamptz > clock_timestamp() AS future,
        ${expiresAt}::timestamptz <= clock_timestamp() + make_interval(days => ${MAX_DAYS}::int) AS bounded`.execute(trx);
    const row = window.rows[0];
    if (!row?.future || !row.bounded) throw new IdentityValidationError();
  } catch (error) {
    if (error instanceof IdentityValidationError || !isDateError(error)) throw error;
    throw new IdentityValidationError();
  }
}

async function insertCredential(
  trx: Transaction<Database>,
  tenantId: string,
  principalId: string,
  expiresAt: Date | string,
): Promise<string> {
  const credential = newSecretToken();
  await sql`
    INSERT INTO kernel.service_credential (tenant_id, id, principal_id, token_hash, expires_at)
    VALUES (
      ${tenantId}::uuid,
      ${randomUUID()}::uuid,
      ${principalId}::uuid,
      ${sha256Hex(credential)},
      ${expiresAt}::timestamptz
    )`.execute(trx);
  return credential;
}

async function lockPrincipal(
  trx: Transaction<Database>,
  tenantId: string,
  principalId: string,
): Promise<PrincipalRow> {
  const result = await sql<PrincipalRow>`
    SELECT id::text AS id,
           (revoked_at IS NOT NULL) AS revoked,
           (expires_at <= clock_timestamp()) AS expired,
           expires_at
    FROM kernel.service_principal
    WHERE tenant_id = ${tenantId}::uuid AND id = ${principalId}::uuid
    FOR UPDATE`.execute(trx);
  const row = result.rows[0];
  if (!row) throw new PrincipalNotFoundError();
  return row;
}

export async function provisionServicePrincipal(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  input: { permissions: readonly string[]; expiresAt: string },
  ctx: IdentityContext,
): Promise<ServicePrincipalRecord> {
  const tenantId = canonicalUuid(actor.tenantId);
  const record = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const createdBy = await requireAdmin(trx, tenantId, actor.token, ctx);
    const permissions = declaredPermissions(input.permissions);
    await assertExpiry(trx, input.expiresAt);
    const principalId = randomUUID();
    const inserted = await sql<{ id: string; expires_at: Date | string }>`
      INSERT INTO kernel.service_principal (tenant_id, id, created_by, expires_at)
      VALUES (
        ${tenantId}::uuid,
        ${principalId}::uuid,
        ${createdBy}::uuid,
        ${input.expiresAt}::timestamptz
      )
      RETURNING id::text AS id, expires_at`.execute(trx);
    const row = inserted.rows[0];
    if (!row) throw new Error('service principal was not stored');
    for (const permission of permissions) {
      await sql`
        INSERT INTO kernel.service_principal_scope (tenant_id, id, principal_id, permission)
        VALUES (
          ${tenantId}::uuid,
          ${randomUUID()}::uuid,
          ${row.id}::uuid,
          ${permission}
        )`.execute(trx);
    }
    const credential = await insertCredential(trx, tenantId, row.id, row.expires_at);
    await writeAuditRecord(trx, tenantId, 'service_principal.provision');
    return { id: row.id, permissions, expiresAt: iso(row.expires_at), credential };
  });
  ctx.log.event('principal.provision', { tenantId, principalId: record.id, action: 'provision' });
  return record;
}

export async function rotateServicePrincipal(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  principalId: string,
  ctx: IdentityContext,
): Promise<ServicePrincipalRecord> {
  const tenantId = canonicalUuid(actor.tenantId);
  const id = canonicalUuid(principalId);
  const record = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    await requireAdmin(trx, tenantId, actor.token, ctx);
    const principal = await lockPrincipal(trx, tenantId, id);
    if (principal.revoked || principal.expired) throw new IdentityForbiddenError();
    await sql`
      UPDATE kernel.service_credential
      SET revoked_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid
        AND principal_id = ${id}::uuid
        AND revoked_at IS NULL`.execute(trx);
    const credential = await insertCredential(trx, tenantId, id, principal.expires_at);
    const permissions = await permissionsOf(trx, tenantId, id);
    await writeAuditRecord(trx, tenantId, 'service_principal.rotate');
    return { id, permissions, expiresAt: iso(principal.expires_at), credential };
  });
  ctx.log.event('principal.rotate', { tenantId, principalId: id, action: 'rotate' });
  return record;
}

export async function revokeServicePrincipal(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  principalId: string,
  ctx: IdentityContext,
): Promise<{ id: string; revoked: true }> {
  const tenantId = canonicalUuid(actor.tenantId);
  const id = canonicalUuid(principalId);
  await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    await requireAdmin(trx, tenantId, actor.token, ctx);
    const principal = await lockPrincipal(trx, tenantId, id);
    if (!principal.revoked) {
      await sql`
        UPDATE kernel.service_principal
        SET revoked_at = clock_timestamp()
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND revoked_at IS NULL`.execute(trx);
      await sql`
        UPDATE kernel.service_credential
        SET revoked_at = clock_timestamp()
        WHERE tenant_id = ${tenantId}::uuid
          AND principal_id = ${id}::uuid
          AND revoked_at IS NULL`.execute(trx);
      await writeAuditRecord(trx, tenantId, 'service_principal.revoke');
    }
  });
  ctx.log.event('principal.revoke', { tenantId, principalId: id, action: 'revoke' });
  return { id, revoked: true };
}

export async function authenticateServicePrincipal(
  db: Kysely<Database>,
  input: { tenantId: string; token: string },
  ctx: IdentityContext,
): Promise<AuthenticatedPrincipal> {
  const tenantId = canonicalUuid(input.tenantId);
  const tokenHash = presentedToken(input.token);
  if (!tokenHash) throw new SessionRejectedError();
  try {
    return await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
      await assertTenantContext(trx);
      const found = await sql<{ id: string }>`
        SELECT p.id::text AS id
        FROM kernel.service_credential c
        JOIN kernel.service_principal p
          ON p.tenant_id = c.tenant_id AND p.id = c.principal_id
        WHERE c.tenant_id = ${tenantId}::uuid
          AND c.token_hash = ${tokenHash}
          AND c.revoked_at IS NULL
          AND p.revoked_at IS NULL
          AND c.expires_at > clock_timestamp()
          AND p.expires_at > clock_timestamp()`.execute(trx);
      const row = found.rows[0];
      if (!row || found.rows.length !== 1) throw new SessionRejectedError();
      const permissions = await permissionsOf(trx, tenantId, row.id);
      return { tenantId, principalId: row.id, permissions };
    });
  } catch (error) {
    if (error instanceof SessionRejectedError) {
      ctx.log.event('principal.rejected', { tenantId, outcome: 'rejected' });
    }
    throw error;
  }
}
