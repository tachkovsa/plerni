// SPDX-License-Identifier: Apache-2.0
// The A4b config probe is classified without a database. client.ts exits at import
// unless every harness DSN is already set, and these imports are static, so the
// stand-ins are assigned before the dynamic import. Nothing here connects.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservedName } from './a4-protocol.ts';

process.env.HARNESS_DIRECT_DSN ??= 'postgres://plerni_app@localhost:1/plerni';
process.env.HARNESS_POOLED_DSN ??= 'postgres://plerni_app@localhost:1/plerni';
process.env.HARNESS_ADMIN_DSN ??= 'postgres://plerni_admin_ro@localhost:1/pgbouncer';
process.env.HARNESS_ROOT_DSN ??= 'postgres://postgres@localhost:1/plerni';

const { attemptProbe } = await import('./a3-pgbouncer.ts');
const { namingRawPg, namedStatementProbe, preparedTrackingProbe, RAW_NAMING_STEP } = await import('./a4b-named.ts');
const { watchOutboundNames } = await import('./a4-protocol.ts');
const pg = (await import('pg')).default;

function submitExtended(name: string): void {
  const query = new pg.Query({ name, text: 'SELECT $1::int', values: [1] });
  const connection = {
    parsedStatements: {} as Record<string, string>,
    submittedNamedStatements: {} as Record<string, string>,
    stream: {},
    parse() {},
    bind() {},
    describe() {},
    close() {},
    execute() {},
    sync() {},
    flush() {},
  };
  (query as unknown as { submit(connection: unknown): unknown }).submit(connection);
}

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

test('an intermittent unnamed statement that later stays named is an invalid run', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls === 1) {
      return [
        { name: '', protocol: 'extended' as const },
        { name: 'n1', protocol: 'extended' as const },
      ];
    }
    return [
      { name: 'n1', protocol: 'extended' as const },
      { name: 'n2', protocol: 'extended' as const },
    ];
  };
  const result = await attemptProbe(namedStatementProbe(run));
  assert.equal(calls, 3);
  assert.equal(result.pass, false);
  assert.equal(result.detail.unnamedExtended, 1);
  assert.equal(result.detail.outcome, 'environmental-noise');
  assert.equal(result.detail.verdict, 'invalid-run-no-verdict');
  assert.deepEqual(result.detail.runs, [false, true, true]);
});

test('a naming failure runs a raw client control instead of the Kysely name bucket', async () => {
  const kysely: ObservedName[] = [{ name: '', protocol: 'extended' }];
  const release = watchOutboundNames(kysely);
  try {
    let ran = 0;
    const evidence = await namingRawPg(release, async () => {
      ran += 1;
      submitExtended('nraw');
      return [{ label: 'goal' }];
    });
    assert.equal(ran, 1);
    assert.deepEqual(evidence.rows, [{ label: 'goal' }]);
    assert.deepEqual(evidence.extendedNames, ['nraw']);
    assert.equal(evidence.sawUnnamed, false);
    assert.equal(evidence.unnamedExtended, 0);
    assert.deepEqual(kysely, [{ name: '', protocol: 'extended' }]);
    assert.equal(evidence.instrumentation, 'raw pg client; not the Kysely workload bucket');
  } finally {
    release();
  }
});

test('the raw naming control reports an unnamed extended statement from its own submit', async () => {
  const evidence = await namingRawPg(() => {}, async () => {
    submitExtended('');
    return [];
  });
  assert.equal(evidence.sawUnnamed, true);
  assert.ok(evidence.unnamedExtended > 0);
  assert.deepEqual(evidence.extendedNames, ['']);
});

test('the raw naming control statement carries values and no explicit protocol name', () => {
  assert.equal('name' in RAW_NAMING_STEP, false);
  assert.deepEqual(RAW_NAMING_STEP.values, ['goal']);
  assert.match(RAW_NAMING_STEP.text, /^SELECT /);
});
