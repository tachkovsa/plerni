// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { installNamedStatements, namedQueryConfig, statementName, type QueryConfig } from './named-statements.ts';

function prepares(config: QueryConfig): boolean {
  const query = new pg.Query(config) as unknown as { requiresPreparation(): boolean };
  return query.requiresPreparation();
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

test('statement name is a stable hash of the SQL text', () => {
  assert.equal(statementName('SELECT 1'), `n${sha('SELECT 1')}`);
  assert.equal(statementName('SELECT 1'), statementName('SELECT 1'));
  assert.notEqual(statementName('SELECT 1'), statementName('SELECT 2'));
  assert.match(statementName('SELECT $1::int'), /^n[0-9a-f]{16}$/);
});

test('workload statements are named prepared statements, including parameterless ones', () => {
  const pid = namedQueryConfig({ text: 'SELECT pg_backend_pid() AS pid' });
  assert.equal(pid.name, statementName('SELECT pg_backend_pid() AS pid'));
  assert.deepEqual(pid.values, []);
  assert.equal(prepares(pid), true);

  const param = namedQueryConfig({ text: 'SELECT $1::int AS n', values: [4] });
  assert.equal(param.name, statementName('SELECT $1::int AS n'));
  assert.deepEqual(param.values, [4]);
  assert.equal(prepares(param), true);
});

test('transaction and session commands stay simple queries', () => {
  for (const text of [
    'BEGIN',
    '  commit',
    'ROLLBACK',
    'START TRANSACTION',
    'SAVEPOINT s',
    'RELEASE SAVEPOINT s',
    'SET search_path TO public',
    'RESET ROLE',
    'DISCARD ALL',
    'DEALLOCATE ALL',
    'SHOW CONFIG',
  ]) {
    const config = namedQueryConfig({ text });
    assert.equal(config.name, undefined, text);
    assert.equal(config.values, undefined, text);
    assert.equal(prepares(config), false, text);
  }
});

test('an explicit statement name is left unchanged', () => {
  const config = namedQueryConfig({ text: 'SELECT $1', values: [1], name: 'keep' });
  assert.equal(config.name, 'keep');
  assert.equal(config.text, 'SELECT $1');
});

test('namedQueryConfig does not mutate its input', () => {
  const input: QueryConfig = { text: 'SELECT 1' };
  const named = namedQueryConfig(input);
  assert.equal(input.name, undefined);
  assert.notEqual(named, input);
});

test('Kysely call shape stays simple for begin and named for parameterless SQL', () => {
  // kysely 0.29.6 PostgresConnection.executeQuery calls client.query(sql, parameters).
  // begin/commit/rollback are CompiledQuery.raw, so the values array is empty.
  const orig = pg.Client.prototype.query;
  const calls: unknown[][] = [];
  pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    return undefined;
  } as typeof pg.Client.prototype.query;
  try {
    const restore = installNamedStatements();
    const client = Object.create(pg.Client.prototype) as pg.Client;
    try {
      client.query('begin', []);
      client.query('commit', []);
      client.query('rollback', []);
      client.query('select pg_backend_pid() as pid', []);
    } finally {
      restore();
    }
  } finally {
    pg.Client.prototype.query = orig;
  }
  assert.deepEqual(calls[0], ['begin', []]);
  assert.deepEqual(calls[1], ['commit', []]);
  assert.deepEqual(calls[2], ['rollback', []]);
  const pid = calls[3]?.[0] as { name?: string; values?: unknown[]; text?: string };
  assert.equal(pid.text, 'select pg_backend_pid() as pid');
  assert.equal(pid.name, statementName('select pg_backend_pid() as pid'));
  assert.deepEqual(pid.values, []);
  assert.equal(calls[3]?.length, 1);
});

test('installNamedStatements rewrites client queries and then restores them', () => {
  const orig = pg.Client.prototype.query;
  const calls: unknown[][] = [];
  pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
    calls.push(args);
    return undefined;
  } as typeof pg.Client.prototype.query;
  const cb = () => undefined;
  const prepared = new pg.Query('SELECT 9');
  try {
    const restore = installNamedStatements();
    const client = Object.create(pg.Client.prototype) as pg.Client;
    try {
      client.query('SELECT $1::int', [7]);
      client.query('BEGIN');
      client.query('SELECT 1', cb);
      client.query({ text: 'SELECT $1', values: [1], name: 'keep' });
      client.query(prepared);
    } finally {
      restore();
    }
    client.query('SELECT 3');
  } finally {
    pg.Client.prototype.query = orig;
  }

  const named = calls[0]?.[0] as { text?: string; name?: string; values?: unknown[] };
  assert.equal(named.text, 'SELECT $1::int');
  assert.equal(named.name, statementName('SELECT $1::int'));
  assert.deepEqual(named.values, [7]);
  assert.equal(calls[0]?.length, 1);

  assert.deepEqual(calls[1], ['BEGIN']);

  const parameterless = calls[2]?.[0] as { name?: string; values?: unknown[] };
  assert.equal(parameterless.name, statementName('SELECT 1'));
  assert.deepEqual(parameterless.values, []);
  assert.equal(calls[2]?.[1], cb);

  const kept = calls[3]?.[0] as { name?: string };
  assert.equal(kept.name, 'keep');

  assert.equal(calls[4]?.[0], prepared);
  assert.deepEqual(calls[5], ['SELECT 3']);
});
