// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_BAND,
  BANDS,
  CEILING_RSS_KIB,
  CEILING_WALL_MS,
  PAYLOAD_P99_BYTES,
  allocation,
  artifactDir,
  bandModel,
  renderSchema,
} from './band.mjs';

test('allocation matches the integer rule at every band', () => {
  assert.deepEqual(allocation(50), { s: 150, m: 75, l: 25, total: 250 });
  assert.deepEqual(allocation(75), { s: 225, m: 112, l: 38, total: 375 });
  assert.deepEqual(allocation(200), { s: 600, m: 300, l: 100, total: 1000 });
  assert.deepEqual(allocation(400), { s: 1200, m: 600, l: 200, total: 2000 });
  assert.equal(ACCEPTANCE_BAND, 75);
  assert.equal(CEILING_WALL_MS, 120_000);
  assert.equal(CEILING_RSS_KIB, 4_000_000_000 / 1024);
  assert.equal(PAYLOAD_P99_BYTES, 32 * 1024);
});

test('shape floors reject a band that would dilute M or L', () => {
  assert.throws(() => allocation(10), /floors/);
});

test('schema N includes plugin_lrs_statement and excludes harness fixtures', () => {
  for (const n of BANDS) {
    const sql = renderSchema(n);
    const tables = [...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map((match) => match[1]);
    assert.equal(tables.length, n, `band ${n} table count`);
    assert.equal(tables.filter((name) => name === 'plugin_lrs_statement').length, 1);
    assert.equal(new Set(tables).size, n);
    assert.equal(sql.includes('CREATE TABLE plerni_tenant'), false);
    assert.equal(sql.includes('CREATE TABLE fencing_authority'), false);
    assert.match(sql, /plugin_lrs_statement_append_only/);
    assert.match(sql, /REVOKE UPDATE, DELETE ON plugin_lrs_statement FROM PUBLIC/);
    assert.equal(sql.includes('CHECK (octet_length'), false);
    assert.match(sql, /Annex L: JSON, 0\.5-4 KiB typical, p99 <= 32 KiB/);
    const model = bandModel(n);
    assert.equal(model.tables.length, n);
    assert.ok(model.chains.length >= 1);
    assert.equal(model.chains.every((chain) => chain.length === 4), true);
  }
});

test('committed artifacts match the generator at every band', () => {
  for (const n of BANDS) {
    const dir = artifactDir(n);
    const sql = readFileSync(join(dir, 'schema.sql'), 'utf8');
    const types = readFileSync(join(dir, 'database-types.ts'), 'utf8');
    assert.equal(sql, renderSchema(n));
    const body = types.match(/export interface DB \{([\s\S]*?)\n\}/);
    assert.ok(body, `band ${n} DB interface`);
    const keys = [...body[1].matchAll(/^\s+([a-z0-9_]+):/gm)].map((match) => match[1]);
    assert.equal(keys.length, n, `band ${n} generated table count`);
    assert.ok(keys.includes('plugin_lrs_statement'));
    assert.equal(keys.includes('plerni_tenant'), false);
    assert.match(types, /seq: Int8;/);
    assert.match(types, /payload: Json;/);
    assert.match(types, /Annex L: JSON, 0\.5-4 KiB typical, p99 <= 32 KiB/);
  }
});

test('bench tsconfig keeps the frozen compiler flags', () => {
  const flags = JSON.parse(readFileSync(new URL('./tsconfig.bench.json', import.meta.url), 'utf8'));
  assert.deepEqual(flags.compilerOptions, {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    useUnknownInCatchVariables: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    types: [],
  });
});
