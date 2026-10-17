// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { CEILING_RSS_KIB, CEILING_WALL_MS } from './band.mjs';
import { classifyTarget, parseTimeReport } from './measure.mjs';

const report = `Elapsed (wall clock) time (h:mm:ss or m:ss): 1:02.25
Maximum resident set size (kbytes): 123456
`;

test('parseTimeReport reads GNU time wall clock and peak RSS', () => {
  assert.deepEqual(parseTimeReport(report), { wall_ms: 62250, rss_kib: 123456 });
  assert.deepEqual(
    parseTimeReport('Elapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03.50\nMaximum resident set size (kbytes): 8\n'),
    { wall_ms: 3_723_500, rss_kib: 8 },
  );
  assert.equal(parseTimeReport('no timing here'), null);
});

test('classifyTarget binds the ceiling only at band 75', () => {
  const ok = { measured: true, wall_ms: 1000, rss_kib: 1000, exit_code: 0, signal: null };
  const slow = { measured: true, wall_ms: CEILING_WALL_MS + 1, rss_kib: 1000, exit_code: 0, signal: null };
  const fat = { measured: true, wall_ms: 1000, rss_kib: CEILING_RSS_KIB + 1, exit_code: 0, signal: null };
  const killed = { measured: true, wall_ms: 1000, rss_kib: 1000, exit_code: 137, signal: 'SIGKILL' };
  const broken = { measured: true, wall_ms: 1000, rss_kib: 1000, exit_code: 2, signal: null };
  const missing = { measured: false, wall_ms: null, rss_kib: null, exit_code: null, signal: null };
  assert.equal(classifyTarget(75, [ok, ok, ok]).outcome, 'within-ceiling');
  assert.equal(classifyTarget(75, [ok, slow, ok]).outcome, 'over-ceiling');
  assert.equal(classifyTarget(75, [ok, fat, ok]).outcome, 'over-ceiling');
  assert.equal(classifyTarget(75, [ok, killed, ok]).outcome, 'over-ceiling');
  assert.equal(classifyTarget(75, [ok, broken, ok]).outcome, 'compiler-error');
  assert.equal(classifyTarget(75, [ok, missing, ok]).outcome, 'invalid');
  const stress = classifyTarget(400, [slow, fat, ok]);
  assert.equal(stress.outcome, 'stress');
  assert.equal(stress.over_ceiling, true);
  assert.equal(stress.ceiling_applies, false);
});
