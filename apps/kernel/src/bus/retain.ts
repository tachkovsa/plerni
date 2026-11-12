// SPDX-License-Identifier: Apache-2.0
// Retention low-water is the minimum of unreleased subscription cursors
// and unreleased enablement watermarks (plan §4.2, §4.4). Quota expiry
// records a warning and leaves the hold in that minimum. A row at or above
// the minimum stays. Released holds are out of the minimum.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { QUOTA_BYTES, QUOTA_DAYS } from './constants.ts';

export async function retainLog(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`
      INSERT INTO kernel.quota_warning (package_id, tenant_id, subscription_id, reason)
      SELECT e.package_id, e.tenant_id, NULL, q.reason
      FROM kernel.package_enablement AS e
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(pg_column_size(o.*)), 0) AS bytes
        FROM kernel.outbox AS o
        WHERE o.seq >= e.watermark_seq
      ) AS b
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN e.held_since <= clock_timestamp() - (${QUOTA_DAYS}::int * interval '1 day') THEN 'age'
          WHEN b.bytes >= ${QUOTA_BYTES}::bigint THEN 'bytes'
          ELSE NULL
        END AS reason
      ) AS q
      WHERE e.released_at IS NULL
        AND e.enabled = false
        AND q.reason IS NOT NULL
      ON CONFLICT ON CONSTRAINT quota_warning_once DO NOTHING`.execute(trx);
    await sql`
      INSERT INTO kernel.quota_warning (package_id, tenant_id, subscription_id, reason)
      SELECT NULL, NULL, s.id, q.reason
      FROM kernel.subscription AS s
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(pg_column_size(o.*)), 0) AS bytes
        FROM kernel.outbox AS o
        WHERE o.seq >= s.last_seq
      ) AS b
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN s.created_at <= clock_timestamp() - (${QUOTA_DAYS}::int * interval '1 day') THEN 'age'
          WHEN b.bytes >= ${QUOTA_BYTES}::bigint THEN 'bytes'
          ELSE NULL
        END AS reason
      ) AS q
      WHERE s.status = 'parked'
        AND s.released_at IS NULL
        AND q.reason IS NOT NULL
      ON CONFLICT ON CONSTRAINT quota_warning_once DO NOTHING`.execute(trx);
    const result = await sql<{ deleted: string }>`
      WITH holds AS (
        SELECT last_seq AS seq
        FROM kernel.subscription
        WHERE released_at IS NULL
        UNION ALL
        SELECT watermark_seq AS seq
        FROM kernel.package_enablement
        WHERE released_at IS NULL
      ),
      low AS (
        SELECT min(seq) AS seq FROM holds
      ),
      removed AS (
        DELETE FROM kernel.outbox
        WHERE (SELECT seq FROM low) IS NOT NULL
          AND seq < (SELECT seq FROM low)
        RETURNING seq
      )
      SELECT count(*)::text AS deleted FROM removed`.execute(trx);
    return Number(result.rows[0]?.deleted ?? '0');
  });
}
