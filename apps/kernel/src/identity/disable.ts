// SPDX-License-Identifier: Apache-2.0
// Local disable is one transaction: disabled_at, epoch bump, session revoke,
// audit row, auth_audit row, commitment, and NOTIFY. A thrown hook rolls all
// of them back.
import { sql, type Kysely, type Transaction } from 'kysely';
import { appendAuditCommitment } from '../audit/commitment.ts';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalUuid, leaseOf, type IdentityContext } from './context.ts';
import { IdentityForbiddenError, IdentityNotFoundError } from './errors.ts';
import { requireSession } from './session.ts';
import { asEpoch, notifyIdentity, revokeSessions, writeAuditRecord, writeAuthAudit } from './store.ts';

export interface DisableResult {
  epochBefore: number;
  epochAfter: number;
  revokedSessions: number;
}

export interface DisableHooks {
  /** Runs before the shared admin-row lock, so a race can arrive first. */
  beforeAdminLock?(trx: Transaction<Database>): Promise<void>;
  afterWrite?(trx: Transaction<Database>): Promise<void>;
}

export async function disableUser(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  targetUserId: string,
  ctx: IdentityContext,
  hooks: DisableHooks = {},
): Promise<DisableResult> {
  const tenantId = canonicalUuid(actor.tenantId);
  const target = canonicalUuid(targetUserId);
  const result = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const preview = await requireSession(trx, tenantId, actor.token, 'sensitive', leaseOf(ctx), {
      extendIdle: false,
    });
    if (preview.sessionKind !== 'admin') throw new IdentityForbiddenError();
    const kind = await sql<{ kind: string }>`
      SELECT kind FROM kernel.user_account
      WHERE tenant_id = ${tenantId}::uuid AND id = ${target}::uuid`.execute(trx);
    const accountKind = kind.rows[0]?.kind;
    if (!accountKind) throw new IdentityNotFoundError();
    if (accountKind === 'admin') {
      // No session row is locked yet. The shared admin lock comes before idle extension,
      // so two mutual disables cannot deadlock on each other's sessions.
      if (hooks.beforeAdminLock) await hooks.beforeAdminLock(trx);
      await sql`
        SELECT s.id
        FROM kernel.user_auth_state s
        JOIN kernel.user_account u ON u.tenant_id = s.tenant_id AND u.id = s.id
        WHERE s.tenant_id = ${tenantId}::uuid AND u.kind = 'admin'
        ORDER BY s.id
        FOR UPDATE OF s`.execute(trx);
    }
    const admin = await requireSession(trx, tenantId, actor.token, 'sensitive', leaseOf(ctx));
    if (admin.sessionKind !== 'admin') throw new IdentityForbiddenError();
    const locked = await sql<{ epoch: string; disabled: boolean }>`
      SELECT revocation_epoch::text AS epoch, (disabled_at IS NOT NULL) AS disabled
      FROM kernel.user_auth_state
      WHERE tenant_id = ${tenantId}::uuid AND id = ${target}::uuid
      FOR UPDATE`.execute(trx);
    const state = locked.rows[0];
    if (!state) throw new IdentityNotFoundError();
    if (accountKind === 'admin') {
      const others = await sql<{ count: string }>`
        SELECT count(*)::text AS count
        FROM kernel.user_account u
        JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
        WHERE u.tenant_id = ${tenantId}::uuid
          AND u.kind = 'admin'
          AND s.disabled_at IS NULL
          AND u.id <> ${target}::uuid`.execute(trx);
      if (others.rows[0]?.count === '0') throw new IdentityForbiddenError('last admin stays enabled');
    }
    let epochBefore = asEpoch(state.epoch);
    let epochAfter = epochBefore;
    if (!state.disabled) {
      const bumped = await sql<{ epoch: string }>`
        UPDATE kernel.user_auth_state
        SET disabled_at = clock_timestamp(),
            revocation_epoch = revocation_epoch + 1
        WHERE tenant_id = ${tenantId}::uuid AND id = ${target}::uuid AND disabled_at IS NULL
        RETURNING revocation_epoch::text AS epoch`.execute(trx);
      const next = bumped.rows[0]?.epoch;
      if (!next) throw new Error('disable did not bump the epoch');
      epochAfter = asEpoch(next);
      epochBefore = epochAfter - 1;
    }
    const revokedSessions = await revokeSessions(trx, tenantId, target);
    if (!state.disabled || revokedSessions > 0) {
      await writeAuthAudit(trx, {
        tenantId,
        action: 'disable',
        actorUserId: admin.userId,
        targetUserId: target,
        sessionHash: admin.tokenHash,
        epochBefore,
        epochAfter,
        reason: 'admin',
      });
      await writeAuditRecord(trx, tenantId, 'kernel.identity.disabled');
      await appendAuditCommitment(trx, {
        tenantId,
        action: 'kernel.identity.disabled',
        payload: {
          actorUserId: admin.userId,
          epochAfter,
          epochBefore,
          revokedSessions,
          targetUserId: target,
        },
      });
      await notifyIdentity(trx);
    }
    if (hooks.afterWrite) await hooks.afterWrite(trx);
    return { epochBefore, epochAfter, revokedSessions };
  });
  ctx.log.event('identity.disabled', {
    tenantId,
    userId: target,
    epoch: result.epochAfter,
    action: 'disable',
    outcome: 'disabled',
  });
  return result;
}
