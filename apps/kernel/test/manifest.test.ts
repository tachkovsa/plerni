// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PluginPackageError } from '../src/plugin/errors.ts';
import { assertGrantName, GRANT_NAME_MAX } from '../src/plugin/grants.ts';
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

test('grant names share the plugin_grant length limit', () => {
  const sql = readFileSync(join(here, '../sql/0003_plugin_grant.sql'), 'utf8');
  const bound = /char_length\(grant_name\) BETWEEN 2 AND (\d+)/.exec(sql);
  assert.equal(Number(bound?.[1]), GRANT_NAME_MAX);
  const base = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const egress = 'http.egress:';
  const publish = 'events.publish:';
  const hostAtLimit = 'a'.repeat(GRANT_NAME_MAX - egress.length);
  const hostPastLimit = 'a'.repeat(GRANT_NAME_MAX - egress.length + 1);
  const host191 = 'a'.repeat(191);
  assert.equal(egress.length + host191.length, 203);
  const eventAtLimit = `a.${'b'.repeat(GRANT_NAME_MAX - publish.length - 2)}`;
  const eventPastLimit = `a.${'b'.repeat(GRANT_NAME_MAX - publish.length - 1)}`;
  assert.equal(publish.length + eventAtLimit.length, GRANT_NAME_MAX);
  assert.equal(publish.length + eventPastLimit.length, GRANT_NAME_MAX + 1);
  assert.doesNotThrow(() => assertGrantName(egress + hostAtLimit));
  assert.doesNotThrow(() => assertGrantName(publish + eventAtLimit));
  assert.doesNotThrow(() => parseManifest({ ...base, migrations: [], grants: [egress + hostAtLimit] }));
  for (const grant of [egress + hostPastLimit, egress + host191, publish + eventPastLimit]) {
    assert.throws(() => assertGrantName(grant), (error: unknown) => error instanceof PluginPackageError);
    assert.throws(
      () => parseManifest({ ...base, migrations: [], grants: [grant] }),
      (error: unknown) => error instanceof PluginPackageError,
    );
  }
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
