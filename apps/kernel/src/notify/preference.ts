// SPDX-License-Identifier: Apache-2.0
// Records the caller's own in-app preference. The recipient is the session
// actor. A second record updates that row and does not insert another.
import { randomUUID } from 'node:crypto';
import { NOTIFICATION_CHANNEL, notificationPreferenceRequestSchema } from '@plerni/contracts';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { assertTenantActor, rejectedPreference } from './failures.ts';

export interface PreferenceCaller {
  tenantId: string;
  actorId: string;
}

export interface PreferenceInput {
  channel: string;
  enabled: boolean;
}

export interface PreferenceRecord {
  id: string;
  recipientId: string;
  channel: typeof NOTIFICATION_CHANNEL;
  enabled: boolean;
}

interface PreferenceRow {
  id: string;
  recipient_id: string;
  channel: string;
  enabled: boolean;
}

export async function recordNotificationPreference(
  db: Kysely<Database>,
  caller: PreferenceCaller,
  input: PreferenceInput,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<PreferenceRecord> {
  const actor = assertTenantActor(caller.tenantId, caller.actorId);
  const parsed = notificationPreferenceRequestSchema.safeParse(input);
  if (!parsed.success) throw rejectedPreference();
  return withTenant(db, actor.tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    const id = randomUUID();
    const stored = await sql<PreferenceRow>`
      INSERT INTO kernel.notification_preference (tenant_id, id, recipient_id, channel, enabled)
      VALUES (
        ${actor.tenantId}::uuid,
        ${id}::uuid,
        ${actor.actorId}::uuid,
        ${parsed.data.channel},
        ${parsed.data.enabled}
      )
      ON CONFLICT ON CONSTRAINT notification_preference_once
      DO UPDATE SET enabled = EXCLUDED.enabled
      RETURNING id::text AS id, recipient_id::text AS recipient_id, channel, enabled`.execute(trx);
    const row = stored.rows[0];
    if (!row || row.channel !== NOTIFICATION_CHANNEL || typeof row.enabled !== 'boolean') {
      throw new Error('notification preference was not stored');
    }
    return {
      id: row.id,
      recipientId: row.recipient_id,
      channel: NOTIFICATION_CHANNEL,
      enabled: row.enabled,
    };
  });
}
