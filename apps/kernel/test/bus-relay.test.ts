// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { appendEvent, type AppendedEvent } from '../src/bus/append.ts';
import { DRAIN_LIMIT, LISTENER_FAILED, NO_LISTENER_ALERT, RETRY_RESERVE } from '../src/bus/constants.ts';
import {
  createFailureGate,
  deliverAvailable,
  deliverOne,
  deliveryKey,
  type DeliveredEvent,
} from '../src/bus/deliver.ts';
import { assertDirectListen, countRelayListeners, listenForOutbox, listenOrClose } from '../src/bus/listen.ts';
import {
  continueDrain,
  createPassScheduler,
  rememberAlert,
  runRelayPass,
  startRelay,
} from '../src/bus/relay.ts';
import { retainLog } from '../src/bus/retain.ts';
import { registerSubscription } from '../src/bus/subscription.ts';
import type { Database } from '../src/db/database.ts';
import { inspectKernelInternal } from '../src/schema/kernel-internal.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import {
  FIXTURE_AGGREGATE,
  FIXTURE_TYPE,
  OTHER_TYPE,
  ageSeqs,
  createEffectTable,
  errorCode,
  insertCustomer,
  resetBus,
  waitFor,
  withRoot,
} from './bus-support.ts';
import { DIRECT, POOLED, appDb, terminate } from './support.ts';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

async function publish(
  db: Kysely<Database>,
  tenantId: string,
  type: string,
  version: number,
): Promise<AppendedEvent> {
  return appendEvent(
    db,
    tenantId,
    {
      aggregateType: type === FIXTURE_TYPE ? FIXTURE_AGGREGATE : 'kernel.bus',
      type,
      version,
      payload: { marker: type },
    },
    blankEvidence(),
    terminate,
  );
}

async function cursor(db: Kysely<Database>, id: string): Promise<{
  lastSeq: string;
  status: string;
  parkReason: string | null;
}> {
  const result = await sql<{ last_seq: string; status: string; park_reason: string | null }>`
    SELECT last_seq::text AS last_seq, status, park_reason
    FROM kernel.subscription
    WHERE id = ${id}::uuid`.execute(db);
  const row = result.rows[0];
  if (!row) throw new Error('subscription missing');
  return { lastSeq: row.last_seq, status: row.status, parkReason: row.park_reason };
}

async function insertAged(tenantId: string, count: number): Promise<string[]> {
  const seqs = await withRoot(async (client) => {
    const result = await client.query<{ seq: string }>(
      `INSERT INTO kernel.outbox (
         seq, tenant_id, aggregate_type, aggregate_id, aggregate_version,
         type, version, payload, created_at
       )
       SELECT nextval('kernel.outbox_seq'),
              $1::uuid,
              $2,
              $1::uuid,
              n,
              $3,
              1,
              '{"marker":"backlog"}'::jsonb,
              clock_timestamp() - interval '11 seconds'
       FROM generate_series(1, $4::int) AS n
       RETURNING seq::text AS seq`,
      [tenantId, FIXTURE_AGGREGATE, FIXTURE_TYPE, count],
    );
    return result.rows.map((row) => row.seq);
  });
  seqs.sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
  return seqs;
}

async function outboxSeqs(): Promise<string[]> {
  return withRoot(async (client) => {
    const result = await client.query<{ seq: string }>(
      'SELECT seq::text AS seq FROM kernel.outbox ORDER BY seq',
    );
    return result.rows.map((row) => row.seq);
  });
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test('kernel source does not load the fixture publisher package', () => {
  for (const file of walk(join(here, '../src'))) {
    if (!/\.(ts|tsx|mts)$/.test(file)) continue;
    const body = readFileSync(file, 'utf8');
    assert.equal(body.includes('fixture_publisher'), false, file);
    assert.equal(body.includes('plugins/'), false, file);
  }
});

test('relay relations are kernel-internal and a plugin role cannot read them', async () => {
  await resetBus();
  await withRoot(async (client) => {
    for (const relation of ['subscription', 'delivery', 'dead_letter', 'outbox']) {
      assert.deepEqual(await inspectKernelInternal(client, relation), [], relation);
    }
  });
  const client = new pg.Client({ connectionString: POOLED });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE plerni_plugin_a');
    await assert.rejects(
      () => client.query('SELECT id FROM kernel.subscription'),
      (error: unknown) => errorCode(error) === '42501',
    );
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
});

test('safe_point is the max committed seq at least the horizon old', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const older = await publish(db, tenantId, FIXTURE_TYPE, 1);
    const newer = await publish(db, tenantId, FIXTURE_TYPE, 1);
    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const seen: string[] = [];
    const record = async (_trx: unknown, event: DeliveredEvent): Promise<void> => {
      seen.push(event.seq);
    };
    const inside = await deliverAvailable(db, record, terminate);
    assert.equal(inside.delivered, 0);
    assert.deepEqual(seen, []);
    assert.equal((await cursor(db, subscriptionId)).lastSeq, '0');
    await ageSeqs([older.seq]);
    const horizon = await deliverAvailable(db, record, terminate);
    assert.deepEqual(seen, [older.seq]);
    assert.equal(horizon.delivered, 1);
    assert.equal((await cursor(db, subscriptionId)).lastSeq, older.seq);
    assert.ok((await outboxSeqs()).includes(newer.seq));
    await ageSeqs([newer.seq]);
    await deliverAvailable(db, record, terminate);
    assert.deepEqual(seen, [older.seq, newer.seq]);
  } finally {
    await db.destroy();
  }
});

test('a filtered subscription advances past a type it does not list', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const skipped = await publish(db, tenantId, OTHER_TYPE, 1);
    const wanted = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([skipped.seq, wanted.seq]);
    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const seen: string[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.type);
    }, terminate);
    assert.deepEqual(seen, [FIXTURE_TYPE]);
    assert.equal(report.skipped, 1);
    assert.equal(report.delivered, 1);
    assert.equal((await cursor(db, subscriptionId)).lastSeq, wanted.seq);
  } finally {
    await db.destroy();
  }
});

test('version 2 parks the fixture consumer and a subscription that does not list the type advances', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const other = await publish(db, tenantId, OTHER_TYPE, 1);
    const versionOne = await publish(db, tenantId, FIXTURE_TYPE, 1);
    const versionTwo = await publish(db, tenantId, FIXTURE_TYPE, 2);
    await ageSeqs([other.seq, versionOne.seq, versionTwo.seq]);
    const parkedId = randomUUID();
    const movingId = randomUUID();
    await registerSubscription(db, {
      id: parkedId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    await registerSubscription(db, {
      id: movingId,
      filter: [{ type: OTHER_TYPE, versions: [1] }],
      start: '0',
    });
    const seen: { type: string; version: number }[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push({ type: event.type, version: event.version });
    }, terminate);
    assert.equal(report.delivered, 2);
    assert.equal(report.parked, 1);
    assert.deepEqual(
      seen.slice().sort((left, right) => left.type.localeCompare(right.type)),
      [
        { type: FIXTURE_TYPE, version: 1 },
        { type: OTHER_TYPE, version: 1 },
      ],
    );
    const parked = await cursor(db, parkedId);
    assert.equal(parked.status, 'parked');
    assert.equal(parked.parkReason, 'UNKNOWN_EVENT_VERSION');
    assert.equal(parked.lastSeq, versionOne.seq);
    const moving = await cursor(db, movingId);
    assert.equal(moving.status, 'live');
    assert.ok(BigInt(moving.lastSeq) >= BigInt(versionTwo.seq));
    assert.ok((await outboxSeqs()).includes(versionTwo.seq));
    const deleted = await retainLog(db);
    assert.equal(deleted, 1);
    const remaining = await outboxSeqs();
    assert.equal(remaining.includes(other.seq), false);
    assert.deepEqual(remaining, [versionOne.seq, versionTwo.seq]);
  } finally {
    await db.destroy();
  }
});

test('a crash after the effect redelivers the same key and the unique pair leaves one row', async () => {
  await resetBus();
  await createEffectTable();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const keys: string[] = [];
    let crash = true;
    const handler = async (trx: Kysely<Database>, event: DeliveredEvent): Promise<void> => {
      keys.push(event.idempotencyKey);
      await sql`
        INSERT INTO kernel.bus_effect (subscription_id, seq, idempotency_key)
        VALUES (
          ${event.subscriptionId}::uuid,
          ${event.seq}::bigint,
          ${event.idempotencyKey}
        )`.execute(trx);
      if (crash) {
        crash = false;
        throw new Error('crash after effect before ack');
      }
    };
    const gate = createFailureGate();
    const failed = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(failed.delivered, 0);
    assert.ok(failed.alerts.includes('handler failed'));
    assert.deepEqual(keys, [deliveryKey(subscriptionId, appended.seq)]);
    const effects = async (): Promise<number> => withRoot(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM kernel.bus_effect',
      );
      return Number(result.rows[0]?.count ?? '0');
    });
    assert.equal(await effects(), 0);
    const letters = await sql<{ reason: string }>`
      SELECT reason FROM kernel.dead_letter
      WHERE subscription_id = ${subscriptionId}::uuid AND seq = ${appended.seq}::bigint`.execute(db);
    assert.equal(letters.rows[0]?.reason, 'HANDLER_FAILED');
    assert.ok((await outboxSeqs()).includes(appended.seq));
    const delivered = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(delivered.delivered, 1);
    assert.deepEqual(keys, [
      deliveryKey(subscriptionId, appended.seq),
      deliveryKey(subscriptionId, appended.seq),
    ]);
    assert.equal(await effects(), 1);
    await sql`
      UPDATE kernel.subscription
      SET last_seq = 0
      WHERE id = ${subscriptionId}::uuid`.execute(db);
    const duplicate = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(duplicate.duplicates, 1);
    assert.equal(duplicate.delivered, 0);
    assert.equal(keys.length, 2);
    assert.equal(await effects(), 1);
    assert.equal((await cursor(db, subscriptionId)).lastSeq, appended.seq);
    const constraint = await withRoot(async (client) => {
      const result = await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'kernel'
           AND c.relname = 'delivery'
           AND con.conname = 'delivery_subscription_seq'`,
      );
      return result.rows[0]?.def ?? '';
    });
    assert.match(constraint, /PRIMARY KEY \(subscription_id, seq\)/);
  } finally {
    await db.destroy();
  }
});

test('a stale fencing token commits no effect', async () => {
  await resetBus();
  await createEffectTable();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    let calls = 0;
    const handler = async (trx: Kysely<Database>, event: DeliveredEvent): Promise<void> => {
      calls += 1;
      await sql`
        INSERT INTO kernel.bus_effect (subscription_id, seq, idempotency_key)
        VALUES (
          ${event.subscriptionId}::uuid,
          ${event.seq}::bigint,
          ${event.idempotencyKey}
        )`.execute(trx);
    };
    const stale = await deliverOne(db, handler, terminate, async (claim) => {
      await sql`
        UPDATE kernel.subscription
        SET fence = fence + 1
        WHERE id = ${claim.subscriptionId}::uuid`.execute(db);
    });
    assert.equal(stale.outcome.kind, 'stale');
    assert.equal(calls, 0);
    const delivered = await deliverOne(db, handler, terminate);
    assert.equal(delivered.outcome.kind, 'delivered');
    assert.equal(calls, 1);
  } finally {
    await db.destroy();
  }
});

test('retention keeps a live cursor and drops only older rows', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const first = await publish(db, tenantId, FIXTURE_TYPE, 1);
    const second = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([first.seq, second.seq]);
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const report = await deliverAvailable(db, async () => undefined, terminate);
    assert.equal(report.delivered, 2);
    const deleted = await retainLog(db);
    assert.equal(deleted, 1);
    assert.deepEqual(await outboxSeqs(), [second.seq]);
  } finally {
    await db.destroy();
  }
});

test('a new subscription starts at the high-water seq', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const first = await publish(db, tenantId, FIXTURE_TYPE, 1);
    const registered = await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: 'head',
    });
    assert.equal(registered.lastSeq, first.seq);
    const seen: string[] = [];
    const replay = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.equal(replay.delivered, 0);
    const second = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([second.seq]);
    await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [second.seq]);
  } finally {
    await db.destroy();
  }
});

test('polling delivers when LISTEN is down, and LISTEN stays on the direct connection', async () => {
  await resetBus();
  assert.throws(
    () => assertDirectListen(POOLED, POOLED),
    /pooled connection/,
  );
  assertDirectListen(DIRECT, POOLED);
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    assert.equal(await countRelayListeners(db), 0);
    const seen: string[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [appended.seq]);
    assert.ok(report.alerts.includes(NO_LISTENER_ALERT));
  } finally {
    await db.destroy();
  }
});

test('NOTIFY is empty and is not delivered before the appending transaction commits', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const payloads: string[] = [];
  const listener = await listenForOutbox(DIRECT, POOLED, (payload) => {
    payloads.push(payload);
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  const pending = appendEvent(
    db,
    tenantId,
    {
      aggregateType: FIXTURE_AGGREGATE,
      type: FIXTURE_TYPE,
      version: 1,
      payload: { marker: 'wake' },
    },
    blankEvidence(),
    terminate,
    async () => {
      paused = true;
      await hold;
    },
  );
  try {
    await waitFor('append paused before commit', async () => paused);
    assert.deepEqual(payloads, []);
    assert.equal(await countRelayListeners(db), 1);
    release();
    await pending;
    await waitFor('wake', async () => payloads.length === 1);
    assert.deepEqual(payloads, ['']);
  } finally {
    release();
    await pending.catch(() => undefined);
    await listener.close();
    await db.destroy();
  }
});

test('the relay poll delivers a row that becomes eligible while LISTEN is only a hint', { timeout: 20_000 }, async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const seen: string[] = [];
  const relay = await startRelay({
    db,
    directConnectionString: DIRECT,
    pooledConnectionString: POOLED,
    handler: async (_trx, event) => {
      seen.push(event.seq);
    },
    terminateBackend: terminate,
  });
  try {
    const appended = await appendEvent(
      db,
      tenantId,
      {
        aggregateType: FIXTURE_AGGREGATE,
        type: FIXTURE_TYPE,
        version: 1,
        payload: { marker: 'poll' },
      },
      blankEvidence(),
      terminate,
    );
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    await ageSeqs([appended.seq]);
    await waitFor('poll delivered', async () => seen.includes(appended.seq));
    assert.deepEqual(seen, [appended.seq]);
  } finally {
    await relay.stop();
    await db.destroy();
  }
});

test('a failing subscription does not stop a later healthy subscription in the same pass', async () => {
  await resetBus();
  await createEffectTable();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const poisonId = '00000000-0000-4000-8000-0000000000a1';
  const healthyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    await registerSubscription(db, {
      id: poisonId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    await registerSubscription(db, {
      id: healthyId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const report = await deliverAvailable(db, async (trx, event) => {
      if (event.subscriptionId === poisonId) throw new Error('poison handler');
      await sql`
        INSERT INTO kernel.bus_effect (subscription_id, seq, idempotency_key)
        VALUES (
          ${event.subscriptionId}::uuid,
          ${event.seq}::bigint,
          ${event.idempotencyKey}
        )`.execute(trx);
    }, terminate);
    assert.equal(report.delivered, 1);
    assert.ok(report.alerts.includes('handler failed'));
    assert.equal((await cursor(db, poisonId)).lastSeq, '0');
    assert.equal((await cursor(db, poisonId)).status, 'live');
    assert.equal((await cursor(db, healthyId)).lastSeq, appended.seq);
    const effects = await withRoot(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM kernel.bus_effect',
      );
      return Number(result.rows[0]?.count ?? '0');
    });
    assert.equal(effects, 1);
    assert.ok((await outboxSeqs()).includes(appended.seq));
  } finally {
    await db.destroy();
  }
});

test('a full drain of failing subscriptions yields on the next pass', { timeout: 60_000 }, async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const healthyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  try {
    const first = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([first.seq]);
    const filter = JSON.stringify([{ type: FIXTURE_TYPE, versions: [1] }]);
    await withRoot(async (client) => {
      await client.query(
        `INSERT INTO kernel.subscription (id, last_seq, status, park_reason, fence, filter)
         SELECT (
           '00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0')
         )::uuid, 0, 'live', NULL, 1, $1::jsonb
         FROM generate_series(1, $2::int) AS n`,
        [filter, DRAIN_LIMIT],
      );
    });
    await registerSubscription(db, {
      id: healthyId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const gate = createFailureGate();
    const handler = async (_trx: Kysely<Database>, event: DeliveredEvent): Promise<void> => {
      if (event.subscriptionId !== healthyId) throw new Error('poison handler');
    };
    const blocked = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(blocked.delivered, 0);
    assert.equal((await cursor(db, healthyId)).lastSeq, '0');
    const released = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(released.delivered, 1);
    assert.equal((await cursor(db, healthyId)).lastSeq, first.seq);
    const second = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([second.seq]);
    const again = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(again.delivered, 1);
    assert.equal((await cursor(db, healthyId)).lastSeq, second.seq);
  } finally {
    await db.destroy();
  }
});

test('a deferred subscription is retried while other work fills the pass', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const poisonId = '00000000-0000-4000-8000-0000000000b1';
  const healthyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const fresh = DRAIN_LIMIT - RETRY_RESERVE;
  try {
    const seqs = await insertAged(tenantId, DRAIN_LIMIT);
    await registerSubscription(db, {
      id: poisonId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const gate = createFailureGate();
    let recover = false;
    const handler = async (_trx: Kysely<Database>, event: DeliveredEvent): Promise<void> => {
      if (!recover && event.subscriptionId === poisonId) throw new Error('poison handler');
    };
    const blocked = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(blocked.delivered, 0);
    assert.equal((await cursor(db, poisonId)).lastSeq, '0');
    await registerSubscription(db, {
      id: healthyId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    recover = true;
    const report = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(report.delivered, fresh + 1);
    assert.equal((await cursor(db, poisonId)).lastSeq, seqs[0]);
    assert.equal((await cursor(db, healthyId)).lastSeq, seqs[fresh - 1]);
  } finally {
    await db.destroy();
  }
});

test('reserved retries rotate across passes that stay full', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const lowId = '00000000-0000-4000-8000-0000000000c1';
  const highId = '00000000-0000-4000-8000-0000000000c2';
  const healthyId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const fresh = DRAIN_LIMIT - RETRY_RESERVE;
  try {
    await insertAged(tenantId, fresh * 2 + 1);
    const filter = [{ type: FIXTURE_TYPE, versions: [1] }] as const;
    await registerSubscription(db, { id: lowId, filter, start: '0' });
    await registerSubscription(db, { id: highId, filter, start: '0' });
    const gate = createFailureGate();
    const calls = new Map<string, number>();
    const handler = async (_trx: Kysely<Database>, event: DeliveredEvent): Promise<void> => {
      calls.set(event.subscriptionId, (calls.get(event.subscriptionId) ?? 0) + 1);
      if (event.subscriptionId !== healthyId) throw new Error('poison handler');
    };
    await deliverAvailable(db, handler, terminate, gate);
    assert.equal(calls.get(lowId), 1);
    assert.equal(calls.get(highId), 1);
    await registerSubscription(db, { id: healthyId, filter, start: '0' });
    const first = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(first.delivered, fresh);
    assert.equal(calls.get(lowId), 2);
    assert.equal(calls.get(highId), 1);
    const second = await deliverAvailable(db, handler, terminate, gate);
    assert.equal(second.delivered, fresh);
    assert.equal(calls.get(lowId), 2);
    assert.equal(calls.get(highId), 2);
    assert.equal(calls.get(healthyId), fresh * 2);
  } finally {
    await db.destroy();
  }
});

test('a recovered contaminated connection still reports the security alert', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 1);
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    await sql`SELECT set_config('plerni.tenant_id', ${tenantId}, false)`.execute(db);
    const seen: string[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [appended.seq]);
    assert.equal(report.delivered, 1);
    assert.ok(report.alerts.some((alert) => alert.includes('SECURITY contamination')));
  } finally {
    await db.destroy();
  }
});

test('polling starts when the direct listener cannot connect', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const refused = new URL(DIRECT);
  refused.port = '54329';
  const seen: string[] = [];
  const relay = await startRelay({
    db,
    directConnectionString: refused.toString(),
    pooledConnectionString: POOLED,
    handler: async (_trx, event) => {
      seen.push(event.seq);
    },
    terminateBackend: terminate,
  });
  try {
    const appended = await publish(db, tenantId, FIXTURE_TYPE, 1);
    await ageSeqs([appended.seq]);
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    await waitFor('poll without a listener', async () => seen.includes(appended.seq));
    assert.ok(relay.alerts().includes(LISTENER_FAILED));
  } finally {
    await relay.stop();
    await db.destroy();
  }
});

test('wake-ups during a pass collapse into one rerun', async () => {
  let entered = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let mark!: () => void;
  const started = new Promise<void>((resolve) => {
    mark = resolve;
  });
  const scheduler = createPassScheduler(async () => {
    entered += 1;
    if (entered === 1) {
      mark();
      await hold;
    }
  });
  scheduler.kick();
  await started;
  for (let i = 0; i < 10_000; i += 1) scheduler.kick();
  release();
  await scheduler.idle();
  assert.equal(entered, 2);
});

test('a pooled address with no port is still refused for LISTEN', () => {
  assert.throws(
    () => assertDirectListen('postgres://pooler/plerni', 'postgres://pooler/plerni'),
    /pooled connection/,
  );
  assertDirectListen('postgres://direct.example:5432/plerni', 'postgres://pooler.example:5432/plerni');
});

test('a rejected LISTEN closes the connected client', async () => {
  let ended = 0;
  const client = {
    on() {
      return undefined;
    },
    async query() {
      throw new Error('listen rejected');
    },
    async end() {
      ended += 1;
    },
  };
  await assert.rejects(() => listenOrClose(client), /listen rejected/);
  assert.equal(ended, 1);
});

test('a pass of only failures does not continue, and cursor progress does', () => {
  const empty = {
    delivered: 0,
    skipped: 0,
    withheld: 0,
    parked: 0,
    duplicates: 0,
    alerts: [],
    budgetExhausted: true,
  };
  assert.equal(continueDrain(empty), false);
  assert.equal(continueDrain({ ...empty, delivered: 1 }), true);
  assert.equal(continueDrain({ ...empty, delivered: 1, budgetExhausted: false }), false);
  assert.equal(continueDrain({ ...empty, skipped: 1 }), true);
});

test('one kick drains a backlog larger than the pass budget', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  const count = DRAIN_LIMIT * 2 + 88;
  try {
    const seqs = await insertAged(tenantId, count);
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const seen: string[] = [];
    const gate = createFailureGate();
    const alerts: string[] = [];
    const scheduler = createPassScheduler(() => runRelayPass(
      {
        db,
        handler: async (_trx, event) => {
          seen.push(event.seq);
        },
        terminateBackend: terminate,
      },
      gate,
      alerts,
      () => {
        scheduler.kick();
      },
    ));
    scheduler.kick();
    await scheduler.idle();
    assert.equal(seen.length, count);
    assert.deepEqual(seen, seqs);
  } finally {
    await db.destroy();
  }
});

test('repeated relay alerts stay bounded', () => {
  const alerts: string[] = [];
  for (let i = 0; i < 10_000; i += 1) rememberAlert(alerts, 'no relay listener');
  assert.deepEqual(alerts, ['no relay listener']);
  for (let i = 0; i < 100; i += 1) {
    rememberAlert(alerts, i % 2 === 0 ? 'handler failed' : 'relay failed: Error');
  }
  assert.ok(alerts.length <= 32);
});
