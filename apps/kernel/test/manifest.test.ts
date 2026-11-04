// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginPackageError } from '../src/plugin/errors.ts';
import { parseManifest, readManifest, registeredEdgeTypes } from '../src/plugin/manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '../../../plugins/fixture_alpha');

test('the fixture manifest registers no edge types', () => {
  const manifest = readManifest(packageDir);
  assert.equal(manifest.id, 'fixture_alpha');
  assert.deepEqual(manifest.grants, ['db.own_schema']);
  assert.deepEqual(registeredEdgeTypes(manifest), []);
  const raw = readFileSync(join(packageDir, 'manifest.json'), 'utf8');
  assert.equal(raw.includes('directory.write_edge:'), false);
  assert.equal(raw.includes('directory.register_edge_type'), false);
});

test('edge type names are the directory.write_edge suffixes', () => {
  const base = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const manifest = parseManifest({
    ...base,
    migrations: [],
    grants: ['directory.read', 'directory.register_edge_type', 'directory.write_edge:reports_to'],
  });
  assert.deepEqual(registeredEdgeTypes(manifest), ['reports_to']);
});

test('an unknown manifest field and an unknown grant fail', () => {
  const base = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.throws(
    () => parseManifest({ ...base, edgeTypes: ['reports_to'] }),
    (error: unknown) => error instanceof PluginPackageError && error.message.includes('unknown field'),
  );
  assert.throws(
    () => parseManifest({ ...base, grants: ['ai.complete'] }),
    (error: unknown) => error instanceof PluginPackageError && error.message.includes('vocabulary'),
  );
});
