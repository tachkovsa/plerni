// SPDX-License-Identifier: Apache-2.0
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalEmail, canonicalUuid, type IdentityContext } from './context.ts';
import { AccountDisabledError, LoginRejectedError, ThrottledError } from './errors.ts';
import { hashArgon2id, verifyPassword } from './password.ts';
import { insertSession, lifetimeFor, asEpoch, writeAuthAudit } from './store.ts';
import { clearFailures, loginSubject, recordFailure, throttled } from './throttle.ts';
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

export async function login(
  db: Kysely<Database>,
  input: { tenantId: string; email: string; password: string },
  ctx: IdentityContext,
): Promise<LoginResult> {
  const tenantId = canonicalUuid(input.tenantId);
  const email = canonicalEmail(input.email);
  const subject = loginSubject(email);
  const result = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    if (await throttled(trx, tenantId, subject)) {
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
    const encoded = account?.password_hash ?? await missingAccountHash();
    const passwordOk = await verifyPassword(encoded, input.password);
    if (!account || !passwordOk) {
      await recordFailure(trx, tenantId, subject);
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: account?.id ?? null,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'password',
      });
      return { ok: false as const, reason: 'rejected' as const };
    }
    if (account.kind !== 'admin' && account.kind !== 'member') {
      return { ok: false as const, reason: 'rejected' as const };
    }
    const kind = account.kind;
    if (account.disabled) {
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: account.id,
        sessionHash: null,
        epochBefore: null,
        epochAfter: null,
        reason: 'disabled',
      });
      return { ok: false as const, reason: 'disabled' as const };
    }
    await clearFailures(trx, tenantId, subject);
    const token = newSecretToken();
    const epoch = asEpoch(account.epoch);
    await insertSession(trx, {
      tenantId,
      userId: account.id,
      tokenHash: sha256Hex(token),
      kind,
      epoch,
      lifetime: lifetimeFor(account.kind),
    });
    await writeAuthAudit(trx, {
      tenantId,
      action: 'login',
      actorUserId: account.id,
      targetUserId: account.id,
      sessionHash: sha256Hex(token),
      epochBefore: epoch,
      epochAfter: epoch,
      reason: 'password',
    });
    return { ok: true as const, token, userId: account.id, sessionKind: kind };
  });
  if (!result.ok) {
    ctx.log.event('login.rejected', {
      tenantId,
      action: 'login',
      outcome: result.reason === 'throttled' ? 'throttled' : result.reason === 'disabled' ? 'disabled' : 'rejected',
    });
    if (result.reason === 'throttled') throw new ThrottledError();
    if (result.reason === 'disabled') throw new AccountDisabledError();
    throw new LoginRejectedError();
  }
  ctx.log.event('login.accepted', { tenantId, userId: result.userId, action: 'login', outcome: 'accepted' });
  const sessionKind = result.sessionKind;
  if (sessionKind !== 'admin' && sessionKind !== 'member') throw new LoginRejectedError();
  return { token: result.token, userId: result.userId, sessionKind };
}
