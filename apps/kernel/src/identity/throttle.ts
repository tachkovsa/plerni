// SPDX-License-Identifier: Apache-2.0
// Login and recovery share one throttle table and separate subject hashes.
// A rejection commits its counter. The caller's later error must not roll
// that write back.
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { THROTTLE_LIMIT, THROTTLE_WINDOW_MINUTES } from './context.ts';
import { sha256Hex } from './token.ts';

export function loginSubject(email: string): string {
  return sha256Hex(email);
}

export function recoverySubject(email: string): string {
  return sha256Hex(`recovery:${email}`);
}

export function resetSubject(email: string): string {
  return sha256Hex(`reset:${email}`);
}

export async function throttled(
  trx: Transaction<Database>,
  tenantId: string,
  subject: string,
): Promise<boolean> {
  const result = await sql<{ failures: number; expired: boolean }>`
    SELECT failures,
           (window_started_at + make_interval(mins => ${THROTTLE_WINDOW_MINUTES}::int) <= clock_timestamp()) AS expired
    FROM kernel.login_throttle
    WHERE tenant_id = ${tenantId}::uuid AND subject_hash = ${subject}`.execute(trx);
  const row = result.rows[0];
  return Boolean(row && !row.expired && row.failures >= THROTTLE_LIMIT);
}

export async function recordFailure(
  trx: Transaction<Database>,
  tenantId: string,
  subject: string,
): Promise<void> {
  await sql`
    INSERT INTO kernel.login_throttle (tenant_id, id, subject_hash, failures, window_started_at)
    VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${subject}, 1, clock_timestamp())
    ON CONFLICT (tenant_id, subject_hash) DO UPDATE
    SET failures = CASE
          WHEN kernel.login_throttle.window_started_at
               + make_interval(mins => ${THROTTLE_WINDOW_MINUTES}::int) <= clock_timestamp()
          THEN 1
          ELSE kernel.login_throttle.failures + 1
        END,
        window_started_at = CASE
          WHEN kernel.login_throttle.window_started_at
               + make_interval(mins => ${THROTTLE_WINDOW_MINUTES}::int) <= clock_timestamp()
          THEN clock_timestamp()
          ELSE kernel.login_throttle.window_started_at
        END`.execute(trx);
}

export async function clearFailures(
  trx: Transaction<Database>,
  tenantId: string,
  subject: string,
): Promise<void> {
  await sql`
    UPDATE kernel.login_throttle
    SET failures = 0, window_started_at = clock_timestamp()
    WHERE tenant_id = ${tenantId}::uuid AND subject_hash = ${subject}`.execute(trx);
}

/**
 * Check and take one recovery attempt under the throttle row lock.
 * The caller commits this transaction before any password hash.
 */
export async function reserveAttempt(
  trx: Transaction<Database>,
  tenantId: string,
  subject: string,
): Promise<'reserved' | 'throttled'> {
  const inserted = await sql<{ id: string }>`
    INSERT INTO kernel.login_throttle (tenant_id, id, subject_hash, failures, window_started_at)
    VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${subject}, 1, clock_timestamp())
    ON CONFLICT (tenant_id, subject_hash) DO NOTHING
    RETURNING id::text AS id`.execute(trx);
  if (inserted.rows[0]) return 'reserved';
  const locked = await sql<{ failures: number; expired: boolean }>`
    SELECT failures,
           (window_started_at + make_interval(mins => ${THROTTLE_WINDOW_MINUTES}::int) <= clock_timestamp()) AS expired
    FROM kernel.login_throttle
    WHERE tenant_id = ${tenantId}::uuid AND subject_hash = ${subject}
    FOR UPDATE`.execute(trx);
  const row = locked.rows[0];
  if (!row) throw new Error('throttle row missing after conflict');
  if (row.expired) {
    await sql`
      UPDATE kernel.login_throttle
      SET failures = 1, window_started_at = clock_timestamp()
      WHERE tenant_id = ${tenantId}::uuid AND subject_hash = ${subject}`.execute(trx);
    return 'reserved';
  }
  if (row.failures >= THROTTLE_LIMIT) return 'throttled';
  await sql`
    UPDATE kernel.login_throttle
    SET failures = failures + 1
    WHERE tenant_id = ${tenantId}::uuid AND subject_hash = ${subject}`.execute(trx);
  return 'reserved';
}
