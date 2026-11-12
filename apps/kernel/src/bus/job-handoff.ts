// SPDX-License-Identifier: Apache-2.0
// Outbox to job, one transaction (ADR-0003 decision 5): claim the pending
// row, insert the job, mark dispatched. A throw rolls all three back.
import { fromKysely, type PgBoss } from 'pg-boss';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { appendEvent } from './append.ts';
import { JOB_AGGREGATE, JOB_EVENT_TYPE, JOB_QUEUE } from './job-constants.ts';
import { envelopeRecord, jobEnvelope, readEnvelope, type JobRequest } from './job-envelope.ts';

export interface HandedOff {
  seq: string;
  jobId: string;
}

export async function appendJob(
  db: Kysely<Database>,
  tenantId: string,
  request: JobRequest,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<{ seq: string }> {
  const envelope = jobEnvelope(tenantId, request);
  const appended = await appendEvent(
    db,
    tenantId,
    {
      aggregateType: JOB_AGGREGATE,
      type: JOB_EVENT_TYPE,
      version: envelope.payloadVersion,
      payload: envelopeRecord(envelope),
    },
    evidence,
    terminateBackend,
    async (assigned, trx) => {
      await sql`
        INSERT INTO kernel.job_dispatch (seq, status)
        VALUES (${assigned.seq}::bigint, 'pending')`.execute(trx);
    },
  );
  return { seq: appended.seq };
}

export async function handoffPending(
  db: Kysely<Database>,
  boss: PgBoss,
): Promise<HandedOff | null> {
  return db.transaction().execute(async (trx) => {
    const claimed = await sql<{ seq: string; tenant_id: string; version: number; payload: unknown }>`
      SELECT d.seq::text AS seq,
             o.tenant_id::text AS tenant_id,
             o.version,
             o.payload
      FROM kernel.job_dispatch AS d
      JOIN kernel.outbox AS o ON o.seq = d.seq
      WHERE d.status = 'pending'
      ORDER BY d.seq
      FOR UPDATE OF d SKIP LOCKED
      LIMIT 1`.execute(trx);
    const row = claimed.rows[0];
    if (!row) return null;
    const envelope = readEnvelope(row.payload, row.tenant_id);
    if (envelope.payloadVersion !== row.version) throw new Error('job envelope rejected');
    const jobId = await boss.send(JOB_QUEUE, envelope, {
      db: fromKysely(trx),
      retryLimit: envelope.attemptBudget,
      retryDelay: 0,
      retryBackoff: false,
      expireInSeconds: envelope.expireInSeconds,
      heartbeatSeconds: envelope.heartbeatSeconds,
    });
    if (!jobId) throw new Error('job insert returned no id');
    const marked = await sql<{ seq: string }>`
      UPDATE kernel.job_dispatch
      SET status = 'dispatched',
          job_id = ${jobId}::uuid,
          dispatched_at = clock_timestamp()
      WHERE seq = ${row.seq}::bigint
        AND status = 'pending'
      RETURNING seq::text AS seq`.execute(trx);
    if (marked.rows.length !== 1) throw new Error('job dispatch mark lost the row');
    return { seq: row.seq, jobId };
  });
}

export { withTenant };
