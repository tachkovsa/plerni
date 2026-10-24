// SPDX-License-Identifier: Apache-2.0
// a4b-named.ts — A4b (plan §3.1): the named-statement branch.
// Unnamed extended-protocol overhead on a direct connection exceeded 20%, so this
// experiment names client statements and reruns A1–A3 on the pooled datasource.
// It is not a config flip of A4: the default client still sends empty names, and
// this installer is removed before the battery. max_prepared_statements must be
// > 0 or PgBouncer does not track the names (PgBouncer 1.26.0 doc/config.md).
// A missing prepared statement at 0 is a config outcome, never a driver-level one.
import { adminShow } from '../client.ts';
import { installNamedStatements } from '../named-statements.ts';
import { pooledA1ThroughA3, recordProbe, type Probe } from './a3-pgbouncer.ts';
import { watchOutboundNames, type ObservedName } from './a4-protocol.ts';

async function preparedLimit(): Promise<number | null> {
  const config = await adminShow('CONFIG') as Record<string, unknown>[];
  const raw = config.find((row) => row.key === 'max_prepared_statements')?.value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One SHOW CONFIG read. recordProbe calls this once per diagnostic attempt. */
export function preparedTrackingProbe(read: () => Promise<number | null>): () => Promise<Probe> {
  return async () => {
    let limit: number | null = null;
    let readError: string | null = null;
    try {
      limit = await read();
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e);
    }
    const enabled = limit !== null && limit > 0;
    return {
      pass: enabled,
      detail: {
        max_prepared_statements: limit,
        readError,
        required: '> 0',
        driverLevel: false,
        destination: enabled ? 'named-statement branch' : 'config',
        note: 'At 0 PgBouncer does not track named statements. That is not a driver failure.',
      },
    };
  };
}

/** One naming workload. recordProbe calls this once per diagnostic attempt. */
export function namedStatementProbe(
  run: () => Promise<readonly ObservedName[]>,
): () => Promise<Probe> {
  return async () => {
    const seen = await run();
    const extended = seen.filter((row) => row.protocol === 'extended');
    const unnamed = extended.filter((row) => row.name === '');
    return {
      pass: extended.length > 0 && unnamed.length === 0,
      detail: {
        extended: extended.length,
        named: extended.length - unnamed.length,
        unnamedExtended: unnamed.length,
        distinctNames: new Set(extended.map((row) => row.name)).size,
        instrumentation: 'pg.Query.submit parse+bind; not pg_prepared_statements',
      },
    };
  };
}

export async function a4bNamed(): Promise<void> {
  const tracked = await recordProbe(
    { case: 'A4b pooler tracks named statements', datasource: 'pooled' },
    preparedTrackingProbe(preparedLimit),
    async () => {
      try {
        return { max_prepared_statements: await preparedLimit() };
      } catch (e) {
        return { readError: e instanceof Error ? e.message : String(e) };
      }
    },
  );
  if (!tracked.pass) return;

  const restore = installNamedStatements();
  const seen: ObservedName[] = [];
  const unwatch = watchOutboundNames(seen);
  try {
    await recordProbe(
      { case: 'A4b named statement names', datasource: 'pooled' },
      namedStatementProbe(async () => {
        seen.length = 0;
        await pooledA1ThroughA3('A4b');
        return seen.slice();
      }),
      async () => seen.filter((row) => row.protocol === 'extended').slice(0, 5),
    );
  } finally {
    unwatch();
    restore();
  }
}
