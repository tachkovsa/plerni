// SPDX-License-Identifier: Apache-2.0
// Heartbeat on a reserved direct connection. The sweeper redispatches only
// when the lease is over and a heartbeat was missed (ADR-0003 decision 6).
// started_on stays set: the next claim increments retry_count, which is the
// fencing token. Clearing it would hand the next worker the same token.
import pg from 'pg';
import { fromKysely, type PgBoss } from 'pg-boss';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  HEARTBEAT_APPLICATION,
  JOB_QUEUE,
  JOB_SCHEMA,
} from './job-constants.ts';

const SCHEMA = /^[a-z][a-z0-9_]{0,40}$/;

function quotedSchema(): string {
  if (!SCHEMA.test(JOB_SCHEMA)) throw new Error('job schema rejected');
  return JOB_SCHEMA;
}

export function attemptToken(id: string, retryCount: number): string {
  if (!Number.isInteger(retryCount) || retryCount < 0) throw new Error('job fence rejected');
  return `${id.toLowerCase()}:${retryCount}`;
}

function endpoint(value: string): string {
  const url = new URL(value);
  const port = url.port === '' ? '5432' : url.port;
  return `${url.hostname.toLowerCase()}:${port}`;
}

export function assertReservedHeartbeat(direct: string, pooled: string): void {
  let reserved: string;
  let pool: string;
  try {
    reserved = endpoint(direct);
    pool = endpoint(pooled);
  } catch {
    throw new Error('heartbeat connection rejected');
  }
  if (reserved === pool) throw new Error('heartbeat is not allowed on the pooled connection');
}

export async function openHeartbeatClient(direct: string, pooled: string): Promise<pg.Client> {
  assertReservedHeartbeat(direct, pooled);
  const client = new pg.Client({
    connectionString: direct,
    application_name: HEARTBEAT_APPLICATION,
  });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

export async function renewJobHeartbeat(
  client: pg.Client,
  jobId: string,
  retryCount: number,
): Promise<boolean> {
  const name = await client.query<{ name: string }>(
    `SELECT current_setting('application_name') AS name`,
  );
  if (name.rows[0]?.name !== HEARTBEAT_APPLICATION) {
    throw new Error('heartbeat is not allowed on the pooled connection');
  }
  const schema = quotedSchema();
  const updated = await client.query(
    `UPDATE ${schema}.job
     SET heartbeat_on = ${schema}.job_now()
     WHERE id = $1::uuid
       AND state = 'active'
       AND (id::text || ':' || retry_count::text) = $2`,
    [jobId, attemptToken(jobId, retryCount)],
  );
  return updated.rowCount === 1;
}

export interface SweepHit {
  id: string;
  state: string;
}

/** Lease expiry alone matches nothing. A current heartbeat matches nothing. */
export async function sweepJobs(db: Kysely<Database>): Promise<SweepHit[]> {
  const schema = quotedSchema();
  const result = await sql<{ id: string; state: string }>`
    UPDATE ${sql.raw(`${schema}.job`)}
    SET state = CASE
          WHEN retry_count < retry_limit THEN 'retry'::${sql.raw(`${schema}.job_state`)}
          ELSE 'failed'::${sql.raw(`${schema}.job_state`)}
        END,
        heartbeat_on = NULL,
        completed_on = CASE
          WHEN retry_count < retry_limit THEN completed_on
          ELSE ${sql.raw(`${schema}.job_now()`)}
        END
    WHERE name = ${JOB_QUEUE}
      AND state = 'active'
      AND started_on IS NOT NULL
      AND (started_on + expire_seconds * interval '1 second') < ${sql.raw(`${schema}.job_now()`)}
      AND heartbeat_seconds IS NOT NULL
      AND (heartbeat_on + heartbeat_seconds * interval '1 second') < ${sql.raw(`${schema}.job_now()`)}
    RETURNING id::text AS id, state::text AS state`.execute(db);
  return result.rows.map((row) => ({ id: row.id, state: row.state }));
}

export class StaleJobFence extends Error {
  constructor() {
    super('stale job fence');
    this.name = 'StaleJobFence';
  }
}

export async function settleJob(
  db: Kysely<Database>,
  boss: PgBoss,
  tenantId: string,
  attempt: { id: string; retryCount: number },
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  effect: (trx: Transaction<Database>) => Promise<void>,
): Promise<void> {
  await withTenant(db, tenantId, evidence, terminateBackend, async (trx) => {
    await effect(trx);
    const result = await boss.complete(JOB_QUEUE, [attempt], null, { db: fromKysely(trx) });
    if (result.affected !== 1) throw new StaleJobFence();
  });
}
