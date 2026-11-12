// SPDX-License-Identifier: Apache-2.0
// Installation delivery consults the per-tenant watermark (plan §4.4).
// A disabled tenant does not receive the event. The caller still advances
// the installation cursor. An enabled watermark moves only when that tenant
// has no older matching event still outstanding, so a re-enable cannot skip
// retained backlog and a caught-up tenant does not hold other tenants' rows.
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';

const MATCHING_EVENT = sql`
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(s.filter) AS entry
    WHERE entry->>'type' = o.type
      AND entry->'versions' @> jsonb_build_array(o.version)
  )
`;

export async function installationDelivery(
  trx: Transaction<Database>,
  subscriptionId: string,
  tenantId: string,
  seq: string,
): Promise<'plain' | 'withhold' | 'accept'> {
  const found = await sql<{ id: string }>`
    SELECT id
    FROM kernel.package
    WHERE subscription_id = ${subscriptionId}::uuid`.execute(trx);
  const packageId = found.rows[0]?.id;
  if (!packageId) return 'plain';
  const row = await sql<{ enabled: boolean; watermark_seq: string }>`
    SELECT enabled, watermark_seq::text AS watermark_seq
    FROM kernel.package_enablement
    WHERE package_id = ${packageId}
      AND tenant_id = ${tenantId}::uuid
    FOR UPDATE`.execute(trx);
  const enablement = row.rows[0];
  if (!enablement?.enabled) return 'withhold';
  const gap = await sql<{ seq: string }>`
    SELECT o.seq::text AS seq
    FROM kernel.outbox AS o
    JOIN kernel.package AS p ON p.id = ${packageId}
    JOIN kernel.subscription AS s ON s.id = p.subscription_id
    WHERE o.tenant_id = ${tenantId}::uuid
      AND o.seq > ${enablement.watermark_seq}::bigint
      AND o.seq < ${seq}::bigint
      AND ${MATCHING_EVENT}
    LIMIT 1`.execute(trx);
  if (gap.rows[0]) return 'withhold';
  return 'accept';
}

/** Move enabled watermarks that have no older matching event before seq. */
export async function noteInstallationCursor(
  trx: Transaction<Database>,
  subscriptionId: string,
  seq: string,
): Promise<void> {
  await sql`
    UPDATE kernel.package_enablement AS e
    SET watermark_seq = ${seq}::bigint
    FROM kernel.package AS p
    JOIN kernel.subscription AS s ON s.id = p.subscription_id
    WHERE p.subscription_id = ${subscriptionId}::uuid
      AND e.package_id = p.id
      AND e.enabled = true
      AND e.released_at IS NULL
      AND e.watermark_seq < ${seq}::bigint
      AND NOT EXISTS (
        SELECT 1
        FROM kernel.outbox AS o
        WHERE o.tenant_id = e.tenant_id
          AND o.seq > e.watermark_seq
          AND o.seq < ${seq}::bigint
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(s.filter) AS entry
            WHERE entry->>'type' = o.type
              AND entry->'versions' @> jsonb_build_array(o.version)
          )
      )`.execute(trx);
}
