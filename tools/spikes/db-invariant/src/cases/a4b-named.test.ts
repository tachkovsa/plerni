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
const {
  namingRawPg, namedStatementProbe, pooledRawPinningProbe, preparedTrackingProbe, RAW_NAMING_STEP, runNamedA4b,
} = await import('./a4b-named.ts');
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

function pinningClient(pids: number[]) {
  let sample = 0;
  const queries: string[] = [];
  return {
    queries,
    async connect() {},
    async query(text: string) {
      queries.push(text);
      if (text.includes('pg_backend_pid')) {
        const pid = pids[sample] ?? pids[pids.length - 1]!;
        sample += 1;
        return { rows: [{ pid }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

test('the pooled raw pinning control opens eight clients and requires a constant pid', async () => {
  let opens = 0;
  const clients: ReturnType<typeof pinningClient>[] = [];
  const probe = await pooledRawPinningProbe(() => {
    opens += 1;
    const client = pinningClient([40, 40, 40]);
    clients.push(client);
    return client;
  });
  assert.equal(opens, 8);
  assert.equal(probe.pass, true);
  assert.equal(probe.detail.via, 'raw-pg');
  assert.equal(probe.detail.datasource, 'pooled');
  for (const client of clients) {
    assert.deepEqual(client.queries, [
      'BEGIN',
      'SELECT pg_backend_pid() AS pid, pg_sleep(0.01)',
      'SELECT pg_backend_pid() AS pid, pg_sleep(0.01)',
      'SELECT pg_backend_pid() AS pid, pg_sleep(0.01)',
      'COMMIT',
    ]);
  }
});

test('the pooled raw pinning control fails when a backend pid changes', async () => {
  const probe = await pooledRawPinningProbe(() => pinningClient([1, 2, 1]));
  assert.equal(probe.pass, false);
});

test('A4b runs the pooled raw pinning control while naming is installed', async () => {
  const original = pg.Client.prototype.query;
  let opens = 0;
  try {
    await runNamedA4b(
      () => {
        opens += 1;
        assert.notEqual(pg.Client.prototype.query, original);
        return pinningClient([9, 9, 9]);
      },
      async () => [{ name: 'n1', protocol: 'extended' }],
      async () => { throw new Error('naming raw control runs only after the name probe fails'); },
    );
  } finally {
    pg.Client.prototype.query = original;
  }
  assert.equal(opens, 8);
  assert.equal(pg.Client.prototype.query, original);
});
