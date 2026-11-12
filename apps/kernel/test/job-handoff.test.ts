// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'kysely';
import pg from 'pg';
import type { Db, PgBoss } from 'pg-boss';
import { appendEvent } from '../src/bus/append.ts';
import {
  HEARTBEAT_APPLICATION,
  JOB_QUEUE,
  POOLED_APPLICATION,
  SERVICE_IDENTITY,
} from '../src/bus/job-constants.ts';
import { installJobStore, openJobBoss } from '../src/bus/job-boss.ts';
import { appendJob, handoffPending } from '../src/bus/job-handoff.ts';
import type { JobRequest } from '../src/bus/job-envelope.ts';
import {
  StaleJobFence,
  assertReservedHeartbeat,
  attemptToken,
  openHeartbeatClient,
  renewJobHeartbeat,
  settleJob,
  sweepJobs,
} from '../src/bus/job-run.ts';
import { retainLog } from '../src/bus/retain.ts';
import { registerSubscription } from '../src/bus/subscription.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { insertCustomer, resetBus, withRoot } from './bus-support.ts';
import { ensureJobPooler, type PoolerConfig } from './job-pool.ts';
import { DIRECT, MIGRATE, appDb, ready, terminate } from './support.ts';

const SESSION_SET = /(?:^|;)\s*SET\s+(?!LOCAL\b|CONSTRAINTS\b|TRANSACTION\b)/i;
const SESSION_LOCK = /\bpg_(?:try_)?advisory_lock(?:_shared)?\s*\(/i;
const LISTEN = /(?:^|;)\s*(?:LISTEN|UNLISTEN)\b/i;
const SESSION_CONFIG = /set_config\s*\([\s\S]*?,\s*false\s*\)/i;

function violations(statements: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of statements) {
    if (LISTEN.test(text)) found.push('LISTEN');
    if (SESSION_SET.test(text)) found.push('session SET');
    if (SESSION_LOCK.test(text)) found.push('session advisory lock');
    if (SESSION_CONFIG.test(text)) found.push('session set_config');
  }
  return found;
}

function recordingDb(pool: pg.Pool, log: string[]): Db {
  return {
    async executeSql(text, values) {
      log.push(text);
      const result = await pool.query(text, values as never[]);
      return { rows: result.rows };
    },
  };
}

function request(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    plugin: 'kernel',
    handler: 'relay.dispatch',
    payloadVersion: 1,
    idempotencyKey: `job-${randomUUID()}`,
    deadline: '2026-11-12T00:00:00Z',
    attemptBudget: 1,
    trace: `trace-${randomUUID()}`,
    serviceIdentity: SERVICE_IDENTITY,
    payload: { marker: 'job' },
    ...overrides,
  };
}

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let pooler: Promise<PoolerConfig> | undefined;
function jobPooler(): Promise<PoolerConfig> {
  pooler ??= ensureJobPooler();
  return pooler;
}

let store: Promise<void> | undefined;
function jobStore(): Promise<void> {
  store ??= installJobStore(MIGRATE);
  return store;
}

async function clearJobs(db: ReturnType<typeof appDb>): Promise<void> {
  await sql`DELETE FROM pgboss.job WHERE name = ${JOB_QUEUE}`.execute(db);
}

async function jobState(id: string): Promise<{
  state: string;
  retryCount: string;
  leaseExpired: boolean;
  heartbeatMissed: boolean;
}> {
  return withRoot(async (client) => {
    const result = await client.query<{
      state: string;
      retry_count: string;
      lease_expired: boolean;
      heartbeat_missed: boolean;
    }>(
      `SELECT state::text AS state,
              retry_count::text AS retry_count,
              (started_on + expire_seconds * interval '1 second') < pgboss.job_now() AS lease_expired,
              (heartbeat_on + heartbeat_seconds * interval '1 second') < pgboss.job_now() AS heartbeat_missed
       FROM pgboss.job
       WHERE id = $1::uuid`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('job row missing');
    return {
      state: row.state,
      retryCount: row.retry_count,
      leaseExpired: row.lease_expired,
      heartbeatMissed: row.heartbeat_missed,
    };
  });
}

test('pg-boss claims through the transaction pooler without session state', async () => {
  await ready();
  const config = await jobPooler();
  await jobStore();
  assert.equal(config.poolMode, 'transaction');
  assert.equal(config.maxPreparedStatements, '0');
  console.log(JSON.stringify({
    pool_mode: config.poolMode,
    max_prepared_statements: config.maxPreparedStatements,
    version: config.version,
  }));
  const log: string[] = [];
  const pool = new pg.Pool({
    connectionString: config.pooled,
    max: 4,
    application_name: POOLED_APPLICATION,
  });
  pool.on('error', () => undefined);
  const boss = openJobBoss(config.pooled, recordingDb(pool, log));
  try {
    await boss.start();
    await boss.createQueue(JOB_QUEUE);
    await withRoot(async (client) => {
      await client.query('DELETE FROM pgboss.job WHERE name = $1', [JOB_QUEUE]);
    });
    const id = await boss.send(JOB_QUEUE, { marker: 'pooler' }, {
      expireInSeconds: 60,
      heartbeatSeconds: 20,
      retryLimit: 1,
    });
    assert.ok(id);
    const fetched = await boss.fetch(JOB_QUEUE);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]?.id, id);
    const completed = await boss.complete(JOB_QUEUE, [{ id, retryCount: fetched[0]?.retryCount ?? 0 }], null);
    assert.equal(completed.affected, 1);
    const text = log.join('\n');
    assert.equal(violations(log).length, 0, violations(log).join(','));
    assert.match(text, /SKIP LOCKED/);
    assert.match(text, /pg_advisory_xact_lock/);
    assert.equal(SESSION_LOCK.test(text), false);
    await boss.stop();
    const locks = await withRoot(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks AS lock
         JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
         WHERE lock.locktype = 'advisory'
           AND activity.application_name = $1
           AND activity.state = 'idle'`,
        [POOLED_APPLICATION],
      );
      const listeners = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_stat_activity
         WHERE application_name = $1
           AND query ILIKE 'LISTEN%'`,
        [POOLED_APPLICATION],
      );
      return {
        advisory: result.rows[0]?.count,
        listeners: listeners.rows[0]?.count,
      };
    });
    assert.equal(locks.advisory, '0');
    assert.equal(locks.listeners, '0');
  } finally {
    await boss.stop().catch(() => undefined);
    await pool.end();
  }
});

test('a rolled-back handoff leaves the row pending and inserts no job', async () => {
  await ready();
  await jobStore();
  await resetBus();
  const config = await jobPooler();
  const db = appDb(config.pooled);
  await clearJobs(db);
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const boss = openJobBoss(config.pooled);
  try {
    const pending = await appendJob(db, tenantId, request(), blankEvidence(), terminate);
    await boss.start();
    const send = boss.send.bind(boss);
    boss.send = (async (...args: Parameters<PgBoss['send']>) => {
      await send(...args);
      throw new Error('abort after insert');
    }) as unknown as typeof boss.send;
    await assert.rejects(() => handoffPending(db, boss), /abort after insert/);
    boss.send = send;
    const row = await sql<{ status: string; job_id: string | null }>`
      SELECT status, job_id::text AS job_id
      FROM kernel.job_dispatch
      WHERE seq = ${pending.seq}::bigint`.execute(db);
    assert.equal(row.rows[0]?.status, 'pending');
    assert.equal(row.rows[0]?.job_id, null);
    const aborted = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pgboss.job WHERE name = ${JOB_QUEUE}`.execute(db);
    assert.equal(aborted.rows[0]?.count, '0');
    const handed = await handoffPending(db, boss);
    assert.equal(handed?.seq, pending.seq);
    const jobs = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pgboss.job WHERE name = ${JOB_QUEUE}`.execute(db);
    assert.equal(jobs.rows[0]?.count, '1');
    const marked = await sql<{ status: string; job_id: string }>`
      SELECT status, job_id::text AS job_id
      FROM kernel.job_dispatch
      WHERE seq = ${pending.seq}::bigint`.execute(db);
    assert.equal(marked.rows[0]?.status, 'dispatched');
    assert.equal(marked.rows[0]?.job_id, handed?.jobId);
  } finally {
    await boss.stop().catch(() => undefined);
    await db.destroy();
  }
});

test('handoff commits the job and the dispatch mark together', async () => {
  await ready();
  await jobStore();
  await resetBus();
  const config = await jobPooler();
  const db = appDb(config.pooled);
  await clearJobs(db);
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const boss = openJobBoss(config.pooled);
  try {
    await boss.start();
    const pending = await appendJob(db, tenantId, request(), blankEvidence(), terminate);
    const handed = await handoffPending(db, boss);
    assert.equal(handed?.seq, pending.seq);
    const row = await sql<{ status: string; job_id: string }>`
      SELECT status, job_id::text AS job_id
      FROM kernel.job_dispatch
      WHERE seq = ${pending.seq}::bigint`.execute(db);
    assert.equal(row.rows[0]?.status, 'dispatched');
    assert.equal(row.rows[0]?.job_id, handed?.jobId);
    const jobs = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pgboss.job WHERE id = ${handed?.jobId}::uuid`.execute(db);
    assert.equal(jobs.rows[0]?.count, '1');
    const second = await handoffPending(db, boss);
    assert.equal(second, null);
  } finally {
    await boss.stop().catch(() => undefined);
    await db.destroy();
  }
});

test('retention keeps a pending handoff and drops a dispatched log row', async () => {
  await ready();
  await jobStore();
  await resetBus();
  const config = await jobPooler();
  const db = appDb(config.pooled);
  await clearJobs(db);
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const boss = openJobBoss(config.pooled);
  try {
    await boss.start();
    const first = await appendJob(db, tenantId, request(), blankEvidence(), terminate);
    const handed = await handoffPending(db, boss);
    assert.equal(handed?.seq, first.seq);
    const second = await appendJob(db, tenantId, request(), blankEvidence(), terminate);
    const cursor = await appendEvent(
      db,
      tenantId,
      {
        aggregateType: 'kernel.bus',
        type: 'kernel.bus.signaled',
        version: 1,
        payload: { marker: 'cursor' },
      },
      blankEvidence(),
      terminate,
    );
    await registerSubscription(db, {
      id: randomUUID(),
      filter: [{ type: 'kernel.job.requested', versions: [1] }],
      start: 'head',
    });
    const deleted = await retainLog(db);
    assert.equal(deleted, 1);
    const seqs = await sql<{ seq: string }>`
      SELECT seq::text AS seq FROM kernel.outbox ORDER BY seq`.execute(db);
    assert.deepEqual(seqs.rows.map((row) => row.seq), [second.seq, cursor.seq]);
    const pending = await sql<{ status: string }>`
      SELECT status FROM kernel.job_dispatch WHERE seq = ${second.seq}::bigint`.execute(db);
    assert.equal(pending.rows[0]?.status, 'pending');
    const gone = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM kernel.job_dispatch WHERE seq = ${first.seq}::bigint`.execute(db);
    assert.equal(gone.rows[0]?.count, '0');
  } finally {
    await boss.stop().catch(() => undefined);
    await db.destroy();
  }
});

test('a live heartbeat blocks reclaim and a stale fence updates zero rows', async () => {
  await ready();
  await jobStore();
  await resetBus();
  const config = await jobPooler();
  const db = appDb(config.pooled);
  await clearJobs(db);
  const tenantId = randomUUID();
  await insertCustomer(tenantId);
  const boss = openJobBoss(config.pooled);
  const heart = await openHeartbeatClient(DIRECT, config.pooled);
  await withRoot(async (client) => {
    await client.query('DROP TABLE IF EXISTS job_effect_probe');
    await client.query(
      `CREATE TABLE job_effect_probe (
         attempt_token text PRIMARY KEY,
         marker text NOT NULL
       )`,
    );
    await client.query('GRANT SELECT, INSERT ON job_effect_probe TO plerni_app');
  });
  const running = { on: true };
  let beater: Promise<void> = Promise.resolve();
  try {
    await boss.start();
    await appendJob(
      db,
      tenantId,
      request({ expireInSeconds: 2, heartbeatSeconds: 10, attemptBudget: 1 }),
      blankEvidence(),
      terminate,
    );
    const handed = await handoffPending(db, boss);
    assert.ok(handed);
    const fetched = await boss.fetch(JOB_QUEUE);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]?.id, handed.jobId);
    assert.equal(fetched[0]?.retryCount, 0);
    assert.equal(fetched[0]?.expireInSeconds, 2);
    assert.equal(fetched[0]?.heartbeatSeconds, 10);
    const attempt = { id: handed.jobId, retryCount: fetched[0]?.retryCount ?? 0 };
    let backend = 0;
    let release = (): void => undefined;
    const swept = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = settleJob(
      db,
      boss,
      tenantId,
      attempt,
      blankEvidence(),
      terminate,
      async (trx) => {
        const pid = await sql<{ pid: string }>`SELECT pg_backend_pid()::text AS pid`.execute(trx);
        backend = Number(pid.rows[0]?.pid);
        await swept;
        await sql`
          INSERT INTO job_effect_probe (attempt_token, marker)
          VALUES (${attemptToken(attempt.id, attempt.retryCount)}, 'a')`.execute(trx);
      },
    );
    await waitFor('effects transaction', async () => backend > 0);
    const open = await withRoot(async (client) => {
      const result = await client.query<{ state: string }>(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        [backend],
      );
      return result.rows[0]?.state ?? '';
    });
    assert.equal(open, 'idle in transaction');
    beater = (async () => {
      while (running.on) {
        const renewed = await renewJobHeartbeat(heart, attempt.id, attempt.retryCount);
        if (!renewed) throw new Error('heartbeat updated zero rows');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    })();
    await waitFor('lease with a live heartbeat', async () => {
      const row = await jobState(attempt.id);
      return row.state === 'active' && row.leaseExpired && !row.heartbeatMissed;
    });
    assert.deepEqual(await sweepJobs(db), []);
    assert.equal((await jobState(attempt.id)).state, 'active');
    running.on = false;
    await beater;
    await waitFor('missed heartbeat inside the open transaction', async () => {
      const row = await jobState(attempt.id);
      const activity = await withRoot(async (client) => {
        const result = await client.query<{ state: string }>(
          'SELECT state FROM pg_stat_activity WHERE pid = $1',
          [backend],
        );
        return result.rows[0]?.state ?? '';
      });
      return row.leaseExpired && row.heartbeatMissed && activity === 'idle in transaction';
    });
    const redispatched = await sweepJobs(db);
    assert.deepEqual(redispatched, [{ id: attempt.id, state: 'retry' }]);
    const again = await boss.fetch(JOB_QUEUE);
    assert.equal(again.length, 1);
    assert.equal(again[0]?.id, attempt.id);
    assert.equal(again[0]?.retryCount, 1);
    const workerB = { id: attempt.id, retryCount: again[0]?.retryCount ?? 0 };
    const claimed = await jobState(attempt.id);
    assert.equal(claimed.state, 'active');
    assert.equal(claimed.retryCount, '1');
    const stillOpen = await withRoot(async (client) => {
      const result = await client.query<{ state: string }>(
        'SELECT state FROM pg_stat_activity WHERE pid = $1',
        [backend],
      );
      return result.rows[0]?.state ?? '';
    });
    assert.equal(stillOpen, 'idle in transaction');
    release();
    await assert.rejects(held, (error: unknown) => error instanceof StaleJobFence);
    const afterStale = await jobState(attempt.id);
    assert.equal(afterStale.state, 'active');
    assert.equal(afterStale.retryCount, '1');
    const rolledBack = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM job_effect_probe`.execute(db);
    assert.equal(rolledBack.rows[0]?.count, '0');
    await settleJob(
      db,
      boss,
      tenantId,
      workerB,
      blankEvidence(),
      terminate,
      async (trx) => {
        await sql`
          INSERT INTO job_effect_probe (attempt_token, marker)
          VALUES (${attemptToken(workerB.id, workerB.retryCount)}, 'b')`.execute(trx);
      },
    );
    const effects = await sql<{ attempt_token: string; marker: string }>`
      SELECT attempt_token, marker FROM job_effect_probe ORDER BY marker`.execute(db);
    assert.deepEqual(effects.rows, [{
      attempt_token: attemptToken(workerB.id, workerB.retryCount),
      marker: 'b',
    }]);
    const finished = await jobState(attempt.id);
    assert.equal(finished.state, 'completed');
    assert.equal(finished.retryCount, '1');
  } finally {
    running.on = false;
    await beater.catch(() => undefined);
    await heart.end().catch(() => undefined);
    await boss.stop().catch(() => undefined);
    await db.destroy();
    await withRoot(async (client) => {
      await client.query('DROP TABLE IF EXISTS job_effect_probe');
    });
  }
});

test('heartbeat renewal refuses the pooled application name', async () => {
  const config = await jobPooler();
  const client = new pg.Client({
    connectionString: config.pooled,
    application_name: POOLED_APPLICATION,
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await assert.rejects(
      () => renewJobHeartbeat(client, '00000000-0000-4000-8000-0000000000a1', 0),
      /pooled connection/,
    );
    assert.throws(
      () => assertReservedHeartbeat(config.pooled, config.pooled),
      /pooled connection/,
    );
  } finally {
    await client.end();
  }
  const heart = await openHeartbeatClient(DIRECT, config.pooled);
  try {
    const name = await heart.query<{ name: string }>(
      `SELECT current_setting('application_name') AS name`,
    );
    assert.equal(name.rows[0]?.name, HEARTBEAT_APPLICATION);
  } finally {
    await heart.end();
  }
});
