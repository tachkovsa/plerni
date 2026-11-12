// SPDX-License-Identifier: Apache-2.0
// Throttled re-enable catch-up (plan §4.4). One call delivers at most
// CATCHUP_BATCH events for one tenant, starting at that tenant's watermark.
// The installation cursor is not moved. A payload version the filter lists
// and does not accept stops the pass and leaves the watermark.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { CATCHUP_BATCH } from '../bus/constants.ts';
import { deliveryKey, type DeliveredEvent, type DeliveryHandler } from '../bus/deliver.ts';
import { parseFilter, type TypeFilter } from '../bus/validate.ts';
import { EnablementNotFoundError, PackageNotFoundError } from './errors.ts';

type Step = 'delivered' | 'idle' | 'stopped' | 'blocked';

async function safePoint(trx: Transaction<Database>): Promise<string | null> {
  const result = await sql<{ safe_point: string | null }>`
    SELECT max(seq)::text AS safe_point
    FROM kernel.outbox
    WHERE created_at <= clock_timestamp() - interval '10 seconds'`.execute(trx);
  return result.rows[0]?.safe_point ?? null;
}

export async function catchUpTenant(
  db: Kysely<Database>,
  packageId: string,
  tenantId: string,
  handler: DeliveryHandler,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<number> {
  let delivered = 0;
  for (let step = 0; step < CATCHUP_BATCH; step += 1) {
    const outcome = await withTenant(db, tenantId, evidence, terminateBackend, async (trx) =>
      deliverOne(trx, packageId, tenantId, handler));
    if (outcome !== 'delivered') break;
    delivered += 1;
  }
  return delivered;
}

async function deliverOne(
  trx: Transaction<Database>,
  packageId: string,
  tenantId: string,
  handler: DeliveryHandler,
): Promise<Step> {
  const held = await sql<{
    enabled: boolean;
    watermark_seq: string;
    subscription_id: string;
    filter: unknown;
  }>`
    SELECT e.enabled,
           e.watermark_seq::text AS watermark_seq,
           p.subscription_id::text AS subscription_id,
           s.filter
    FROM kernel.package_enablement AS e
    JOIN kernel.package AS p ON p.id = e.package_id
    JOIN kernel.subscription AS s ON s.id = p.subscription_id
    WHERE e.package_id = ${packageId}
      AND e.tenant_id = ${tenantId}::uuid
    FOR UPDATE OF e`.execute(trx);
  const row = held.rows[0];
  if (!row) {
    const packageRow = await sql<{ id: string }>`
      SELECT id FROM kernel.package WHERE id = ${packageId}`.execute(trx);
    if (!packageRow.rows[0]) throw new PackageNotFoundError();
    throw new EnablementNotFoundError();
  }
  if (!row.enabled) return 'stopped';
  const point = await safePoint(trx);
  if (!point) return 'idle';
  const filter = parseFilter(row.filter);
  const types = filter.map((entry) => entry.type);
  const next = await sql<{
    seq: string;
    tenant_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    type: string;
    version: number;
    payload: unknown;
  }>`
    SELECT seq::text AS seq,
           tenant_id::text AS tenant_id,
           aggregate_type,
           aggregate_id::text AS aggregate_id,
           aggregate_version::text AS aggregate_version,
           type,
           version,
           payload
    FROM kernel.outbox
    WHERE tenant_id = ${tenantId}::uuid
      AND seq > ${row.watermark_seq}::bigint
      AND seq <= ${point}::bigint
      AND type = ANY(${types}::text[])
    ORDER BY seq
    LIMIT 1`.execute(trx);
  const event = next.rows[0];
  if (!event) return 'idle';
  if (!accepted(filter, event.type, event.version)) return 'blocked';
  const key = deliveryKey(row.subscription_id, event.seq);
  await handler(trx, {
    subscriptionId: row.subscription_id,
    seq: event.seq,
    tenantId: event.tenant_id,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    aggregateVersion: event.aggregate_version,
    type: event.type,
    version: event.version,
    payload: event.payload,
    idempotencyKey: key,
  } satisfies DeliveredEvent);
  const moved = await sql<{ package_id: string }>`
    UPDATE kernel.package_enablement
    SET watermark_seq = ${event.seq}::bigint
    WHERE package_id = ${packageId}
      AND tenant_id = ${tenantId}::uuid
      AND enabled = true
      AND watermark_seq = ${row.watermark_seq}::bigint
    RETURNING package_id`.execute(trx);
  if (moved.rows.length !== 1) throw new Error('watermark advance lost the row');
  return 'delivered';
}

function accepted(filter: readonly TypeFilter[], type: string, version: number): boolean {
  const match = filter.find((entry) => entry.type === type);
  return match !== undefined && match.versions.includes(version);
}
