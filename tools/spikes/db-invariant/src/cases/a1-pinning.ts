// a1-pinning.ts — A1: transaction().execute pins one server connection for the transaction's
// whole life. Pass: pg_backend_pid() constant across ≥3 statements per transaction under
// concurrent load, on the Kysely path AND an identical raw-pg control. Both main datasources.
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { direct, pooled, rawApp, rawAppPooled, type Db } from '../client.ts';
import { record } from '../evidence.ts';

const CONCURRENT = 8;
const SAMPLES = 3;

async function pidsViaKysely(db: Kysely<Db>): Promise<number[][]> {
  return Promise.all(Array.from({ length: CONCURRENT }, () =>
    db.transaction().execute(async (trx) => {
      const pids: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid, pg_sleep(0.01)`.execute(trx);
        pids.push(r.rows[0]!.pid);
      }
      return pids;
    })));
}

async function pidsViaRawPg(open: () => pg.Client): Promise<number[][]> {
  return Promise.all(Array.from({ length: CONCURRENT }, async () => {
    const c = open();
    await c.connect();
    const pids: number[] = [];
    try {
      await c.query('BEGIN');
      for (let i = 0; i < SAMPLES; i++) {
        const r = await c.query('SELECT pg_backend_pid() AS pid, pg_sleep(0.01)');
        pids.push(r.rows[0].pid);
      }
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    return pids;
  }));
}

const allConstant = (runs: number[][]) => runs.every((p) => new Set(p).size === 1);

export async function a1Pinning(): Promise<void> {
  for (const [label, db] of [['direct', direct()], ['pooled', pooled()]] as const) {
    const k = await pidsViaKysely(db);
    record({ case: 'A1', datasource: label, pass: allConstant(k), detail: { via: 'kysely', runs: k } });
    await db.destroy();
  }
  const rawDirect = await pidsViaRawPg(rawApp);
  record({
    case: 'A1',
    datasource: 'direct (raw-pg control)',
    pass: allConstant(rawDirect),
    detail: { via: 'raw-pg', runs: rawDirect },
  });
  const rawPooled = await pidsViaRawPg(rawAppPooled);
  record({
    case: 'A1',
    datasource: 'pooled (raw-pg control)',
    pass: allConstant(rawPooled),
    detail: { via: 'raw-pg', runs: rawPooled },
  });
}
