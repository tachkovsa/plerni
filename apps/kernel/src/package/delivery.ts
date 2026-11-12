// SPDX-License-Identifier: Apache-2.0
// Installation delivery consults the per-tenant watermark (plan §4.4).
// A disabled tenant does not receive the event. The caller still advances
// the installation cursor. An enabled tenant's watermark moves with the event.
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';

export async function installationDelivery(
  trx: Transaction<Database>,
  subscriptionId: string,
  tenantId: string,
): Promise<'plain' | 'withhold' | 'accept'> {
  const found = await sql<{ id: string }>`
    SELECT id
    FROM kernel.package
    WHERE subscription_id = ${subscriptionId}::uuid`.execute(trx);
  const packageId = found.rows[0]?.id;
  if (!packageId) return 'plain';
  const row = await sql<{ enabled: boolean }>`
    SELECT enabled
    FROM kernel.package_enablement
    WHERE package_id = ${packageId}
      AND tenant_id = ${tenantId}::uuid
    FOR UPDATE`.execute(trx);
  if (row.rows[0]?.enabled !== true) return 'withhold';
  return 'accept';
}

export async function advanceEnabledWatermark(
  trx: Transaction<Database>,
  subscriptionId: string,
  tenantId: string,
  seq: string,
): Promise<void> {
  await sql`
    UPDATE kernel.package_enablement AS e
    SET watermark_seq = ${seq}::bigint
    FROM kernel.package AS p
    WHERE p.id = e.package_id
      AND p.subscription_id = ${subscriptionId}::uuid
      AND e.tenant_id = ${tenantId}::uuid
      AND e.enabled = true
      AND e.released_at IS NULL
      AND e.watermark_seq < ${seq}::bigint`.execute(trx);
}
