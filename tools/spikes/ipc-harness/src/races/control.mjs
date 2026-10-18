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

function appClient(pooled) {
  const dsn = pooled ? process.env.HARNESS_POOLED_DSN : process.env.HARNESS_DIRECT_DSN;
  if (dsn) return new pg.Client({ connectionString: dsn });
  return new pg.Client({
    host: 'localhost',
    port: pooled ? 54321 : 54320,
    database: 'plerni',
    user: 'plerni_app',
    password: process.env.PLERNI_APP_PASSWORD,
  });
}

export function openAppClient(kind = 'direct') {
  if (kind !== 'direct' && kind !== 'reserved' && kind !== 'pooled') {
    throw new Error('unknown harness client kind');
  }
  return appClient(kind === 'pooled');
}

function destroy(client) {
  client?.connection?.stream?.destroy();
}

// Cancel active work, drop idle transactions so their locks release, and close
// every client this process opened. Callers await their own work promise after
// this so renewal intervals cleared in finally have actually stopped.
export async function abortInFlight() {
  aborted = true;
  const victims = [...live];
  const killer = appClient(false);
  try {
    await killer.connect();
    await killer.query(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND usename = current_user AND state = 'active'`,
    );
    await killer.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND usename = current_user
         AND state LIKE 'idle in transaction%'`,
    );
  } catch {
    // The socket destroy below still unblocks a client the signal missed.
  } finally {
    await killer.end().catch(() => {});
  }
  for (const client of victims) destroy(client);
  await Promise.all(victims.map((client) => client.end().catch(() => {})));
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
      try {
        await client.query('COMMIT');
      } catch {
        destroy(client);
      } finally {
        await client.end().catch(() => {});
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
    await client.end().catch(() => {});
  }
}

export async function vacuousSweep(id) {
  const client = openAppClient('direct');
  await client.connect();
  try {
    const updated = await client.query(VACUOUS_SWEEP_SQL, [LEASE_MS / 1000, id]);
    return updated.rows.map((row) => row.id);
  } finally {
    await client.end().catch(() => {});
  }
}
