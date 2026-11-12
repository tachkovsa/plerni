// SPDX-License-Identifier: Apache-2.0
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalEmail, canonicalUuid, type IdentityContext } from './context.ts';
import { AccountDisabledError, LoginRejectedError, ThrottledError } from './errors.ts';
import { hashArgon2id, verifyPassword } from './password.ts';
import { insertSession, lifetimeFor, asEpoch, writeAuthAudit } from './store.ts';
import { clearFailures, loginSubject, reserveAttempt } from './throttle.ts';
import { newSecretToken, sha256Hex } from './token.ts';

let dummyHash: Promise<string> | undefined;

function missingAccountHash(): Promise<string> {
  dummyHash ??= hashArgon2id(new TextEncoder().encode('missing-account-dummy'));
  return dummyHash;
}

export interface LoginResult {
  token: string;
  userId: string;
  sessionKind: 'admin' | 'member';
}

export interface LoginHooks {
  /** Runs before the throttle row is locked, so concurrent attempts can arrive together. */
  beforeReserve?(trx: Transaction<Database>): Promise<void>;
}

export async function login(
  db: Kysely<Database>,
  input: { tenantId: string; email: string; password: string },
  ctx: IdentityContext,
  hooks: LoginHooks = {},
): Promise<LoginResult> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const subject = loginSubject(email);
  const reserved = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    if (hooks.beforeReserve) await hooks.beforeReserve(trx);
    const slot = await reserveAttempt(trx, tenantId, subject);
    if (slot === 'throttled') {
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: null,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'throttle',
      });
      return { ok: false as const, reason: 'throttled' as const };
    }
    const found = await sql<{ id: string; password_hash: string; kind: string; disabled: boolean; epoch: string }>`
      SELECT u.id::text AS id, u.password_hash, u.kind,
             (s.disabled_at IS NOT NULL) AS disabled,
             s.revocation_epoch::text AS epoch
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.email = ${email}`.execute(trx);
    const account = found.rows[0];
    if (!account) return { ok: false as const, reason: 'missing' as const };
    return {
      ok: true as const,
      id: account.id,
      passwordHash: account.password_hash,
      kind: account.kind,
      disabled: account.disabled,
      epoch: account.epoch,
    };
  });
  if (!reserved.ok) {
    if (reserved.reason === 'throttled') {
      ctx.log.event('login.rejected', { tenantId, action: 'login', outcome: 'throttled' });
      throw new ThrottledError();
    }
    await verifyPassword(await missingAccountHash(), input.password);
    ctx.log.event('login.rejected', { tenantId, action: 'login', outcome: 'rejected' });
    throw new LoginRejectedError();
  }
  const passwordOk = await verifyPassword(reserved.passwordHash, input.password);
  if (reserved.kind !== 'admin' && reserved.kind !== 'member') {
    throw new LoginRejectedError();
  }
  const kind = reserved.kind;
  if (!passwordOk) {
    await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
      await assertTenantContext(trx);
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: reserved.id,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'password',
      });
    });
    ctx.log.event('login.rejected', { tenantId, action: 'login', outcome: 'rejected' });
    throw new LoginRejectedError();
  }
  if (reserved.disabled) {
    await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
      await assertTenantContext(trx);
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: reserved.id,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'disabled',
      });
    });
    ctx.log.event('login.rejected', { tenantId, action: 'login', outcome: 'disabled' });
    throw new AccountDisabledError();
  }
  const opened = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    await clearFailures(trx, tenantId, subject);
    const token = newSecretToken();
    const epoch = asEpoch(reserved.epoch);
    await insertSession(trx, {
      tenantId,
      userId: reserved.id,
      tokenHash: sha256Hex(token),
      kind,
      epoch,
      lifetime: lifetimeFor(kind),
    });
    await writeAuthAudit(trx, {
      tenantId,
      action: 'login',
      actorUserId: reserved.id,
      targetUserId: reserved.id,
      sessionHash: sha256Hex(token),
      epochBefore: epoch,
      epochAfter: epoch,
      reason: 'password',
    });
    const sessionKind: LoginResult['sessionKind'] = kind;
    return { token, userId: reserved.id, sessionKind };
  });
  ctx.log.event('login.accepted', { tenantId, userId: opened.userId, action: 'login', outcome: 'accepted' });
  return opened;
}
