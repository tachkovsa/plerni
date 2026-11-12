// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { appendEvent, type AppendedEvent } from '../src/bus/append.ts';
import { deliverAvailable } from '../src/bus/deliver.ts';
import { registerSubscription } from '../src/bus/subscription.ts';
import type { Database } from '../src/db/database.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import {
  FIXTURE_AGGREGATE,
  FIXTURE_TYPE,
  ageSeqs,
  insertCustomer,
  resetBus,
  waitFor,
  withRoot,
} from './bus-support.ts';
import { POOLED, appDb, terminate } from './support.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Gate {
  opened: Promise<AppendedEvent>;
  release: () => void;
  hook: (assigned: AppendedEvent) => Promise<void>;
}

function openGate(): Gate {
  let release!: () => void;
  let openedResolve!: (assigned: AppendedEvent) => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opened = new Promise<AppendedEvent>((resolve) => {
    openedResolve = resolve;
  });
  return {
    opened,
    release,
    hook: async (assigned) => {
      openedResolve(assigned);
      await hold;
    },
  };
}

/** Resolves when the writer pauses after assign. Rejects if that writer fails first. */
function untilPaused(gate: Gate, pending: Promise<unknown>, label: string): Promise<AppendedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), 5_000);
    const finish = (error?: unknown, value?: AppendedEvent) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value as AppendedEvent);
    };
    gate.opened.then((value) => finish(undefined, value), finish);
    pending.then(
      () => finish(new Error(`${label} committed before the pause`)),
      finish,
    );
  });
}

async function publish(
  db: Kysely<Database>,
  tenantId: string,
  version: number,
  afterAssign?: (assigned: AppendedEvent) => Promise<void>,
): Promise<AppendedEvent> {
  return appendEvent(
    db,
    tenantId,
    {
      aggregateType: FIXTURE_AGGREGATE,
      type: FIXTURE_TYPE,
      version,
      payload: { marker: tenantId },
    },
    blankEvidence(),
    terminate,
    afterAssign,
  );
}

async function committedVersions(aggregateId: string): Promise<string[]> {
  return withRoot(async (client) => {
    const result = await client.query<{ aggregate_version: string }>(
      `SELECT aggregate_version::text AS aggregate_version
       FROM kernel.outbox
       WHERE aggregate_id = $1::uuid
       ORDER BY seq`,
      [aggregateId],
    );
    return result.rows.map((row) => row.aggregate_version);
  });
}

async function lockDetail(pids: number[]): Promise<string> {
  return withRoot(async (client) => {
    const result = await client.query(
      `SELECT l.pid, l.locktype, l.mode, l.granted,
              CASE WHEN l.relation IS NULL THEN NULL ELSE l.relation::regclass::text END AS relation,
              a.wait_event_type, a.state
       FROM pg_locks l
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.pid = ANY($1::int[])
       ORDER BY l.pid, l.locktype`,
      [pids],
    );
    return JSON.stringify(result.rows);
  });
}

async function ungrantedCount(pids: number[]): Promise<number> {
  return withRoot(async (client) => {
    const result = await client.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting
       FROM pg_locks
       WHERE pid = ANY($1::int[]) AND NOT granted`,
      [pids],
    );
    return Number(result.rows[0]?.waiting ?? '0');
  });
}

async function advisoryCount(pids: number[]): Promise<number> {
  return withRoot(async (client) => {
    const result = await client.query<{ advisory: string }>(
      `SELECT count(*)::text AS advisory
       FROM pg_locks
       WHERE pid = ANY($1::int[]) AND locktype = 'advisory'`,
      [pids],
    );
    return Number(result.rows[0]?.advisory ?? '0');
  });
}

async function openTransactions(pids: number[]): Promise<number> {
  return withRoot(async (client) => {
    const result = await client.query<{ open: string }>(
      `SELECT count(*)::text AS open
       FROM pg_stat_activity
       WHERE pid = ANY($1::int[]) AND xact_start IS NOT NULL`,
      [pids],
    );
    return Number(result.rows[0]?.open ?? '0');
  });
}

async function tenantLocks(pids: number[]): Promise<number> {
  return withRoot(async (client) => {
    const result = await client.query<{ held: string }>(
      `SELECT count(DISTINCT pid)::text AS held
       FROM pg_locks
       WHERE pid = ANY($1::int[])
         AND granted
         AND relation = 'kernel.tenants'::regclass`,
      [pids],
    );
    return Number(result.rows[0]?.held ?? '0');
  });
}

async function waitsOn(holderPid: number, waiterPid: number): Promise<boolean> {
  return withRoot(async (client) => {
    const result = await client.query(
      `SELECT 1
       FROM pg_locks waiter
       JOIN pg_locks holder
         ON holder.locktype = waiter.locktype
        AND holder.transactionid IS NOT DISTINCT FROM waiter.transactionid
        AND holder.pid = $1
        AND holder.granted
        AND NOT waiter.granted
       WHERE waiter.pid = $2`,
      [holderPid, waiterPid],
    );
    return (result.rowCount ?? 0) > 0;
  });
}

async function waiterPid(holderPid: number): Promise<number | null> {
  return withRoot(async (client) => {
    const result = await client.query<{ pid: string }>(
      `SELECT a.pid::text AS pid
       FROM pg_stat_activity a
       WHERE a.usename = 'plerni_app'
         AND a.datname = current_database()
         AND a.wait_event_type = 'Lock'
         AND a.pid <> $1`,
      [holderPid],
    );
    const pid = result.rows[0]?.pid;
    return pid ? Number(pid) : null;
  });
}

test('the log writer and the relay migration take no advisory lock', () => {
  const files = [
    '../sql/0002_tenant_registry.sql',
    '../sql/0004_outbox_relay.sql',
    '../src/bus/append.ts',
    '../src/bus/deliver.ts',
    '../src/tenant/registry.ts',
  ];
  for (const file of files) {
    const body = readFileSync(join(here, file), 'utf8');
    assert.equal(/pg_advisory/i.test(body), false, file);
    assert.equal(/\bLOCK TABLE\b/i.test(body), false, file);
  }
  const append = readFileSync(join(here, '../src/bus/append.ts'), 'utf8');
  assert.match(append, /FOR UPDATE/);
  assert.match(append, /nextval\('kernel\.outbox_seq'\)/);
  const relay = readFileSync(join(here, '../src/bus/deliver.ts'), 'utf8');
  assert.match(relay, /FOR UPDATE SKIP LOCKED/);
  assert.match(relay, /interval '10 seconds'/);
});

test('different aggregates overlap, and each commits while the other transaction is open', async () => {
  await resetBus();
  const db = appDb(POOLED, 4);
  const gates: Gate[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    for (const first of [true, false]) {
      const leftId = randomUUID();
      const rightId = randomUUID();
      await insertCustomer(leftId);
      await insertCustomer(rightId);
      const left = openGate();
      const right = openGate();
      gates.push(left, right);
      const pendingLeft = publish(db, leftId, 1, left.hook);
      const pendingRight = publish(db, rightId, 1, right.hook);
      pending.push(pendingLeft, pendingRight);
      const assignedLeft = await untilPaused(left, pendingLeft, 'left assigned');
      const assignedRight = await untilPaused(right, pendingRight, 'right assigned');
      const pids = [assignedLeft.backendPid, assignedRight.backendPid];
      await waitFor('both transactions hold locks and neither waits', async () => {
        const [waiting, advisory, open, held] = await Promise.all([
          ungrantedCount(pids),
          advisoryCount(pids),
          openTransactions(pids),
          tenantLocks(pids),
        ]);
        return waiting === 0 && advisory === 0 && open === 2 && held === 2;
      }, () => lockDetail(pids));
      const early = first ? right : left;
      const earlyId = first ? rightId : leftId;
      const lateId = first ? leftId : rightId;
      const latePid = first ? assignedLeft.backendPid : assignedRight.backendPid;
      const earlyPending = first ? pendingRight : pendingLeft;
      early.release();
      await earlyPending;
      await waitFor('one row is committed while the other transaction stays open', async () => {
        const earlyRows = await committedVersions(earlyId);
        const lateRows = await committedVersions(lateId);
        const open = await openTransactions([latePid]);
        const waiting = await ungrantedCount([latePid]);
        const held = await tenantLocks([latePid]);
        return earlyRows.length === 1 && lateRows.length === 0 && open === 1 && waiting === 0 && held === 1;
      }, () => lockDetail(pids));
      (first ? left : right).release();
      await (first ? pendingLeft : pendingRight);
    }
  } finally {
    for (const gate of gates) gate.release();
    await Promise.allSettled(pending);
    await db.destroy();
  }
});

test('a paused writer does not block a commit on a different aggregate', async () => {
  await resetBus();
  const xId = randomUUID();
  const yId = randomUUID();
  await insertCustomer(xId);
  await insertCustomer(yId);
  const db = appDb(POOLED, 4);
  const held = openGate();
  const pendingX = publish(db, xId, 1, held.hook);
  let pendingY: Promise<AppendedEvent> | undefined;
  try {
    const assignedX = await untilPaused(held, pendingX, 'x assigned');
    pendingY = publish(db, yId, 1);
    await waitFor('y is committed and pg_locks still shows x holding the tenant row', async () => {
      const yRows = await committedVersions(yId);
      const xRows = await committedVersions(xId);
      const open = await openTransactions([assignedX.backendPid]);
      const heldLock = await tenantLocks([assignedX.backendPid]);
      const waiters = await withRoot(async (client) => {
        const result = await client.query<{ waiting: string }>(
          `SELECT count(*)::text AS waiting
           FROM pg_locks waiter
           JOIN pg_locks holder
             ON holder.locktype = waiter.locktype
            AND holder.transactionid IS NOT DISTINCT FROM waiter.transactionid
            AND holder.pid = $1
            AND holder.granted
            AND NOT waiter.granted`,
          [assignedX.backendPid],
        );
        return Number(result.rows[0]?.waiting ?? '0');
      });
      return yRows.length === 1 && xRows.length === 0 && open === 1 && heldLock === 1 && waiters === 0;
    }, () => lockDetail([assignedX.backendPid]));
    await pendingY;
  } finally {
    held.release();
    await Promise.allSettled([pendingX, pendingY ?? Promise.resolve()]);
    await db.destroy();
  }
});

test('the same aggregate applies versions in order once both seqs are at or below safe_point', async () => {
  await resetBus();
  const aggregate = randomUUID();
  await insertCustomer(aggregate);
  const db = appDb(POOLED, 4);
  const first = openGate();
  const second = openGate();
  const pendingA = publish(db, aggregate, 1, first.hook);
  let pendingB: Promise<AppendedEvent> | undefined;
  try {
    const assignedA = await untilPaused(first, pendingA, 'a assigned');
    pendingB = publish(db, aggregate, 1, second.hook);
    let waiter = 0;
    await waitFor('b blocks on a in pg_locks', async () => {
      const pid = await waiterPid(assignedA.backendPid);
      if (pid === null) return false;
      waiter = pid;
      return waitsOn(assignedA.backendPid, pid);
    }, () => lockDetail([assignedA.backendPid, waiter]));
    assert.deepEqual(await committedVersions(aggregate), []);
    first.release();
    const committedA = await pendingA;
    assert.deepEqual(await committedVersions(aggregate), [assignedA.aggregateVersion]);
    const assignedB = await untilPaused(second, pendingB, 'b assigned');
    assert.equal(assignedB.aggregateVersion, String(Number(assignedA.aggregateVersion) + 1));
    assert.ok(BigInt(assignedB.seq) > BigInt(assignedA.seq));
    assert.deepEqual(await committedVersions(aggregate), [assignedA.aggregateVersion]);
    second.release();
    await pendingB;
    assert.deepEqual(
      await committedVersions(aggregate),
      [committedA.aggregateVersion, assignedB.aggregateVersion],
    );

    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const applied: string[] = [];
    const young = await deliverAvailable(db, async (_trx, event) => {
      applied.push(event.aggregateVersion);
    }, terminate);
    assert.equal(young.delivered, 0);
    assert.equal(applied.length, 0);
    await ageSeqs([assignedA.seq, assignedB.seq]);
    const aged = await deliverAvailable(db, async (_trx, event) => {
      applied.push(event.aggregateVersion);
    }, terminate);
    assert.equal(aged.delivered, 2);
    assert.deepEqual(applied, [assignedA.aggregateVersion, assignedB.aggregateVersion]);
  } finally {
    first.release();
    second.release();
    await Promise.allSettled([pendingA, pendingB ?? Promise.resolve()]);
    await db.destroy();
  }
});

test('a rolled-back nextval at or below safe_point is skipped', async () => {
  await resetBus();
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const db = appDb(POOLED, 2);
  try {
    let gap = '';
    await assert.rejects(
      () => db.transaction().execute(async (trx) => {
        const allocated = await sql<{ seq: string }>`
          SELECT nextval('kernel.outbox_seq')::text AS seq`.execute(trx);
        gap = allocated.rows[0]?.seq ?? '';
        throw new Error('roll back the allocated seq');
      }),
    );
    assert.match(gap, /^[0-9]+$/);
    const missing = await withRoot(async (client) => {
      const result = await client.query(
        'SELECT 1 FROM kernel.outbox WHERE seq = $1::bigint',
        [gap],
      );
      return result.rowCount ?? 0;
    });
    assert.equal(missing, 0);
    const appended = await publish(db, tenantId, 1);
    assert.ok(BigInt(appended.seq) > BigInt(gap));
    await ageSeqs([appended.seq]);
    const subscriptionId = randomUUID();
    await registerSubscription(db, {
      id: subscriptionId,
      filter: [{ type: FIXTURE_TYPE, versions: [1] }],
      start: '0',
    });
    const seen: string[] = [];
    const report = await deliverAvailable(db, async (_trx, event) => {
      seen.push(event.seq);
    }, terminate);
    assert.deepEqual(seen, [appended.seq]);
    assert.equal(report.delivered, 1);
    const cursor = await sql<{ last_seq: string }>`
      SELECT last_seq::text AS last_seq
      FROM kernel.subscription
      WHERE id = ${subscriptionId}::uuid`.execute(db);
    assert.equal(cursor.rows[0]?.last_seq, appended.seq);
  } finally {
    await db.destroy();
  }
});
