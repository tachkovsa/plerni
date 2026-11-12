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
import { AccountDisabledError, LoginRejectedError, ThrottledError } from './errors.ts';
import { hashPassword } from './password.ts';
import { rescueCodeMatches } from './rescue.ts';
import { bumpEpoch, notifyIdentity, revokeSessions, writeAuthAudit } from './store.ts';
import { clearFailures, recoverySubject, reserveAttempt, resetSubject } from './throttle.ts';
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
  await sql`
    UPDATE kernel.password_reset
    SET consumed_at = clock_timestamp()
    WHERE tenant_id = ${tenantId}::uuid
      AND user_id = ${userId}::uuid
      AND consumed_at IS NULL`.execute(trx);
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

export interface IssueResetHooks {
  /** Runs before the throttle row is locked, so concurrent requests can arrive together. */
  beforeReserve?(trx: Transaction<Database>): Promise<void>;
  /** Runs after the token insert, while the auth-state row lock is still held. */
  afterInsert?(trx: Transaction<Database>): Promise<void>;
}

export async function requestPasswordReset(
  db: Kysely<Database>,
  input: { tenantId: string; email: string },
  ctx: IdentityContext,
  hooks: IssueResetHooks = {},
): Promise<{ accepted: true; token?: string }> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const subject = resetSubject(email);
  const issued = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    if (hooks.beforeReserve) await hooks.beforeReserve(trx);
    const found = await sql<{ id: string; disabled: boolean }>`
      SELECT u.id::text AS id, (s.disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.email = ${email}`.execute(trx);
    const account = found.rows[0];
    if (!account || account.disabled) return null;
    const slot = await reserveAttempt(trx, tenantId, subject);
    if (slot === 'throttled') return 'throttled' as const;
    const locked = await sql<{ id: string; disabled: boolean }>`
      SELECT u.id::text AS id, (s.disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.id = ${account.id}::uuid
      FOR UPDATE OF s`.execute(trx);
    const current = locked.rows[0];
    if (!current || current.disabled) return null;
    const token = newSecretToken();
    await sql`
      INSERT INTO kernel.password_reset (tenant_id, id, user_id, token_hash, expires_at)
      VALUES (
        ${tenantId}::uuid,
        ${randomUUID()}::uuid,
        ${current.id}::uuid,
        ${sha256Hex(token)},
        clock_timestamp() + make_interval(mins => ${RESET_MINUTES}::int)
      )`.execute(trx);
    if (hooks.afterInsert) await hooks.afterInsert(trx);
    return token;
  });
  if (issued === 'throttled') {
    ctx.log.event('password.reset', { tenantId, action: 'reset', outcome: 'throttled' });
    return { accepted: true };
  }
  ctx.log.event('password.reset', { tenantId, action: 'reset', outcome: 'accepted' });
  if (!issued) return { accepted: true };
  return { accepted: true, token: issued };
}

export interface ResetHooks {
  /** Runs after the token is found and before the new password is hashed. */
  afterLookup?(): Promise<void>;
}

export interface RescueHooks {
  /** Runs before the throttle row is locked, so concurrent attempts can arrive together. */
  beforeReserve?(trx: Transaction<Database>): Promise<void>;
  /** Runs in the password-replacement transaction before the auth-state lock. */
  beforeReplace?(trx: Transaction<Database>): Promise<void>;
}

export async function confirmPasswordReset(
  db: Kysely<Database>,
  input: { tenantId: string; token: string; password: string },
  ctx: IdentityContext,
  hooks: ResetHooks = {},
): Promise<void> {
  const tenantId = canonicalUuid(input.tenantId);
  const tokenHash = sha256Hex(input.token);
  const found = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const rows = await sql<{ id: string; user_id: string; expired: boolean; consumed: boolean }>`
      SELECT id::text AS id, user_id::text AS user_id,
             (expires_at <= clock_timestamp()) AS expired,
             (consumed_at IS NOT NULL) AS consumed
      FROM kernel.password_reset
      WHERE tenant_id = ${tenantId}::uuid AND token_hash = ${tokenHash}`.execute(trx);
    const row = rows.rows[0];
    if (!row || row.expired || row.consumed) return null;
    const disabled = await sql<{ disabled: boolean }>`
      SELECT (disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_auth_state
      WHERE tenant_id = ${tenantId}::uuid AND id = ${row.user_id}::uuid`.execute(trx);
    if (disabled.rows[0]?.disabled) return 'disabled' as const;
    return { id: row.id, userId: row.user_id };
  });
  if (found === 'disabled') throw new AccountDisabledError();
  if (!found) throw new LoginRejectedError();
  if (hooks.afterLookup) await hooks.afterLookup();
  const passwordHash = await hashPassword(input.password);
  await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    await rejectDisabled(trx, tenantId, found.userId);
    const consumed = await sql<{ id: string }>`
      UPDATE kernel.password_reset
      SET consumed_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid
        AND id = ${found.id}::uuid
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING id::text AS id`.execute(trx);
    if (!consumed.rows[0]) throw new LoginRejectedError();
    await replacePassword(trx, tenantId, found.userId, passwordHash, 'reset');
  });
  ctx.log.event('password.reset', { tenantId, action: 'reset', outcome: 'accepted' });
}

export async function recoverWithRescueCode(
  db: Kysely<Database>,
  input: { tenantId: string; email: string; code: string; password: string },
  ctx: IdentityContext,
  hooks: RescueHooks = {},
): Promise<void> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const subject = recoverySubject(email);
  const listed = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    if (hooks.beforeReserve) await hooks.beforeReserve(trx);
    const slot = await reserveAttempt(trx, tenantId, subject);
    if (slot === 'throttled') return { ok: false as const, reason: 'throttled' as const };
    const found = await sql<{ id: string; disabled: boolean }>`
      SELECT u.id::text AS id, (s.disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.email = ${email}`.execute(trx);
    const account = found.rows[0];
    if (!account) {
      await writeAuthAudit(trx, {
        tenantId,
        action: 'rescue',
        actorUserId: null,
        targetUserId: null,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'password',
      });
      return { ok: false as const, reason: 'rejected' as const };
    }
    if (account.disabled) return { ok: false as const, reason: 'disabled' as const };
    const codes = await sql<{ id: string; code_hash: string }>`
      SELECT id::text AS id, code_hash
      FROM kernel.rescue_code
      WHERE tenant_id = ${tenantId}::uuid AND user_id = ${account.id}::uuid AND consumed_at IS NULL`.execute(trx);
    return { ok: true as const, userId: account.id, codes: codes.rows };
  });
  if (!listed.ok) {
    ctx.log.event('account.rescue', {
      tenantId,
      action: 'rescue',
      outcome: listed.reason === 'throttled' ? 'throttled' : listed.reason === 'disabled' ? 'disabled' : 'rejected',
    });
    if (listed.reason === 'throttled') throw new ThrottledError();
    if (listed.reason === 'disabled') throw new AccountDisabledError();
    throw new LoginRejectedError();
  }
  let matched: string | null = null;
  for (const row of listed.codes) {
    if (await rescueCodeMatches(row.code_hash, input.code)) {
      matched = row.id;
      break;
    }
  }
  if (!matched) {
    await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
      await assertTenantContext(trx);
      await writeAuthAudit(trx, {
        tenantId,
        action: 'rescue',
        actorUserId: null,
        targetUserId: listed.userId,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'password',
      });
    });
    ctx.log.event('account.rescue', { tenantId, action: 'rescue', outcome: 'rejected' });
    throw new LoginRejectedError();
  }
  const codeId = matched;
  const passwordHash = await hashPassword(input.password);
  const saved = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    if (hooks.beforeReplace) await hooks.beforeReplace(trx);
    const disabled = await sql<{ disabled: boolean }>`
      SELECT (disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_auth_state
      WHERE tenant_id = ${tenantId}::uuid AND id = ${listed.userId}::uuid
      FOR UPDATE`.execute(trx);
    if (disabled.rows[0]?.disabled) return 'disabled' as const;
    const consumed = await sql<{ id: string }>`
      UPDATE kernel.rescue_code
      SET consumed_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${codeId}::uuid AND consumed_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!consumed.rows[0]) return 'rejected' as const;
    await clearFailures(trx, tenantId, subject);
    await replacePassword(trx, tenantId, listed.userId, passwordHash, 'rescue');
    return 'ok' as const;
  });
  if (saved === 'disabled') throw new AccountDisabledError();
  if (saved === 'rejected') throw new LoginRejectedError();
  ctx.log.event('account.rescue', { tenantId, action: 'rescue', outcome: 'accepted' });
}
