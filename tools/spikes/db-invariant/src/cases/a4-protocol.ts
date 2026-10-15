// SPDX-License-Identifier: Apache-2.0
// a4-protocol.ts — A4 (plan §3.1): unnamed extended-protocol discipline, measured honestly.
// Outbound statement names are observed by wrapping pg's Query.submit path (parse + bind).
// pg_prepared_statements is never consulted: it is per-backend and a pool can miss names.
// Benchmark is unnamed parameterized extended-protocol vs named, on a direct connection.
// max_prepared_statements does not help unnamed traffic. Overhead opens A4b
// (https://github.com/tachkovsa/plerni/issues/34) when the mean is above 20%
// (plan §3.1): a named-statement branch, max_prepared_statements > 0, then rerun A1–A3.
// Spread is recorded and does not gate the trigger.
// The benchmark alternates ABBA/BAAB across 10 reps.
import pg from 'pg';
import { sql } from 'kysely';
import { direct, pooled, rawApp, terminateBackendByPid } from '../client.ts';
import { withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from './a2-oracle.ts';
import { blankEv, rawAppSteps, readRows, recordProbe } from './a3-pgbouncer.ts';

const OVERHEAD_LIMIT_PCT = 20;
const ITERATIONS = 2500;
const REPS = 10;
const A4B_ISSUE = 'https://github.com/tachkovsa/plerni/issues/34';
// Two-sided 95% Student t, keyed by degrees of freedom (REPS - 1).
const T_CRIT_95_BY_DF: Readonly<Record<number, number>> = { 9: 2.262 };

function tCrit95(df: number): number {
  const value = T_CRIT_95_BY_DF[df];
  if (value === undefined) throw new Error(`no two-sided 95% t critical value for df ${df}`);
  return value;
}

export interface ObservedName { name: string; protocol: 'simple' | 'extended' }

interface WireQuery { name?: string; statement?: string }
interface WireConn { parse: (q: WireQuery) => void; bind: (q: WireQuery) => void }
interface Submittable { requiresPreparation(): boolean; submit(connection: WireConn): void }

/** Wrap the driver query path. Names are the ones pg-protocol puts on the wire (`|| ''`). */
export function watchOutboundNames(bucket: ObservedName[]): () => void {
  const proto = pg.Query.prototype as unknown as Submittable;
  const original = proto.submit;
  proto.submit = function (this: Submittable, connection: WireConn) {
    const parse = connection.parse;
    const bind = connection.bind;
    connection.parse = (q) => {
      bucket.push({ name: q.name || '', protocol: 'extended' });
      parse.call(connection, q);
    };
    connection.bind = (q) => {
      bucket.push({ name: q.statement || '', protocol: 'extended' });
      bind.call(connection, q);
    };
    try {
      if (!this.requiresPreparation()) bucket.push({ name: '', protocol: 'simple' });
      return original.call(this, connection);
    } finally {
      connection.parse = parse;
      connection.bind = bind;
    }
  };
  return () => { proto.submit = original; };
}

/** Record Query.text at submit time. Composes with nothing else; one wrapper at a time. */
export function watchOutboundSql(bucket: string[]): () => void {
  const proto = pg.Query.prototype as unknown as { text?: string; submit(connection: unknown): void };
  const original = proto.submit;
  proto.submit = function (this: { text?: string }, connection: unknown) {
    if (typeof this.text === 'string') bucket.push(this.text);
    return original.call(this, connection);
  };
  return () => { proto.submit = original; };
}

async function fullLoad(): Promise<void> {
  for (const make of [() => direct(), () => pooled(4)]) {
    const db = make();
    const ev = blankEv();
    try {
      await Promise.all([TENANT_A, TENANT_B, TENANT_A, TENANT_B].map((id, i) =>
        withTenant(db, id, ev, terminateBackendByPid, async (trx) => {
          await sql`SELECT ${i}::int AS n`.execute(trx); // parameterized → extended, unnamed
          return readRows(trx); // no parameters → simple protocol
        })));
      if (ev.terminatedBackendPids.length !== 0) {
        throw new Error(`discipline workload self-terminated ${ev.terminatedBackendPids.length} backends`);
      }
    } finally {
      await db.destroy();
    }
  }
  const c = rawApp();
  await c.connect();
  try {
    await c.query('SELECT $1::int AS n', [1]);
    await c.query('SELECT 1 AS n');
  } finally {
    await c.end();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function overheadStats(xs: number[]): {
  min: number; median: number; p95: number; stddev: number;
  mean: number; meanUnrounded: number; ci95Low: number; ci95High: number;
} {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n !== REPS) throw new Error(`overhead reps ${n} !== ${REPS}`);
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  const p95 = s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)]!;
  const half = tCrit95(n - 1) * stddev / Math.sqrt(n);
  return {
    min: round1(s[0]!), median: round1(median), p95: round1(p95), stddev: round1(stddev),
    mean: round1(mean), meanUnrounded: mean,
    ci95Low: round1(mean - half), ci95High: round1(mean + half),
  };
}

async function timeBlock(c: ReturnType<typeof rawApp>, named: boolean, text: string): Promise<number> {
  const t = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    if (named) await c.query({ name: 'a4_bench', text, values: ['goal'] });
    else await c.query(text, ['goal']);
  }
  return performance.now() - t;
}

async function benchmark(): Promise<{
  unnamedMs: number[]; namedMs: number[]; overheadPct: number[];
  spread: ReturnType<typeof overheadStats>; a4bRequired: boolean;
}> {
  const c = rawApp();
  await c.connect();
  const text = 'SELECT label FROM plerni_tenant WHERE label = $1';
  try {
    for (let i = 0; i < 40; i++) await c.query(text, ['goal']);
    await c.query({ name: 'a4_bench', text, values: ['goal'] });
    for (let i = 0; i < 40; i++) await c.query({ name: 'a4_bench', text, values: ['goal'] });
    const unnamedMs: number[] = [];
    const namedMs: number[] = [];
    const overheadPct: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      // Even reps ABBA (unnamed first). Odd reps BAAB (named first). Each rep times both orders.
      const namedFlags = rep % 2 === 0 ? [false, true, true, false] : [true, false, false, true];
      let unnamed = 0;
      let named = 0;
      for (const namedBlock of namedFlags) {
        const ms = await timeBlock(c, namedBlock, text);
        if (namedBlock) named += ms;
        else unnamed += ms;
      }
      unnamedMs.push(unnamed);
      namedMs.push(named);
      overheadPct.push(((unnamed - named) / named) * 100);
    }
    const spread = overheadStats(overheadPct);
    return {
      unnamedMs: unnamedMs.map((n) => Math.round(n)),
      namedMs: namedMs.map((n) => Math.round(n)),
      overheadPct: overheadPct.map(round1),
      spread,
      // Plan §3.1: overhead > 20% opens A4b. Compare the unrounded mean.
      // spread.mean is rounded for display and can hide a value just above 20.
      a4bRequired: spread.meanUnrounded > OVERHEAD_LIMIT_PCT,
    };
  } finally {
    await c.end();
  }
}

/** §3.0 control for the overhead probe: one unnamed extended query and one named statement. */
async function rawNamedAndUnnamed(): Promise<unknown> {
  const seen: ObservedName[] = [];
  const unwatch = watchOutboundNames(seen);
  try {
    const rows = await rawAppSteps([
      { text: 'SELECT label FROM plerni_tenant WHERE label = $1', values: ['goal'] },
      { name: 'a4_raw_control', text: 'SELECT label FROM plerni_tenant WHERE label = $1', values: ['goal'] },
    ]);
    const extended = seen.filter((s) => s.protocol === 'extended').map((s) => s.name);
    return {
      rows,
      extendedNames: [...new Set(extended)],
      sawUnnamed: extended.includes(''),
      sawNamed: extended.includes('a4_raw_control'),
    };
  } finally {
    unwatch();
  }
}

async function measureNames(): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  const seen: ObservedName[] = [];
  const unwatch = watchOutboundNames(seen);
  let loadError: string | null = null;
  try {
    await fullLoad();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  } finally {
    unwatch();
  }
  const nonempty = seen.filter((s) => s.name !== '');
  const extended = seen.filter((s) => s.protocol === 'extended').length;
  const simple = seen.filter((s) => s.protocol === 'simple').length;
  return {
    pass: loadError === null && seen.length > 0 && extended > 0 && simple > 0 && nonempty.length === 0,
    detail: {
      observed: seen.length,
      extended,
      simple,
      nonempty: nonempty.slice(0, 5),
      loadError,
      instrumentation: 'pg.Query.submit parse+bind; not pg_prepared_statements',
    },
  };
}

export async function a4Protocol(): Promise<void> {
  await recordProbe(
    { case: 'A4 unnamed statement names', datasource: 'direct+pooled' },
    measureNames,
    rawNamedAndUnnamed,
  );

  await recordProbe(
    { case: 'A4 unnamed-vs-named overhead', datasource: 'direct' },
    async () => {
      try {
        const bench = await benchmark();
        return {
          pass: Number.isFinite(bench.spread.mean),
          detail: {
            unnamedMs: bench.unnamedMs,
            namedMs: bench.namedMs,
            overheadPct: bench.overheadPct,
            spread: bench.spread,
            iterationsPerBlock: ITERATIONS,
            blocksPerRep: 4,
            reps: REPS,
            order: 'ABBA then BAAB',
            environment: { node: process.version },
            overheadLimitPct: OVERHEAD_LIMIT_PCT,
            a4bIssue: A4B_ISSUE,
            a4bRequired: bench.a4bRequired,
            decision: bench.a4bRequired ? 'mean-exceeds-20' : 'mean-at-or-below-20',
            a4b: bench.a4bRequired
              ? {
                title: 'test(spike): A4b named-statement branch',
                issue: A4B_ISSUE,
                runsWith: 'max_prepared_statements > 0',
                rerun: 'A1–A3 under that config',
                ci95Low: bench.spread.ci95Low,
                median: bench.spread.median,
              }
              : null,
          },
        };
      } catch (e) {
        return { pass: false, detail: { error: e instanceof Error ? e.message : String(e) } };
      }
    },
    rawNamedAndUnnamed,
  );
}
