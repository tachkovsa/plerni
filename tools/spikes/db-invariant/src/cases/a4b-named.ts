// SPDX-License-Identifier: Apache-2.0
// a4b-named.ts — A4b (plan §3.1): the named-statement branch.
// Unnamed extended-protocol overhead on a direct connection exceeded 20%, so this
// experiment names client statements and reruns A1–A3 on the pooled datasource.
// It is not a config flip of A4: the default client still sends empty names, and
// this installer is removed before the battery. max_prepared_statements must be
// > 0 or PgBouncer does not track the names (PgBouncer 1.26.0 doc/config.md).
// A missing prepared statement at 0 is a config outcome, never a driver-level one.
import { adminShow, rawAppPooled } from '../client.ts';
import { installNamedStatements } from '../named-statements.ts';
import { PIN_CONCURRENT, PIN_SAMPLES, pidsViaRawPg, type PinClient } from './a1-pinning.ts';
import { pooledA1ThroughA3, rawAppSteps, recordProbe, type Probe } from './a3-pgbouncer.ts';
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

/** One parameterized statement, no explicit protocol name. The installed namer supplies it. */
export const RAW_NAMING_STEP = {
  text: 'SELECT label FROM plerni_tenant WHERE label = $1',
  values: ['goal'],
} as const;

export interface RawNamingEvidence {
  rows: unknown;
  extendedNames: string[];
  unnamedExtended: number;
  sawUnnamed: boolean;
  instrumentation: string;
}

/** Names from this run only. A watcher already installed for Kysely would steal the submit. */
export async function rawNamingEvidence(run: () => Promise<unknown>): Promise<RawNamingEvidence> {
  const seen: ObservedName[] = [];
  const unwatch = watchOutboundNames(seen);
  try {
    const rows = await run();
    const extended = seen.filter((row) => row.protocol === 'extended');
    const names = extended.map((row) => row.name);
    return {
      rows,
      extendedNames: [...new Set(names)],
      unnamedExtended: names.filter((name) => name === '').length,
      sawUnnamed: names.includes(''),
      instrumentation: 'raw pg client; not the Kysely workload bucket',
    };
  } finally {
    unwatch();
  }
}

/**
 * Plan §3.0 raw-pg control for a naming failure. Releases the Kysely watcher
 * first, then runs `run` (a raw pg client workload) and records that submit.
 */
export async function namingRawPg(
  releaseKyselyWatch: () => void,
  run: () => Promise<unknown>,
): Promise<RawNamingEvidence> {
  releaseKyselyWatch();
  return rawNamingEvidence(run);
}

/** A1's concurrent raw-pg pinning control. `open` is rawAppPooled for the A4b rerun. */
export async function pooledRawPinningProbe(open: () => PinClient): Promise<Probe> {
  const pids = await pidsViaRawPg(open);
  return {
    pass: pids.length === PIN_CONCURRENT
      && pids.every((row) => row.length === PIN_SAMPLES && new Set(row).size === 1),
    detail: {
      via: 'raw-pg',
      datasource: 'pooled',
      concurrent: PIN_CONCURRENT,
      statementsPerTransaction: PIN_SAMPLES,
      pids,
    },
  };
}

/**
 * Named-statement window. The pooled raw pinning control runs here, on the
 * success path, through whatever opener the caller supplies (rawAppPooled).
 */
export async function runNamedA4b(
  openRawPooled: () => PinClient,
  workload: (seen: ObservedName[]) => Promise<readonly ObservedName[]>,
  rawNames: () => Promise<unknown>,
): Promise<void> {
  const restore = installNamedStatements();
  const seen: ObservedName[] = [];
  const unwatch = watchOutboundNames(seen);
  try {
    await recordProbe(
      { case: 'A4b pooled raw-pg pinning', datasource: 'pooled' },
      () => pooledRawPinningProbe(openRawPooled),
      () => pooledRawPinningProbe(openRawPooled),
    );
    await recordProbe(
      { case: 'A4b named statement names', datasource: 'pooled' },
      namedStatementProbe(async () => {
        seen.length = 0;
        return workload(seen);
      }),
      () => namingRawPg(unwatch, rawNames),
    );
  } finally {
    unwatch();
    restore();
  }
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

  await runNamedA4b(
    rawAppPooled,
    async (seen) => {
      await pooledA1ThroughA3('A4b', () => pooledRawPinningProbe(rawAppPooled));
      return seen.slice();
    },
    () => rawAppSteps([{ text: RAW_NAMING_STEP.text, values: [...RAW_NAMING_STEP.values] }]),
  );
}
