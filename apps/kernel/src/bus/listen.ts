// SPDX-License-Identifier: Apache-2.0
// LISTEN on a dedicated direct connection (plan §4.2, ADR-0003). The pooled
// port is refused. The payload is ignored; the log is the record.
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { LISTEN_APPLICATION, OUTBOX_CHANNEL } from './constants.ts';
import { assertIdentifier } from './validate.ts';

export function assertDirectListen(connectionString: string, pooledConnectionString: string): void {
  let listen: URL;
  let pooled: URL;
  try {
    listen = new URL(connectionString);
    pooled = new URL(pooledConnectionString);
  } catch {
    throw new Error('listen connection rejected');
  }
  if (listen.port !== '' && listen.port === pooled.port) {
    throw new Error('LISTEN is not allowed on the pooled connection');
  }
}

export async function countRelayListeners(db: Kysely<Database>): Promise<number> {
  const pattern = `LISTEN ${OUTBOX_CHANNEL}%`;
  const result = await sql<{ listeners: string }>`
    SELECT count(*)::text AS listeners
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND usename = current_user
      AND application_name = ${LISTEN_APPLICATION}
      AND query LIKE ${pattern}`.execute(db);
  return Number(result.rows[0]?.listeners ?? '0');
}

export async function listenForOutbox(
  directConnectionString: string,
  pooledConnectionString: string,
  onWake: (payload: string) => void,
): Promise<{ close: () => Promise<void> }> {
  assertDirectListen(directConnectionString, pooledConnectionString);
  assertIdentifier(OUTBOX_CHANNEL, 'notify channel');
  const client = new pg.Client({
    connectionString: directConnectionString,
    application_name: LISTEN_APPLICATION,
  });
  client.on('error', () => undefined);
  client.on('notification', (message) => {
    if (message.channel !== OUTBOX_CHANNEL) return;
    onWake(message.payload ?? '');
  });
  await client.connect();
  await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
  return {
    close: async () => {
      await client.query(`UNLISTEN ${OUTBOX_CHANNEL}`).catch(() => undefined);
      await client.end();
    },
  };
}
