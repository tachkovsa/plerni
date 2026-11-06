// SPDX-License-Identifier: Apache-2.0
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './database.ts';

const pools = new WeakMap<Kysely<Database>, pg.Pool>();

interface PoolClient {
  connection?: { stream?: { destroyed?: boolean; destroy: () => void } };
}

function poolOf(db: Kysely<Database>): pg.Pool {
  const pool = pools.get(db);
  if (!pool) throw new Error('kernel database has no pool');
  return pool;
}

export function bindPool(pool: pg.Pool): Kysely<Database> {
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  pools.set(db, pool);
  return db;
}

export function openKernelDb(connectionString: string, max = 10): Kysely<Database> {
  const pool = new pg.Pool({ connectionString, max });
  // A killed backend emits an error on the idle client. The query rejection
  // still reaches the caller. This listener keeps that error from crashing
  // the process.
  pool.on('error', () => undefined);
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  return bindPool(pool);
}

/** Close every client socket on this pool. Each socket is one pooler session. */
export function discardPoolerSessions(db: Kysely<Database>): number {
  const clients = (poolOf(db) as unknown as { _clients?: PoolClient[] })._clients ?? [];
  let closed = 0;
  for (const client of clients) {
    const stream = client.connection?.stream;
    if (!stream || stream.destroyed) continue;
    stream.destroy();
    closed += 1;
  }
  return closed;
}

export function unblockPool(db: Kysely<Database>): void {
  discardPoolerSessions(db);
}

/** A connection-scoped Kysely shares the pool so hygiene can discard its sockets. */
export function sharePool(target: Kysely<Database>, source: Kysely<Database>): void {
  pools.set(target, poolOf(source));
}
