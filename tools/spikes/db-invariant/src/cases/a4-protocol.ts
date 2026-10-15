// a4-protocol.ts — A4 (plan §3.1): unnamed extended-protocol discipline, measured honestly.
// Outbound statement names are observed by wrapping pg's Query.submit path (parse + bind).
// pg_prepared_statements is never consulted: it is per-backend and a pool can miss names.
// Benchmark is unnamed parameterized extended-protocol vs named, on a direct connection.
// max_prepared_statements does not help unnamed traffic. Overhead >20% opens A4b
// (named-statement branch, max_prepared_statements > 0, rerun A1–A3) — a new experiment.
import pg from 'pg';
import { sql } from 'kysely';
import { direct, pooled, rawApp, terminateBackendByPid } from '../client.ts';
import { withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from './a2-oracle.ts';
import { blankEv, rawAppSteps, readRows, recordProbe } from './a3-pgbouncer.ts';

const OVERHEAD_LIMIT_PCT = 20;
const ITERATIONS = 600;
const REPS = 3;

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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function benchmark(): Promise<{ unnamedMs: number[]; namedMs: number[]; overheadPct: number }> {
  const c = rawApp();
  await c.connect();
  const text = 'SELECT label FROM plerni_tenant WHERE label = $1';
  try {
    const unnamedMs: number[] = [];
    const namedMs: number[] = [];
    for (let i = 0; i < 40; i++) await c.query(text, ['goal']);
    await c.query({ name: 'a4_bench', text, values: ['goal'] });
    for (let i = 0; i < 40; i++) await c.query({ name: 'a4_bench', text, values: ['goal'] });
    for (let rep = 0; rep < REPS; rep++) {
      let t = performance.now();
      for (let i = 0; i < ITERATIONS; i++) await c.query(text, ['goal']);
      unnamedMs.push(performance.now() - t);
      t = performance.now();
      for (let i = 0; i < ITERATIONS; i++) await c.query({ name: 'a4_bench', text, values: ['goal'] });
      namedMs.push(performance.now() - t);
    }
    const overheadPct = ((median(unnamedMs) - median(namedMs)) / median(namedMs)) * 100;
    return {
      unnamedMs: unnamedMs.map((n) => Math.round(n)),
      namedMs: namedMs.map((n) => Math.round(n)),
      overheadPct: Math.round(overheadPct * 10) / 10,
    };
  } finally {
    await c.end();
  }
}

async function rawNamedAndUnnamed(): Promise<unknown> {
  return rawAppSteps([
    { text: 'SELECT label FROM plerni_tenant WHERE label = $1', values: ['goal'] },
    { text: 'SELECT label FROM plerni_tenant WHERE label = $1', values: ['goal'] },
  ]);
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
        const a4b = bench.overheadPct > OVERHEAD_LIMIT_PCT;
        return {
          pass: Number.isFinite(bench.overheadPct),
          detail: {
            ...bench,
            iterations: ITERATIONS,
            reps: REPS,
            environment: { node: process.version },
            overheadLimitPct: OVERHEAD_LIMIT_PCT,
            a4bRequired: a4b,
            a4b: a4b
              ? {
                title: 'test(spike): A4b named-statement branch',
                runsWith: 'max_prepared_statements > 0',
                rerun: 'A1–A3 under that config',
                measuredOverheadPct: bench.overheadPct,
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
