// SPDX-License-Identifier: Apache-2.0
// Session authority is the PostgreSQL row plus user_auth_state (spec §6).
// Ordinary reads report validation "lease". Admin sessions and sensitive or
// destructive routes report "per_request". Both paths read PostgreSQL.
// The freshness lease stub is consulted and then ignored for the allow decision.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import {
  demandsPerRequest,
  type AccountKind,
  type IdentityContext,
  type RouteClass,
  type ValidationMode,
  canonicalUuid,
  leaseOf,
} from './context.ts';
import { FreshnessExpiredError, SessionRejectedError } from './errors.ts';
import type { FreshnessLease } from './lease.ts';
import { asEpoch, lifetimeFor, notifyIdentity, writeAuthAudit } from './store.ts';
import { presentedToken } from './token.ts';

export interface LiveSession {
  sessionId: string;
  userId: string;
  sessionKind: AccountKind;
  epoch: number;
  validation: ValidationMode;
  tokenHash: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  session_kind: string;
  issued_epoch: string;
  revoked: boolean;
  idle_elapsed: boolean;
  absolute_elapsed: boolean;
  freshness_elapsed: boolean;
}

function asKind(value: string): AccountKind {
  if (value === 'admin' || value === 'member') return value;
  throw new SessionRejectedError();
}

async function strictDisable(trx: Transaction<Database>, tenantId: string): Promise<boolean> {
  const result = await sql<{ strict_disable: boolean }>`
    SELECT strict_disable
    FROM kernel.tenant_auth_policy
    WHERE tenant_id = ${tenantId}::uuid`.execute(trx);
  return result.rows[0]?.strict_disable === true;
}

async function loadSession(
  trx: Transaction<Database>,
  tenantId: string,
  tokenHash: string,
): Promise<SessionRow | null> {
  const result = await sql<SessionRow>`
    SELECT id::text AS id, user_id::text AS user_id, session_kind,
           issued_epoch::text AS issued_epoch,
           (revoked_at IS NOT NULL) AS revoked,
           (idle_expires_at <= clock_timestamp()) AS idle_elapsed,
           (absolute_expires_at <= clock_timestamp()) AS absolute_elapsed,
           (fresh_until <= clock_timestamp()) AS freshness_elapsed
    FROM kernel.session
    WHERE tenant_id = ${tenantId}::uuid AND token_hash = ${tokenHash}`.execute(trx);
  return result.rows[0] ?? null;
}

async function authEpoch(trx: Transaction<Database>, tenantId: string, userId: string): Promise<{
  epoch: number;
  disabled: boolean;
} | null> {
  const result = await sql<{ epoch: string; disabled: boolean }>`
    SELECT revocation_epoch::text AS epoch, (disabled_at IS NOT NULL) AS disabled
    FROM kernel.user_auth_state
    WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid`.execute(trx);
  const row = result.rows[0];
  if (!row) return null;
  return { epoch: asEpoch(row.epoch), disabled: row.disabled };
}

async function slideIdle(
  trx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  kind: AccountKind,
): Promise<void> {
  const life = lifetimeFor(kind);
  await sql`
    UPDATE kernel.session
    SET last_seen_at = clock_timestamp(),
        idle_expires_at = LEAST(
          absolute_expires_at,
          clock_timestamp() + make_interval(hours => ${life.idleHours}::int)
        )
    WHERE tenant_id = ${tenantId}::uuid AND id = ${sessionId}::uuid`.execute(trx);
}

/**
 * Read the session inside the caller's transaction. A revoked row, a disabled
 * account, or an epoch mismatch fails. A freshness-lease hit does not.
 */
export async function requireSession(
  trx: Transaction<Database>,
  tenantId: string,
  token: string,
  routeClass: RouteClass,
  lease: FreshnessLease,
  options: { extendIdle?: boolean; requireFresh?: boolean } = {},
): Promise<LiveSession> {
  const tokenHash = presentedToken(token);
  if (!tokenHash) throw new SessionRejectedError();
  const session = await loadSession(trx, tenantId, tokenHash);
  if (!session || session.revoked || session.idle_elapsed || session.absolute_elapsed) {
    throw new SessionRejectedError();
  }
  const state = await authEpoch(trx, tenantId, session.user_id);
  if (!state || state.disabled || state.epoch !== asEpoch(session.issued_epoch)) {
    throw new SessionRejectedError();
  }
  const cached = lease.read(tokenHash);
  if (cached && (session.revoked || state.disabled || cached.epoch !== String(state.epoch))) {
    throw new SessionRejectedError();
  }
  const kind = asKind(session.session_kind);
  const strict = await strictDisable(trx, tenantId);
  const requireFresh = options.requireFresh !== false;
  if (requireFresh && session.freshness_elapsed) throw new FreshnessExpiredError();
  if (options.extendIdle !== false) await slideIdle(trx, tenantId, session.id, kind);
  return {
    sessionId: session.id,
    userId: session.user_id,
    sessionKind: kind,
    epoch: state.epoch,
    validation: demandsPerRequest(routeClass, kind, strict) ? 'per_request' : 'lease',
    tokenHash,
  };
}

export async function authenticate(
  db: Kysely<Database>,
  input: { tenantId: string; token: string; routeClass: RouteClass },
  ctx: IdentityContext,
): Promise<LiveSession> {
  const tenantId = canonicalUuid(input.tenantId);
  return withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    return requireSession(trx, tenantId, input.token, input.routeClass, leaseOf(ctx));
  });
}

export async function refreshSession(
  db: Kysely<Database>,
  input: { tenantId: string; token: string },
  ctx: IdentityContext,
): Promise<LiveSession> {
  const tenantId = canonicalUuid(input.tenantId);
  const live = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const tokenHash = presentedToken(input.token);
    if (!tokenHash) throw new SessionRejectedError();
    const session = await loadSession(trx, tenantId, tokenHash);
    if (!session || session.revoked || session.idle_elapsed || session.absolute_elapsed) {
      throw new SessionRejectedError();
    }
    const state = await authEpoch(trx, tenantId, session.user_id);
    if (!state || state.disabled || state.epoch !== asEpoch(session.issued_epoch)) {
      throw new SessionRejectedError();
    }
    const kind = asKind(session.session_kind);
    const life = lifetimeFor(kind);
    const extended = await sql<{ id: string }>`
      UPDATE kernel.session
      SET last_seen_at = clock_timestamp(),
          fresh_until = LEAST(
            absolute_expires_at,
            clock_timestamp() + make_interval(mins => 5)
          ),
          idle_expires_at = LEAST(
            absolute_expires_at,
            clock_timestamp() + make_interval(hours => ${life.idleHours}::int)
          )
      WHERE tenant_id = ${tenantId}::uuid
        AND id = ${session.id}::uuid
        AND revoked_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!extended.rows[0]) throw new SessionRejectedError();
    await writeAuthAudit(trx, {
      tenantId,
      action: 'refresh',
      actorUserId: session.user_id,
      targetUserId: session.user_id,
      sessionHash: tokenHash,
      epochBefore: state.epoch,
      epochAfter: state.epoch,
      reason: 'local',
    });
    const strict = await strictDisable(trx, tenantId);
    const validation: ValidationMode = demandsPerRequest('read', kind, strict) ? 'per_request' : 'lease';
    return {
      sessionId: session.id,
      userId: session.user_id,
      sessionKind: kind,
      epoch: state.epoch,
      validation,
      tokenHash,
    };
  });
  ctx.log.event('session.refresh', { tenantId, userId: live.userId, action: 'refresh' });
  return live;
}

export async function logout(
  db: Kysely<Database>,
  input: { tenantId: string; token: string },
  ctx: IdentityContext,
): Promise<void> {
  const tenantId = canonicalUuid(input.tenantId);
  const userId = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const live = await requireSession(trx, tenantId, input.token, 'sensitive', leaseOf(ctx), {
      extendIdle: false,
      requireFresh: false,
    });
    await sql`
      UPDATE kernel.session
      SET revoked_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${live.sessionId}::uuid AND revoked_at IS NULL`.execute(trx);
    await writeAuthAudit(trx, {
      tenantId,
      action: 'logout',
      actorUserId: live.userId,
      targetUserId: live.userId,
      sessionHash: live.tokenHash,
      epochBefore: live.epoch,
      epochAfter: live.epoch,
      reason: 'local',
    });
    await notifyIdentity(trx);
    return live.userId;
  });
  ctx.log.event('session.logout', { tenantId, userId, action: 'logout' });
}
