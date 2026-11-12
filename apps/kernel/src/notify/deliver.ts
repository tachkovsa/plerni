// SPDX-License-Identifier: Apache-2.0
// One accepted send inserts one delivery row. The message text is hashed and
// discarded. A later send with the same key returns that row. A different
// recipient, channel, or text is a conflict and does not insert.
import { createHash, randomUUID } from 'node:crypto';
import { NOTIFICATION_CHANNEL, notificationSendRequestSchema } from '@plerni/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  assertSendGrant,
  assertTenantActor,
  deliveryConflict,
  preferenceMissing,
  rejectedSend,
} from './failures.ts';

export interface NotifyCaller {
  tenantId: string;
  actorId: string;
  grants: readonly string[];
}

export interface SendNotificationInput {
  idempotencyKey: string;
  recipientId: string;
  channel: string;
  body: string;
}

export interface DeliveryRecord {
  id: string;
  idempotencyKey: string;
  recipientId: string;
  channel: typeof NOTIFICATION_CHANNEL;
  outcome: 'delivered' | 'suppressed';
}

interface DeliveryRow {
  id: string;
  idempotency_key: string;
  recipient_id: string;
  channel: string;
  content_digest: string;
  outcome: string;
}

type Executor = Kysely<Database> | Transaction<Database>;

class DeliveryRace extends Error {
  constructor() {
    super('notification idempotency key already stored');
    this.name = 'DeliveryRace';
  }
}

function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function postgresCode(error: unknown): string | undefined {
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

function toRecord(row: DeliveryRow, recipientId: string, channel: string, digest: string): DeliveryRecord {
  if (row.recipient_id !== recipientId || row.channel !== channel || row.content_digest !== digest) {
    throw deliveryConflict();
  }
  if (row.channel !== NOTIFICATION_CHANNEL) throw new Error('unexpected notification channel');
  if (row.outcome !== 'delivered' && row.outcome !== 'suppressed') {
    throw new Error('unexpected notification outcome');
  }
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    recipientId: row.recipient_id,
    channel: NOTIFICATION_CHANNEL,
    outcome: row.outcome,
  };
}

async function readDelivery(db: Executor, key: string): Promise<DeliveryRow | null> {
  const result = await sql<DeliveryRow>`
    SELECT id::text AS id, idempotency_key, recipient_id::text AS recipient_id,
           channel, content_digest, outcome
    FROM kernel.notification_delivery
    WHERE idempotency_key = ${key}`.execute(db);
  if (result.rows.length > 1) throw new Error('notification delivery is not unique');
  return result.rows[0] ?? null;
}

export async function sendNotification(
  db: Kysely<Database>,
  caller: NotifyCaller,
  input: SendNotificationInput,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  afterKeyMiss?: (trx: Transaction<Database>) => Promise<void>,
): Promise<DeliveryRecord> {
  assertTenantActor(caller.tenantId, caller.actorId);
  assertSendGrant(caller.grants);
  const parsed = notificationSendRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.body.trim() === '') throw rejectedSend();
  const request = parsed.data;
  const digest = digestOf(request.body);
  const finish = async (trx: Transaction<Database>): Promise<DeliveryRecord> => {
    const row = await readDelivery(trx, request.idempotencyKey);
    if (!row) throw new Error('notification delivery missing after insert');
    return toRecord(row, request.recipientId, request.channel, digest);
  };
  try {
    return await withTenant(db, caller.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      const preference = await sql<{ enabled: boolean }>`
        SELECT enabled
        FROM kernel.notification_preference
        WHERE recipient_id = ${request.recipientId}::uuid
          AND channel = ${request.channel}`.execute(trx);
      if (preference.rows.length > 1) throw new Error('notification preference is not unique');
      const enabled = preference.rows[0]?.enabled;
      if (preference.rows.length === 0) throw preferenceMissing();
      if (typeof enabled !== 'boolean') throw new Error('notification preference is unreadable');
      const existing = await readDelivery(trx, request.idempotencyKey);
      if (existing) return toRecord(existing, request.recipientId, request.channel, digest);
      if (afterKeyMiss) await afterKeyMiss(trx);
      const outcome = enabled ? 'delivered' : 'suppressed';
      const inserted = await sql<{ id: string }>`
        INSERT INTO kernel.notification_delivery (
          tenant_id, id, idempotency_key, recipient_id, channel, content_digest, outcome
        ) VALUES (
          ${caller.tenantId}::uuid,
          ${randomUUID()}::uuid,
          ${request.idempotencyKey},
          ${request.recipientId}::uuid,
          ${request.channel},
          ${digest},
          ${outcome}
        )
        ON CONFLICT ON CONSTRAINT notification_delivery_once DO NOTHING
        RETURNING id::text AS id`.execute(trx);
      if (!inserted.rows[0]) throw new DeliveryRace();
      return finish(trx);
    });
  } catch (error) {
    if (!(error instanceof DeliveryRace) && postgresCode(error) !== '23505') throw error;
    return withTenant(db, caller.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      return finish(trx);
    });
  }
}
