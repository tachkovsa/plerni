// SPDX-License-Identifier: Apache-2.0
// Rescue codes and email reset tokens are stored hashed. Delivery of the
// reset message is a later notification task. This function returns the
// token once and does not log it. A disabled account stays disabled.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { RESET_MINUTES, canonicalEmail, canonicalUuid, type IdentityContext } from './context.ts';
import { AccountDisabledError, LoginRejectedError } from './errors.ts';
import { hashPassword } from './password.ts';
import { rescueCodeMatches } from './rescue.ts';
import { bumpEpoch, notifyIdentity, revokeSessions, writeAuthAudit } from './store.ts';
import { newSecretToken, sha256Hex } from './token.ts';

async function rejectDisabled(trx: Transaction<Database>, tenantId: string, userId: string): Promise<void> {
  const result = await sql<{ disabled: boolean }>`
    SELECT (disabled_at IS NOT NULL) AS disabled
    FROM kernel.user_auth_state
    WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid
    FOR UPDATE`.execute(trx);
  if (result.rows[0]?.disabled) throw new AccountDisabledError();
}

async function replacePassword(
  trx: Transaction<Database>,
  tenantId: string,
  userId: string,
  passwordHash: string,
  action: 'rescue' | 'reset',
): Promise<void> {
  await sql`
    UPDATE kernel.user_account
    SET password_hash = ${passwordHash}
    WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid`.execute(trx);
  const epoch = await bumpEpoch(trx, tenantId, userId);
  await revokeSessions(trx, tenantId, userId);
  await writeAuthAudit(trx, {
    tenantId,
    action,
    actorUserId: userId,
    targetUserId: userId,
    sessionHash: null,
    epochBefore: epoch.before,
    epochAfter: epoch.after,
    reason: action,
  });
  await notifyIdentity(trx);
}

export async function requestPasswordReset(
  db: Kysely<Database>,
  input: { tenantId: string; email: string },
  ctx: IdentityContext,
): Promise<{ accepted: true; token?: string }> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const issued = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const found = await sql<{ id: string; disabled: boolean }>`
      SELECT u.id::text AS id, (s.disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.email = ${email}`.execute(trx);
    const account = found.rows[0];
    if (!account || account.disabled) return null;
    const token = newSecretToken();
    await sql`
      INSERT INTO kernel.password_reset (tenant_id, id, user_id, token_hash, expires_at)
      VALUES (
        ${tenantId}::uuid,
        ${randomUUID()}::uuid,
        ${account.id}::uuid,
        ${sha256Hex(token)},
        clock_timestamp() + make_interval(mins => ${RESET_MINUTES}::int)
      )`.execute(trx);
    return token;
  });
  ctx.log.event('password.reset', { tenantId, action: 'reset', outcome: 'accepted' });
  if (!issued) return { accepted: true };
  return { accepted: true, token: issued };
}

export async function confirmPasswordReset(
  db: Kysely<Database>,
  input: { tenantId: string; token: string; password: string },
  ctx: IdentityContext,
): Promise<void> {
  const tenantId = canonicalUuid(input.tenantId);
  const tokenHash = sha256Hex(input.token);
  const passwordHash = await hashPassword(input.password);
  await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const found = await sql<{ id: string; user_id: string; expired: boolean; consumed: boolean }>`
      SELECT id::text AS id, user_id::text AS user_id,
             (expires_at <= clock_timestamp()) AS expired,
             (consumed_at IS NOT NULL) AS consumed
      FROM kernel.password_reset
      WHERE tenant_id = ${tenantId}::uuid AND token_hash = ${tokenHash}
      FOR UPDATE`.execute(trx);
    const row = found.rows[0];
    if (!row || row.expired || row.consumed) throw new LoginRejectedError();
    await rejectDisabled(trx, tenantId, row.user_id);
    const consumed = await sql<{ id: string }>`
      UPDATE kernel.password_reset
      SET consumed_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${row.id}::uuid AND consumed_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!consumed.rows[0]) throw new LoginRejectedError();
    await replacePassword(trx, tenantId, row.user_id, passwordHash, 'reset');
  });
  ctx.log.event('password.reset', { tenantId, action: 'reset', outcome: 'accepted' });
}

export async function recoverWithRescueCode(
  db: Kysely<Database>,
  input: { tenantId: string; email: string; code: string; password: string },
  ctx: IdentityContext,
): Promise<void> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const found = await sql<{ id: string; disabled: boolean }>`
      SELECT u.id::text AS id, (s.disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.email = ${email}
      FOR UPDATE OF s`.execute(trx);
    const account = found.rows[0];
    if (!account) throw new LoginRejectedError();
    if (account.disabled) throw new AccountDisabledError();
    const codes = await sql<{ id: string; code_hash: string }>`
      SELECT id::text AS id, code_hash
      FROM kernel.rescue_code
      WHERE tenant_id = ${tenantId}::uuid AND user_id = ${account.id}::uuid AND consumed_at IS NULL
      FOR UPDATE`.execute(trx);
    let matched: string | null = null;
    for (const row of codes.rows) {
      if (await rescueCodeMatches(row.code_hash, input.code)) {
        matched = row.id;
        break;
      }
    }
    if (!matched) throw new LoginRejectedError();
    const consumed = await sql<{ id: string }>`
      UPDATE kernel.rescue_code
      SET consumed_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${matched}::uuid AND consumed_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!consumed.rows[0]) throw new LoginRejectedError();
    await replacePassword(trx, tenantId, account.id, passwordHash, 'rescue');
  });
  ctx.log.event('account.rescue', { tenantId, action: 'rescue', outcome: 'accepted' });
}
