// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { lintFile } from './corpus-lint.mjs';

const fixtureDir = join(import.meta.dirname, 'fixtures');

function rules(file) {
  return new Set(lintFile(join(fixtureDir, file)).map((finding) => finding.rule));
}

test('corpus-lint rejects escape hatches', () => {
  assert.ok(rules('as-assertion.ts').has('as-assertion'));
  assert.ok(rules('as-any.ts').has('as-assertion'));
  assert.ok(rules('as-any.ts').has('any'));
  assert.ok(rules('angle-assertion.ts').has('as-assertion'));
  assert.ok(rules('sql-fragment.ts').has('sql-fragment'));
  assert.ok(rules('sql-set-config-generic.ts').has('explicit-type-argument'));
  assert.ok(rules('sql-set-config-generic.ts').has('sql-fragment'));
  assert.ok(rules('sql-set-config-other-guc.ts').has('sql-fragment'));
  assert.ok(rules('sql-call.ts').has('sql-fragment'));
  assert.ok(rules('cast-to.ts').has('escape-hatch'));
  assert.ok(rules('narrow-type.ts').has('escape-hatch'));
  assert.ok(rules('assert-type.ts').has('escape-hatch'));
  assert.ok(rules('explicit-result-generic.ts').has('explicit-type-argument'));
});

test('corpus-lint allows Kysely .as() and the set_config call', () => {
  assert.deepEqual(lintFile(join(fixtureDir, 'dot-as-allowed.ts')), []);
  assert.deepEqual(lintFile(join(fixtureDir, 'set-config-allowed.ts')), []);
});
