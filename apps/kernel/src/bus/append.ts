// SPDX-License-Identifier: Apache-2.0
// Append one log row under the aggregate's row lock (plan §4.2, ADR-0009).
// The aggregate row is kernel.tenants. aggregate_version is incremented
// under FOR UPDATE, then nextval allocates seq. Nothing takes an advisory
// lock. NOTIFY is a zero-payload wake-up in the same transaction.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { OUTBOX_CHANNEL } from './constants.ts';
import {
  assertAggregateType,
  assertEventType,
  assertPayload,
  assertPayloadVersion,
  assertUuid,
} from './validate.ts';

export interface AppendInput {
  aggregateType: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
}

export interface AppendedEvent {
  seq: string;
  aggregateVersion: string;
  backendPid: number;
}

export async function appendEvent(
  db: Kysely<Database>,
  tenantId: string,
  input: AppendInput,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  afterAssign?: (assigned: AppendedEvent, trx: Transaction<Database>) => Promise<void>,
): Promise<AppendedEvent> {
  assertUuid(tenantId, 'tenant id');
  assertAggregateType(input.aggregateType);
  assertEventType(input.type);
  assertPayloadVersion(input.version);
  assertPayload(input.payload);
  const payload = JSON.stringify(input.payload);
  return withTenant(db, tenantId, evidence, terminateBackend, async (trx) => {
    const locked = await sql<{ id: string }>`
      SELECT id::text AS id
      FROM kernel.tenants
      WHERE id = ${tenantId}::uuid
      FOR UPDATE`.execute(trx);
    if (!locked.rows[0]) throw new Error('aggregate row missing under lock');
    const bumped = await sql<{ aggregate_version: string }>`
      UPDATE kernel.tenants
      SET aggregate_version = aggregate_version + 1
      WHERE id = ${tenantId}::uuid
      RETURNING aggregate_version::text AS aggregate_version`.execute(trx);
    const aggregateVersion = bumped.rows[0]?.aggregate_version;
    if (!aggregateVersion || aggregateVersion === '0') {
      throw new Error('aggregate version was not assigned');
    }
    const allocated = await sql<{ seq: string }>`
      SELECT nextval('kernel.outbox_seq')::text AS seq`.execute(trx);
    const seq = allocated.rows[0]?.seq;
    if (!seq) throw new Error('outbox sequence returned no value');
    await sql`
      INSERT INTO kernel.outbox (
        seq, tenant_id, aggregate_type, aggregate_id, aggregate_version, type, version, payload
      ) VALUES (
        ${seq}::bigint,
        ${tenantId}::uuid,
        ${input.aggregateType},
        ${tenantId}::uuid,
        ${aggregateVersion}::bigint,
        ${input.type},
        ${input.version},
        ${payload}::jsonb
      )`.execute(trx);
    await sql`SELECT pg_notify(${OUTBOX_CHANNEL}, '')`.execute(trx);
    const pidRow = await sql<{ pid: string }>`
      SELECT pg_backend_pid()::text AS pid`.execute(trx);
    const backendPid = Number(pidRow.rows[0]?.pid);
    if (!Number.isInteger(backendPid)) throw new Error('backend pid missing');
    const assigned = { seq, aggregateVersion, backendPid };
    if (afterAssign) await afterAssign(assigned, trx);
    return assigned;
  });
}
