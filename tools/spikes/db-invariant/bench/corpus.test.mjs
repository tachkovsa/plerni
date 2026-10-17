// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BANDS, spikeRoot } from './band.mjs';
import { lintSource } from './corpus-lint.mjs';
import { countShapes, descriptors, renderSources } from './gen-corpus.mjs';

function outDir() {
  const parent = join(spikeRoot, 'bench', 'out');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'case-'));
}

test('corpus and baseline follow the allocation at every band', () => {
  for (const n of BANDS) {
    const dir = outDir();
    try {
      const { corpus, baseline, allocation, queryCount } = renderSources(n, { outDir: dir });
      assert.equal(queryCount, allocation.total);
      assert.ok(corpus.includes('function acceptanceCorpusPart0('));
      assert.equal(corpus.includes('function acceptanceCorpusPart1('), allocation.total > 100);
      assert.deepEqual(countShapes(corpus), { S: allocation.s, M: allocation.m, L: allocation.l });
      assert.deepEqual(countShapes(baseline), { S: allocation.s, M: allocation.m, L: allocation.l });
      assert.equal(corpus.split('Expect<Equal<').length - 1, allocation.total);
      assert.equal(corpus.split('set_config(').length - 1, 1);
      assert.equal(baseline.includes('set_config('), false);
      assert.equal(corpus.includes(".as('a_id')"), true);
      assert.ok(corpus.includes('// shape:M joins=2 statement=1'));
      assert.ok(corpus.includes('// shape:M joins=3 statement=1'));
      assert.ok(corpus.includes('// shape:L cte-select statement=1'));
      assert.ok(corpus.includes('// shape:L cte-modify statement=1'));
      assert.ok(corpus.includes('// shape:L conditional statement=1'));
      assert.ok(corpus.includes('// shape:L helper statement=1'));
      assert.equal(baseline.split('sql<').length - 1, allocation.total);
      const shapeBlock = (marker) => {
        const start = baseline.indexOf(marker);
        assert.notEqual(start, -1, marker);
        return baseline.slice(start, baseline.indexOf('\n  }', start));
      };
      const mStatement = shapeBlock('// shape:M joins=2 statement=1');
      assert.match(mStatement, /a\.status = \$\{status\}/);
      assert.match(mStatement, /s\.seq > \$\{seq\}/);
      assert.match(mStatement, /limit 50/);
      const mEntity = shapeBlock('// shape:M joins=2 statement=0');
      assert.match(mEntity, /a\.status = \$\{status\}/);
      assert.match(mEntity, /a\.seq > \$\{seq\}/);
      assert.match(mEntity, /order by a\.seq, a\.id limit 50/);
      assert.match(shapeBlock('// shape:L cte-select statement=1'), /with picked as \(select id, tenant_id, payload/);
      assert.match(shapeBlock('// shape:L cte-modify statement=1'), /with inserted as \(insert into plugin_lrs_statement/);
      assert.match(shapeBlock('// shape:L cte-select statement=0'), /with picked as \(select id, tenant_id, label/);
      assert.match(shapeBlock('// shape:L cte-modify statement=0'), /with inserted as \(insert into ent_/);
      assert.match(shapeBlock('// shape:L conditional statement=1'), /or \(seq = \$\{seq\} and id > \$\{keyId\}\)/);
      assert.equal(shapeBlock('// shape:L conditional statement=1').includes('limit 50'), false);
      const conditionalEntity = shapeBlock('// shape:L conditional statement=0');
      assert.match(conditionalEntity, /status = \$\{status\}/);
      assert.match(conditionalEntity, /order by seq, id limit 50/);
      assert.match(shapeBlock('// shape:L helper statement=1'), /or \(seq = \$\{seq\} and id > \$\{keyId\}\)\) limit 50/);
      assert.match(shapeBlock('// shape:L helper statement=0'), /or \(seq = \$\{seq\} and id > \$\{keyId\}\)\) limit 50/);
      const findings = lintSource(`band-${n}/corpus.ts`, corpus);
      assert.deepEqual(findings, [], findings.map((finding) => finding.rule).join(','));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('sample descriptors cover both table kinds and both join widths', () => {
  const items = descriptors(75, { sample: true });
  assert.ok(items.some((item) => item.kind === 'S' && item.table.kind === 'statement'));
  assert.ok(items.some((item) => item.kind === 'S' && item.table.kind === 'entity'));
  assert.ok(items.some((item) => item.kind === 'M' && item.statement && item.joins === 2));
  assert.ok(items.some((item) => item.kind === 'M' && item.statement && item.joins === 3));
  assert.ok(items.some((item) => item.kind === 'M' && !item.statement && item.joins === 2));
  assert.ok(items.some((item) => item.kind === 'M' && !item.statement && item.joins === 3));
  for (const shape of ['cte-select', 'cte-modify', 'conditional', 'helper']) {
    assert.ok(items.some((item) => item.kind === 'L' && item.shape === shape && item.statement));
    assert.ok(items.some((item) => item.kind === 'L' && item.shape === shape && !item.statement));
  }
});
