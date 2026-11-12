// SPDX-License-Identifier: Apache-2.0
// pg-boss 12.38.2, pinned for the pooler (ADR-0009 decision 5).
// useListenNotify stays false: the library's listener is a dedicated session
// and does not survive transaction pooling. supervise stays false: its timeout
// pass reclaims an active job from started_on and expire_seconds alone.
// Schedule stays off. Schema install uses the migrate role on a direct
// connection. Claim, send, and complete use the pooled boss.
import pg from 'pg';
import { PgBoss, type ConstructorOptions, type Db } from 'pg-boss';
import {
  JOB_EXPIRE_SECONDS,
  JOB_HEARTBEAT_SECONDS,
  JOB_QUEUE,
  JOB_SCHEMA,
  POOLED_APPLICATION,
} from './job-constants.ts';

const QUEUE = {
  policy: 'standard' as const,
  notify: false,
  partition: false,
  retryLimit: 2,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: JOB_EXPIRE_SECONDS,
  heartbeatSeconds: JOB_HEARTBEAT_SECONDS,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 86_400,
};

export function jobBossOptions(connectionString: string): ConstructorOptions {
  return {
    connectionString,
    schema: JOB_SCHEMA,
    application_name: POOLED_APPLICATION,
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
    useListenNotify: false,
    registerInstance: false,
    max: 4,
  };
}

export function openJobBoss(connectionString: string, db?: Db): PgBoss {
  const options = jobBossOptions(connectionString);
  if (db) options.db = db;
  const boss = new PgBoss(options);
  // An idle client error must not crash the process. The caller's await still rejects.
  boss.on('error', () => undefined);
  return boss;
}

export async function installJobStore(migrateConnectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: migrateConnectionString,
    schema: JOB_SCHEMA,
    application_name: 'plerni_job_migrate',
    supervise: false,
    schedule: false,
    migrate: true,
    createSchema: true,
    useListenNotify: false,
    registerInstance: false,
    max: 1,
  });
  boss.on('error', () => undefined);
  const client = new pg.Client({ connectionString: migrateConnectionString });
  client.on('error', () => undefined);
  await client.connect();
  try {
    if (JOB_SCHEMA !== 'pgboss') throw new Error('job schema rejected');
    await boss.start();
    await boss.createQueue(JOB_QUEUE, QUEUE);
    await client.query('GRANT USAGE ON SCHEMA pgboss TO plerni_app');
    await client.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO plerni_app',
    );
    await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO plerni_app');
    await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO plerni_app');
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plerni_app',
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO plerni_app',
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO plerni_app',
    );
  } finally {
    await boss.stop().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
