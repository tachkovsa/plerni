// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { spikeRoot } from './band.mjs';
import braces from './brace-expand/index.js';

const require = createRequire(realpathSync(join(spikeRoot, 'node_modules/kysely-codegen/package.json')));

test('brace-expand folds and expands one level, and rejects deep nesting', () => {
  assert.deepEqual(braces('pre/{a,b}/post'), ['pre/(a|b)/post']);
  assert.deepEqual(braces('pre/{a,b}/post', { expand: true }), ['pre/a/post', 'pre/b/post']);
  assert.deepEqual(braces('plain'), ['plain']);
  let deep = 'x';
  for (let i = 0; i < 20; i += 1) deep = `{${deep}}`;
  assert.throws(() => braces(deep), /depth/);
});

test('micromatch matcher still resolves through the stand-in', () => {
  const micromatch = require('micromatch');
  const isJs = micromatch.matcher('*.js', { nocase: true });
  assert.equal(isJs('A.JS'), true);
  assert.equal(isJs('a.txt'), false);
});
