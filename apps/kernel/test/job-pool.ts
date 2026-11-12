// SPDX-License-Identifier: Apache-2.0
// A second PgBouncer in transaction mode with prepared statements off.
// The harness pooler tracks named statements. This task must not.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const PORT = 54331;
const CONTAINER = 'plerni-pgbouncer-zero';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

function dsn(user: string, password: string, database: string): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${PORT}/${database}`;
}

function harnessNetwork(): string {
  return execFileSync(
    'docker',
    ['inspect', '-f', '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}', 'harness-postgres-1'],
    { encoding: 'utf8' },
  ).trim();
}

function harnessImage(): string {
  return execFileSync(
    'docker',
    ['inspect', '-f', '{{.Config.Image}}', 'harness-pgbouncer-1'],
    { encoding: 'utf8' },
  ).trim();
}

function writeIni(dir: string): void {
  const userlist = realpathSync(join(repo, 'tools/harness/pgbouncer/userlist.txt'));
  writeFileSync(
    join(dir, 'pgbouncer.ini'),
    [
      '[databases]',
      'plerni = host=postgres port=5432 dbname=plerni',
      '',
      '[pgbouncer]',
      'listen_addr = 0.0.0.0',
      'listen_port = 6432',
      'pool_mode = transaction',
      'max_prepared_statements = 0',
      'auth_type = scram-sha-256',
      'auth_file = /etc/pgbouncer/userlist.txt',
      'stats_users = plerni_admin_ro',
      'default_pool_size = 10',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'userlist.txt'), readFileSync(userlist));
  chmodSync(join(dir, 'pgbouncer.ini'), 0o644);
  chmodSync(join(dir, 'userlist.txt'), 0o644);
}

function startContainer(dir: string): void {
  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--network',
    harnessNetwork(),
    '-p',
    `127.0.0.1:${PORT}:6432`,
    '-v',
    `${dir}/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro`,
    '-v',
    `${dir}/userlist.txt:/etc/pgbouncer/userlist.txt:ro`,
    harnessImage(),
  ], { stdio: 'ignore' });
}

export interface PoolerConfig {
  pooled: string;
  poolMode: string;
  maxPreparedStatements: string;
  version: string;
}

async function readConfig(): Promise<PoolerConfig> {
  const client = new pg.Client({
    connectionString: dsn('plerni_admin_ro', required('PLERNI_ADMIN_PASSWORD'), 'pgbouncer'),
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const config = await client.query<{ key: string; value: string }>(
      'SHOW CONFIG',
    );
    const value = (key: string): string => {
      const row = config.rows.find((item) => item.key === key);
      if (!row) throw new Error(`pooler config missing ${key}`);
      return row.value;
    };
    const version = await client.query<{ version: string }>('SHOW VERSION');
    return {
      pooled: dsn('plerni_app', required('PLERNI_APP_PASSWORD'), 'plerni'),
      poolMode: value('pool_mode'),
      maxPreparedStatements: value('max_prepared_statements'),
      version: version.rows[0]?.version ?? '',
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function ensureJobPooler(): Promise<PoolerConfig> {
  const dir = join(tmpdir(), 'plerni-job-pooler');
  mkdirSync(dir, { recursive: true });
  writeIni(dir);
  startContainer(dir);
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const config = await readConfig();
      if (config.poolMode !== 'transaction' || config.maxPreparedStatements !== '0') {
        throw new Error('pooler is not transaction mode with prepared statements off');
      }
      return config;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('job pooler did not answer', { cause: last });
}
