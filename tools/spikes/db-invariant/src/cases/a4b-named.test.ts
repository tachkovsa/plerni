// SPDX-License-Identifier: Apache-2.0
// The A4b config probe is classified without a database. client.ts exits at import
// unless every harness DSN is already set, and these imports are static, so the
// stand-ins are assigned before the dynamic import. Nothing here connects.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HARNESS_DIRECT_DSN ??= 'postgres://plerni_app@localhost:1/plerni';
process.env.HARNESS_POOLED_DSN ??= 'postgres://plerni_app@localhost:1/plerni';
process.env.HARNESS_ADMIN_DSN ??= 'postgres://plerni_admin_ro@localhost:1/pgbouncer';
process.env.HARNESS_ROOT_DSN ??= 'postgres://postgres@localhost:1/plerni';

const { attemptProbe } = await import('./a3-pgbouncer.ts');
const { preparedTrackingProbe } = await import('./a4b-named.ts');

test('a failed pooler read that later recovers is an invalid run', async () => {
  let calls = 0;
  const read = async (): Promise<number | null> => {
    calls += 1;
    if (calls === 1) throw new Error('show config unavailable');
    return 200;
  };
  const result = await attemptProbe(preparedTrackingProbe(read));
  assert.equal(calls, 3);
  assert.equal(result.pass, false);
  assert.equal(result.detail.outcome, 'environmental-noise');
  assert.equal(result.detail.verdict, 'invalid-run-no-verdict');
  assert.deepEqual(result.detail.runs, [false, true, true]);
});
