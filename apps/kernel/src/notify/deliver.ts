// SPDX-License-Identifier: Apache-2.0
// One accepted send inserts one delivery row and keeps the rendered text.
// That row is the in-app channel. A later send with the same key returns it.
// A different recipient, channel, or text is a conflict and does not insert.
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_CHANNEL, NOTIFICATION_LIST_MAX, notificationSendRequestSchema } from '@plerni/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  assertSendGrant,
  assertTenantActor,
  canonicalUuid,
  deliveryConflict,
  preferenceMissing,
  rejectedSend,
} from './failures.ts';

export interface NotifyCaller {
  tenantId: string;
  actorId: string;
  grants: readonly string[];
}

export interface InboxCaller {
  tenantId: string;
  actorId: string;
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
  body: string;
}

interface DeliveryRow {
  id: string;
  idempotency_key: string;
  recipient_id: string;
  channel: string;
  body: string;
  outcome: string;
}

type Executor = Kysely<Database> | Transaction<Database>;

class DeliveryRace extends Error {
  constructor() {
    super('notification idempotency key already stored');
    this.name = 'DeliveryRace';
  }
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

function toRecord(row: DeliveryRow, recipientId: string, channel: string, body: string): DeliveryRecord {
  if (row.recipient_id !== recipientId || row.channel !== channel || row.body !== body) {
    throw deliveryConflict();
  }
  if (row.channel !== NOTIFICATION_CHANNEL) throw new Error('unexpected notification channel');
  if (row.outcome !== 'delivered' && row.outcome !== 'suppressed') {
    throw new Error('unexpected notification outcome');
  }
  if (typeof row.body !== 'string' || row.body.length === 0) throw new Error('notification text is missing');
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    recipientId: row.recipient_id,
    channel: NOTIFICATION_CHANNEL,
    outcome: row.outcome,
    body: row.body,
  };
}

const DELIVERY_COLUMNS = sql`id::text AS id, idempotency_key, recipient_id::text AS recipient_id, channel, body, outcome`;

async function readDelivery(db: Executor, key: string): Promise<DeliveryRow | null> {
  const result = await sql<DeliveryRow>`
    SELECT ${DELIVERY_COLUMNS}
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
  const actor = assertTenantActor(caller.tenantId, caller.actorId);
  assertSendGrant(caller.grants);
  const parsed = notificationSendRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.body.trim() === '') throw rejectedSend();
  const request = parsed.data;
  const recipientId = canonicalUuid(request.recipientId);
  const finish = async (trx: Transaction<Database>): Promise<DeliveryRecord> => {
    const row = await readDelivery(trx, request.idempotencyKey);
    if (!row) throw new Error('notification delivery missing after insert');
    return toRecord(row, recipientId, request.channel, request.body);
  };
  try {
    return await withTenant(db, actor.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      const preference = await sql<{ enabled: boolean }>`
        SELECT enabled
        FROM kernel.notification_preference
        WHERE recipient_id = ${recipientId}::uuid
          AND channel = ${request.channel}`.execute(trx);
      if (preference.rows.length > 1) throw new Error('notification preference is not unique');
      const enabled = preference.rows[0]?.enabled;
      if (preference.rows.length === 0) throw preferenceMissing();
      if (typeof enabled !== 'boolean') throw new Error('notification preference is unreadable');
      const existing = await readDelivery(trx, request.idempotencyKey);
      if (existing) return toRecord(existing, recipientId, request.channel, request.body);
      if (afterKeyMiss) await afterKeyMiss(trx);
      const outcome = enabled ? 'delivered' : 'suppressed';
      const inserted = await sql<{ id: string }>`
        INSERT INTO kernel.notification_delivery (
          tenant_id, id, idempotency_key, recipient_id, channel, body, outcome
        ) VALUES (
          ${actor.tenantId}::uuid,
          ${randomUUID()}::uuid,
          ${request.idempotencyKey},
          ${recipientId}::uuid,
          ${request.channel},
          ${request.body},
          ${outcome}
        )
        ON CONFLICT ON CONSTRAINT notification_delivery_once DO NOTHING
        RETURNING id::text AS id`.execute(trx);
      if (!inserted.rows[0]) throw new DeliveryRace();
      return finish(trx);
    });
  } catch (error) {
    if (!(error instanceof DeliveryRace) && postgresCode(error) !== '23505') throw error;
    return withTenant(db, actor.tenantId, evidence, terminateBackend, async (trx) => {
      await assertTenantContext(trx);
      return finish(trx);
    });
  }
}

/** Delivered rows for this actor. Suppressed rows stay stored and are not listed. */
export async function listNotifications(
  db: Kysely<Database>,
  caller: InboxCaller,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DeliveryRecord[]> {
  const actor = assertTenantActor(caller.tenantId, caller.actorId);
  return withTenant(db, actor.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const result = await sql<DeliveryRow>`
      SELECT ${DELIVERY_COLUMNS}
      FROM kernel.notification_delivery
      WHERE recipient_id = ${actor.actorId}::uuid
        AND outcome = 'delivered'
      ORDER BY created_at DESC, id DESC
      LIMIT ${NOTIFICATION_LIST_MAX}`.execute(trx);
    return result.rows.map((row) => {
      if (row.recipient_id !== actor.actorId) throw new Error('notification recipient mismatch');
      if (row.channel !== NOTIFICATION_CHANNEL || row.outcome !== 'delivered') {
        throw new Error('unexpected notification row');
      }
      if (typeof row.body !== 'string' || row.body.length === 0) throw new Error('notification text is missing');
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        recipientId: row.recipient_id,
        channel: NOTIFICATION_CHANNEL,
        outcome: 'delivered' as const,
        body: row.body,
      };
    });
  });
}
