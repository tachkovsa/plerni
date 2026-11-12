// SPDX-License-Identifier: Apache-2.0
// Retention low-water for this task is the minimum subscription cursor,
// live or parked (plan §4.2). A row at or above that minimum stays.
// Tenant enablement watermarks, the backlog quota, and export-then-force-advance
// are K18. This pass does not drop a parked cursor out of the minimum.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';

export async function retainLog(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ deleted: string }>`
    WITH low AS (
      SELECT min(last_seq) AS seq FROM kernel.subscription
    ),
    removed AS (
      DELETE FROM kernel.outbox
      WHERE (SELECT seq FROM low) IS NOT NULL
        AND seq < (SELECT seq FROM low)
      RETURNING seq
    )
    SELECT count(*)::text AS deleted FROM removed`.execute(db);
  return Number(result.rows[0]?.deleted ?? '0');
}
