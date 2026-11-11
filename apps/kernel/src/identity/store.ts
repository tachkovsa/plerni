// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import type { AccountKind } from './context.ts';
import { EmailInUseError } from './errors.ts';

export const IDENTITY_NOTIFY_CHANNEL = 'plerni_identity';

export function postgresCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function asEpoch(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('epoch is not a number');
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch)) throw new Error('epoch is not a safe integer');
  return epoch;
}

export async function notifyIdentity(trx: Transaction<Database>): Promise<void> {
  await sql`SELECT pg_notify('plerni_identity', '')`.execute(trx);
}

export async function writeAuthAudit(
  trx: Transaction<Database>,
  row: {
    tenantId: string;
    action: string;
    actorUserId: string | null;
    targetUserId: string | null;
    sessionHash: string | null;
    epochBefore: number | null;
    epochAfter: number | null;
    reason: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO kernel.auth_audit (
      tenant_id, id, action, actor_user_id, target_user_id, session_hash,
      epoch_before, epoch_after, reason, decision_basis
    ) VALUES (
      ${row.tenantId}::uuid,
      ${randomUUID()}::uuid,
      ${row.action},
      ${row.actorUserId}::uuid,
      ${row.targetUserId}::uuid,
      ${row.sessionHash},
      ${row.epochBefore}::bigint,
      ${row.epochAfter}::bigint,
      ${row.reason},
      'local'
    )`.execute(trx);
}

export async function writeAuditRecord(
  trx: Transaction<Database>,
  tenantId: string,
  action: string,
): Promise<void> {
  await sql`
    INSERT INTO kernel.audit_record (tenant_id, id, action, target_tenant_id)
    VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${action}, ${tenantId}::uuid)`.execute(trx);
}

export async function insertAccount(
  trx: Transaction<Database>,
  input: {
    tenantId: string;
    email: string;
    passwordHash: string;
    kind: AccountKind;
    rescueHashes: readonly string[];
  },
): Promise<string> {
  const userId = randomUUID();
  try {
    await sql`
      INSERT INTO kernel.user_account (tenant_id, id, email, password_hash, kind)
      VALUES (
        ${input.tenantId}::uuid,
        ${userId}::uuid,
        ${input.email},
        ${input.passwordHash},
        ${input.kind}
      )`.execute(trx);
  } catch (error) {
    if (postgresCode(error) === '23505') throw new EmailInUseError();
    throw error;
  }
  await sql`
    INSERT INTO kernel.user_auth_state (tenant_id, id, revocation_epoch)
    VALUES (${input.tenantId}::uuid, ${userId}::uuid, 0)`.execute(trx);
  for (const codeHash of input.rescueHashes) {
    await sql`
      INSERT INTO kernel.rescue_code (tenant_id, id, user_id, code_hash)
      VALUES (${input.tenantId}::uuid, ${randomUUID()}::uuid, ${userId}::uuid, ${codeHash})`.execute(trx);
  }
  return userId;
}

export async function revokeSessions(
  trx: Transaction<Database>,
  tenantId: string,
  userId: string,
): Promise<number> {
  const revoked = await sql<{ id: string }>`
    UPDATE kernel.session
    SET revoked_at = clock_timestamp()
    WHERE tenant_id = ${tenantId}::uuid
      AND user_id = ${userId}::uuid
      AND revoked_at IS NULL
    RETURNING id::text AS id`.execute(trx);
  return revoked.rows.length;
}

export async function bumpEpoch(
  trx: Transaction<Database>,
  tenantId: string,
  userId: string,
): Promise<{ before: number; after: number }> {
  const bumped = await sql<{ before: string; after: string }>`
    UPDATE kernel.user_auth_state
    SET revocation_epoch = revocation_epoch + 1
    WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid
    RETURNING (revocation_epoch - 1)::text AS before, revocation_epoch::text AS after`.execute(trx);
  const row = bumped.rows[0];
  if (!row) throw new Error('auth state missing under update');
  return { before: asEpoch(row.before), after: asEpoch(row.after) };
}

export interface SessionLifetime {
  idleHours: number;
  absoluteDays: number;
  absoluteHours: number;
}

export async function insertSession(
  trx: Transaction<Database>,
  input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    kind: AccountKind;
    epoch: number;
    lifetime: SessionLifetime;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO kernel.session (
      tenant_id, id, user_id, token_hash, session_kind,
      idle_expires_at, absolute_expires_at, fresh_until, issued_epoch
    ) VALUES (
      ${input.tenantId}::uuid,
      ${id}::uuid,
      ${input.userId}::uuid,
      ${input.tokenHash},
      ${input.kind},
      clock_timestamp() + make_interval(hours => ${input.lifetime.idleHours}::int),
      clock_timestamp() + make_interval(days => ${input.lifetime.absoluteDays}::int, hours => ${input.lifetime.absoluteHours}::int),
      clock_timestamp() + make_interval(mins => 5),
      ${input.epoch}::bigint
    )`.execute(trx);
  return id;
}

export function lifetimeFor(kind: AccountKind): SessionLifetime {
  if (kind === 'admin') return { idleHours: 1, absoluteDays: 0, absoluteHours: 1 };
  return { idleHours: 12, absoluteDays: 7, absoluteHours: 0 };
}
