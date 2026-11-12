// SPDX-License-Identifier: Apache-2.0
// One global cursor per subscription (plan §4.2). A new subscription starts
// at the current high-water seq, or at a declared start seq. It does not
// replay history unless the caller asks. Package installation cursors are
// created by the registry. Per-tenant watermarks are separate rows.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertFilter, assertSeq, assertUuid, type TypeFilter } from './validate.ts';

export interface RegisterSubscriptionInput {
  id: string;
  filter: readonly TypeFilter[];
  /** 'head' is the committed high-water seq. A decimal string is a start seq. */
  start: 'head' | string;
}

export async function registerSubscription(
  db: Kysely<Database>,
  input: RegisterSubscriptionInput,
): Promise<{ lastSeq: string }> {
  assertUuid(input.id, 'subscription id');
  assertFilter(input.filter);
  if (input.start !== 'head') assertSeq(input.start);
  const filter = JSON.stringify(input.filter);
  return db.transaction().execute(async (trx) => {
    const high = await sql<{ seq: string }>`
      SELECT COALESCE(max(seq), 0)::text AS seq FROM kernel.outbox`.execute(trx);
    const head = high.rows[0]?.seq;
    if (head === undefined) throw new Error('high-water seq missing');
    const lastSeq = input.start === 'head' ? head : input.start;
    await sql`
      INSERT INTO kernel.subscription (id, last_seq, status, park_reason, fence, filter)
      VALUES (
        ${input.id}::uuid,
        ${lastSeq}::bigint,
        'live',
        NULL,
        1,
        ${filter}::jsonb
      )`.execute(trx);
    return { lastSeq };
  });
}
