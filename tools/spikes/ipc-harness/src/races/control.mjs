// Harness controls for the race battery. The production authority module
// (../authority.mjs, owned by T5a) is not given clock, barrier, or vacuity
// parameters. Scenarios call commitExecution, sweepAbandoned, and startSweeper.
// This file only supplies what those functions do not: a row-lock barrier,
// cancellation of in-flight clients, and the vacuity statements that drop
// status='ACTIVE'. Those statements are not the production protocol.
//
// Timeouts are client-side. A pooled connection never receives a session
// parameter: PgBouncer transaction mode would reuse it on the next client.

import pg from 'pg';
import { FencedError } from '../authority.mjs';

export const CADENCE_MS = 5000;
export const LEASE_MS = 20000;

// The exploit statements. Production updates keep status='ACTIVE' in the predicate.
export const VACUOUS_COMMIT_SQL = "UPDATE fencing_authority SET status = 'COMMITTED' WHERE id = $1 AND token = $2 RETURNING clock_timestamp() AS locked_at";
export const VACUOUS_SWEEP_SQL = "UPDATE fencing_authority SET status = 'ABANDONED' WHERE heartbeat_at < now() - make_interval(secs => $1) AND id = $2 RETURNING id";

const live = new Set();

// Every client the process opens, including the production authority's, is
// tracked and given an error listener. A cancelled backend then rejects the
// query instead of crashing the test process on an unhandled error event.
const NativeClient = pg.Client;
class TrackedClient extends NativeClient {
  constructor(config) {
    super(config);
    this.on('error', () => {});
    live.add(this);
  }

  end(cb) {
    live.delete(this);
    return super.end(cb);
  }
}
pg.Client = TrackedClient;

let aborted = false;

export function isAborted() {
  return aborted;
}

export function resetAbort() {
  aborted = false;
}

function directClient(extra = {}) {
  const dsn = process.env.HARNESS_DIRECT_DSN;
  if (dsn) return new pg.Client({ connectionString: dsn, ...extra });
  return new pg.Client({
    host: 'localhost',
    port: 54320,
    database: 'plerni',
    user: 'plerni_app',
    password: process.env.PLERNI_APP_PASSWORD,
    ...extra,
  });
}

function appClient(pooled, connectionTimeoutMillis = 0) {
  const timeout = connectionTimeoutMillis > 0 ? { connectionTimeoutMillis } : {};
  if (!pooled) return directClient(timeout);
  const dsn = process.env.HARNESS_POOLED_DSN;
  if (dsn) return new pg.Client({ connectionString: dsn, ...timeout });
  return new pg.Client({
    host: 'localhost',
    port: 54321,
    database: 'plerni',
    user: 'plerni_app',
    password: process.env.PLERNI_APP_PASSWORD,
    ...timeout,
  });
}

export function openAppClient(kind = 'direct', connectionTimeoutMillis = 0) {
  if (kind !== 'direct' && kind !== 'reserved' && kind !== 'pooled') {
    throw new Error('unknown harness client kind');
  }
  return appClient(kind === 'pooled', connectionTimeoutMillis);
}

function destroy(client) {
  try {
    client?.connection?.stream?.destroy();
  } catch {
    // The socket is already gone.
  }
}

// Direct connection only. statement_timeout is a startup parameter, not a
// session SET, so a pooled server cannot reuse it. The outer cap destroys
// the socket if connect or a statement ignores its own timeout.
const KILL_MS = 2000;
const KILL_CAP_MS = 3000;
export const CLEANUP_MS = 3000;

const CANCEL_SQL = `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
 WHERE pid <> pg_backend_pid() AND usename = current_user AND state = 'active'`;
const TERMINATE_SQL = `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE pid <> pg_backend_pid() AND usename = current_user
   AND state LIKE 'idle in transaction%'`;

function defaultKiller() {
  return directClient({
    connectionTimeoutMillis: KILL_MS,
    statement_timeout: KILL_MS,
    query_timeout: KILL_MS,
  });
}

let openKiller = defaultKiller;

export function setKillerOpener(fn) {
  openKiller = fn ?? defaultKiller;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function queryWithin(client, text, values, ms = KILL_MS) {
  const query = client.query(text, values);
  query.catch(() => {});
  let timer;
  const outcome = await Promise.race([
    query.then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error })),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        destroy(client);
        resolve({ kind: 'timeout' });
      }, ms);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.kind === 'value') return outcome.value;
  if (outcome.kind === 'error') throw outcome.error;
  await Promise.race([query.then(() => {}, () => {}), sleep(500)]);
  throw new Error('deadline exceeded');
}

export async function endClient(client, ms = KILL_MS) {
  if (!client) return;
  let timer;
  const ended = Promise.resolve().then(() => client.end()).catch(() => {});
  await Promise.race([
    ended,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        destroy(client);
        resolve();
      }, ms);
    }),
  ]);
  clearTimeout(timer);
  await Promise.race([ended, sleep(ms)]);
}

async function cancelBackends() {
  const killer = openKiller();
  const work = (async () => {
    await killer.connect();
    await killer.query(CANCEL_SQL);
    await killer.query(TERMINATE_SQL);
  })();
  work.catch(() => {});
  let timer;
  await Promise.race([
    work.then(() => 'done', () => 'done'),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        destroy(killer);
        resolve('timeout');
      }, KILL_CAP_MS);
    }),
  ]);
  clearTimeout(timer);
  await Promise.race([work.then(() => {}, () => {}), sleep(500)]);
  await endClient(killer);
}

let aborting = null;

// Destroy tracked sockets first so local waits unblock, then best-effort
// cancel of backends the destroy did not reach. Callers await this before
// the next race step. A second call waits for the one already running.
export async function abortInFlight() {
  if (aborting) return aborting;
  aborting = (async () => {
    aborted = true;
    const victims = [...live];
    for (const client of victims) destroy(client);
    await cancelBackends();
    await Promise.all(victims.map((client) => endClient(client)));
  })().finally(() => {
    aborting = null;
  });
  return aborting;
}

// Wait until `promise` settles. On the cap, cancel in-flight clients and
// wait once more. A promise that is still pending after that is a leftover
// handle, and the caller must not start the next race.
export async function settleWithin(promise, ms, label) {
  const tracked = Promise.resolve(promise);
  tracked.catch(() => {});
  const finished = tracked.then(() => 'done', () => 'done');
  let timer;
  const outcome = await Promise.race([
    finished,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === 'done') return;
  await abortInFlight();
  let again;
  const retry = await Promise.race([
    finished,
    new Promise((resolve) => {
      again = setTimeout(() => resolve('timeout'), ms);
    }),
  ]);
  clearTimeout(again);
  if (retry !== 'done') throw new Error(`cleanup leftover: ${label}`);
}

export async function settleAll(tasks) {
  const settled = await Promise.allSettled(
    tasks.map(([label, promise]) => settleWithin(promise, CLEANUP_MS, label)),
  );
  const missed = settled.find((item) => item.status === 'rejected');
  if (missed) throw missed.reason;
}

// Holds the fencing row so production updates queue behind it. Release commits
// and lets the lock queue proceed. Direct connection; no session GUC.
export async function holdRow(id) {
  const client = openAppClient('direct');
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM fencing_authority WHERE id = $1 FOR UPDATE', [id]);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let timer;
      const committed = client.query('COMMIT');
      committed.catch(() => {});
      try {
        await Promise.race([
          committed,
          new Promise((resolve) => {
            timer = setTimeout(() => {
              destroy(client);
              resolve();
            }, KILL_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await endClient(client);
      }
    },
  };
}

// Vacuity only. Omits status='ACTIVE', so a terminal row can be rewritten.
// Runs on the direct connection and does not set a session GUC.
export async function vacuousCommit(id, token, effectsFn) {
  const client = openAppClient('direct');
  await client.connect();
  try {
    await client.query('BEGIN');
    await effectsFn(client);
    const updated = await client.query(VACUOUS_COMMIT_SQL, [id, token]);
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      throw new FencedError(`vacuous COMMITTED failed: 0 rows (id=${id})`);
    }
    await client.query('COMMIT');
    return { committed: true };
  } catch (err) {
    if (!(err instanceof FencedError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await endClient(client);
  }
}

export async function vacuousSweep(id) {
  const client = openAppClient('direct');
  await client.connect();
  try {
    const updated = await client.query(VACUOUS_SWEEP_SQL, [LEASE_MS / 1000, id]);
    return updated.rows.map((row) => row.id);
  } finally {
    await endClient(client);
  }
}
