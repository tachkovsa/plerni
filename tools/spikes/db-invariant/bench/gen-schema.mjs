// SPDX-License-Identifier: Apache-2.0
// gen-schema.mjs N — emit band SQL, apply it to spike_bench_<N>, run kysely-codegen.
// Flags are pinned to kysely-codegen 0.20.0 (plan §3.1 method notes).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { artifactDir, assertBand, benchDatabase, renderSchema, spikeRoot } from './band.mjs';

export function connectionConfig() {
  const host = process.env.BENCH_PG_HOST ?? '127.0.0.1';
  const port = Number(process.env.BENCH_PG_PORT ?? '54320');
  const user = process.env.BENCH_PG_USER ?? 'postgres';
  const password = process.env.BENCH_PG_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? '';
  if (!password) throw new Error('BENCH_PG_PASSWORD or POSTGRES_PASSWORD is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BENCH_PG_PORT is not a port');
  return { host, port, user, password };
}

function redact(text, password) {
  return String(text).split(password).join('[redacted]');
}

function databaseUrl(config, database) {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  return `postgres://${user}:${password}@${config.host}:${config.port}/${database}`;
}

async function applySchema(n, sql) {
  const config = connectionConfig();
  const database = benchDatabase(n);
  const admin = new pg.Client({ ...config, database: 'postgres', connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    // database is spike_bench_<N> for an allowlisted band, not caller text.
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const band = new pg.Client({ ...config, database, connectionTimeoutMillis: 10_000 });
  await band.connect();
  try {
    await band.query(sql);
  } finally {
    await band.end();
  }
}

function runCodegen(n, config) {
  const database = benchDatabase(n);
  const outFile = join(artifactDir(n), 'database-types.ts');
  const bin = join(spikeRoot, 'node_modules', '.bin', 'kysely-codegen');
  const args = [
    '--dialect', 'postgres',
    '--date-parser', 'timestamp',
    '--numeric-parser', 'string',
    '--default-schema', 'public',
    '--log-level', 'silent',
    '--out-file', outFile,
    '--type-only-imports',
  ];
  try {
    execFileSync(bin, args, {
      env: { ...process.env, DATABASE_URL: databaseUrl(config, database) },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: spikeRoot,
    });
  } catch (err) {
    const detail = redact(`${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`, config.password);
    throw new Error(`kysely-codegen failed for band ${n}\n${detail}`);
  }
  return outFile;
}

export async function generateSchema(n, { sqlOnly = false } = {}) {
  assertBand(n);
  const sql = renderSchema(n);
  const dir = artifactDir(n);
  mkdirSync(dir, { recursive: true });
  const schemaPath = join(dir, 'schema.sql');
  writeFileSync(schemaPath, sql);
  if (sqlOnly) return { schemaPath, typesPath: null };
  const config = connectionConfig();
  await applySchema(n, sql);
  const typesPath = runCodegen(n, config);
  return { schemaPath, typesPath };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  const n = Number(process.argv[2]);
  const sqlOnly = process.argv.includes('--sql-only');
  generateSchema(n, { sqlOnly })
    .then(({ schemaPath, typesPath }) => {
      console.log(`gen-schema: band ${n} schema ${schemaPath}`);
      if (typesPath) console.log(`gen-schema: band ${n} types ${typesPath}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
