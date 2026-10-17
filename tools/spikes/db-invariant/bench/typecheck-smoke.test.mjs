// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { spikeRoot } from './band.mjs';
import { renderCorpus } from './gen-corpus.mjs';

function typechecks(dir) {
  const tsc = join(spikeRoot, 'node_modules', '.bin', 'tsc');
  for (const config of ['tsconfig.corpus.json', 'tsconfig.baseline.json']) {
    const result = spawnSync(tsc, ['--noEmit', '-p', join(dir, config)], {
      cwd: spikeRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${config}\n${result.stdout}\n${result.stderr}`);
  }
}

test('sample corpus and baseline typecheck against committed band-50 types', { timeout: 180_000 }, () => {
  const parent = join(spikeRoot, 'bench', 'out');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'smoke-'));
  try {
    renderCorpus(50, { outDir: dir, sample: true });
    typechecks(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full band-50 corpus and baseline typecheck', { timeout: 180_000 }, () => {
  const parent = join(spikeRoot, 'bench', 'out');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'full-'));
  try {
    renderCorpus(50, { outDir: dir });
    typechecks(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
