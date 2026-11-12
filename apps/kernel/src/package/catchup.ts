// SPDX-License-Identifier: Apache-2.0
// Throttled re-enable catch-up (plan §4.4). One call delivers at most
// CATCHUP_BATCH events for one tenant, starting at that tenant's watermark
// and stopping at the installation cursor. The cursor is not moved. The
// delivery marker is the same pair the relay uses, so a later relay pass
// does not apply the event again. A payload version the filter lists and
// does not accept stops the pass and leaves the watermark.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { CATCHUP_BATCH } from '../bus/constants.ts';
import { parseFilter, type TypeFilter } from '../bus/validate.ts';
import { EnablementNotFoundError, PackageNotFoundError } from './errors.ts';

type Step = 'delivered' | 'duplicate' | 'idle' | 'stopped' | 'blocked';

type CatchHandler = (
  trx: Transaction<Database>,
  event: {
    subscriptionId: string;
    seq: string;
    tenantId: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: string;
    type: string;
    version: number;
    payload: unknown;
    idempotencyKey: string;
  },
) => Promise<void>;

function deliveryKey(subscriptionId: string, seq: string): string {
  return `${subscriptionId}:${seq}`;
}

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
  handler: CatchHandler,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<number> {
    let delivered = 0;
  for (let step = 0; step < CATCHUP_BATCH; step += 1) {
    const outcome = await withTenant(db, tenantId, evidence, terminateBackend, async (trx) =>
      deliverOne(trx, packageId, tenantId, handler));
    if (outcome === 'idle' || outcome === 'stopped' || outcome === 'blocked') break;
    if (outcome === 'delivered') delivered += 1;
  }
  return delivered;
}

async function deliverOne(
  trx: Transaction<Database>,
  packageId: string,
  tenantId: string,
  handler: CatchHandler,
): Promise<Step> {
  const locked = await sql<{ subscription_id: string; last_seq: string; filter: unknown }>`
    SELECT p.subscription_id::text AS subscription_id,
           s.last_seq::text AS last_seq,
           s.filter
    FROM kernel.package AS p
    JOIN kernel.subscription AS s ON s.id = p.subscription_id
    WHERE p.id = ${packageId}
    FOR UPDATE OF s`.execute(trx);
  const subscription = locked.rows[0];
  if (!subscription) throw new PackageNotFoundError();
  const held = await sql<{ enabled: boolean; watermark_seq: string }>`
    SELECT enabled, watermark_seq::text AS watermark_seq
    FROM kernel.package_enablement
    WHERE package_id = ${packageId}
      AND tenant_id = ${tenantId}::uuid
    FOR UPDATE`.execute(trx);
  const row = held.rows[0];
  if (!row) throw new EnablementNotFoundError();
  if (!row.enabled) return 'stopped';
  const point = await safePoint(trx);
  if (!point) return 'idle';
  const filter = parseFilter(subscription.filter);
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
      AND seq <= LEAST(${point}::bigint, ${subscription.last_seq}::bigint)
      AND type = ANY(${types}::text[])
    ORDER BY seq
    LIMIT 1`.execute(trx);
  const event = next.rows[0];
  if (!event) return 'idle';
  if (!accepted(filter, event.type, event.version)) return 'blocked';
  const key = deliveryKey(subscription.subscription_id, event.seq);
  const inserted = await sql<{ seq: string }>`
    INSERT INTO kernel.delivery (subscription_id, seq, idempotency_key)
    VALUES (${subscription.subscription_id}::uuid, ${event.seq}::bigint, ${key})
    ON CONFLICT (subscription_id, seq) DO NOTHING
    RETURNING seq::text AS seq`.execute(trx);
  if (inserted.rows.length === 1) {
    await handler(trx, {
      subscriptionId: subscription.subscription_id,
      seq: event.seq,
      tenantId: event.tenant_id,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      aggregateVersion: event.aggregate_version,
      type: event.type,
      version: event.version,
      payload: event.payload,
      idempotencyKey: key,
    });
  }
  const moved = await sql<{ package_id: string }>`
    UPDATE kernel.package_enablement
    SET watermark_seq = ${event.seq}::bigint
    WHERE package_id = ${packageId}
      AND tenant_id = ${tenantId}::uuid
      AND enabled = true
      AND watermark_seq = ${row.watermark_seq}::bigint
    RETURNING package_id`.execute(trx);
  if (moved.rows.length !== 1) throw new Error('watermark advance lost the row');
  return inserted.rows.length === 1 ? 'delivered' : 'duplicate';
}

function accepted(filter: readonly TypeFilter[], type: string, version: number): boolean {
  const match = filter.find((entry) => entry.type === type);
  return match !== undefined && match.versions.includes(version);
}

/** Drain every enabled tenant whose watermark is behind its installation cursor. */
export async function catchUpBacklog(
  db: Kysely<Database>,
  handler: CatchHandler,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<number> {
  const due = await sql<{ package_id: string; tenant_id: string }>`
    SELECT e.package_id, e.tenant_id::text AS tenant_id
    FROM kernel.package_enablement AS e
    JOIN kernel.package AS p ON p.id = e.package_id
    JOIN kernel.subscription AS s ON s.id = p.subscription_id
    WHERE e.enabled = true
      AND e.released_at IS NULL
      AND e.watermark_seq < s.last_seq
    ORDER BY e.package_id, e.tenant_id`.execute(db);
  let total = 0;
  for (const row of due.rows) {
    for (;;) {
      const delivered = await catchUpTenant(
        db,
        row.package_id,
        row.tenant_id,
        handler,
        evidence,
        terminateBackend,
      );
      total += delivered;
      if (delivered === 0) break;
    }
  }
  return total;
}
