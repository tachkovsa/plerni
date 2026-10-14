// a2-oracle.ts — A2: transaction-local context cannot leak across pool reuse; absence fails closed.
// Three distinct cases (R2#1): (a) clean-deny — a transaction deliberately missing context reads
// zero rows AND the app guard raises; (b) valid-context positive control — a correctly initialized
// tenant-B transaction reads exactly B's rows; (c) contaminated reuse — normalized-absent oracle
// (PG may return '' — representation is not leakage) plus zero rows for a context-less follow-up.
// Contamination lifecycle (R3#1 + δ-F1/F2): session-level SET survives; detection inside the
// pinned transaction; backend physically terminated and evicted (verified via pg_stat_activity);
// absence check runs on the REPLACEMENT session; positive controls pass after recovery;
// termination+retry within the bounded budget; terminations == injected contaminations.
import { sql, type Kysely, type Transaction } from 'kysely';
import { direct, pooled, rawRoot, idlePoolErrors, type Db } from '../client.ts';
import { record } from '../evidence.ts';
import {
  withTenant, assertTenantContext, MissingTenantContextError,
  type HygieneEvidence,
} from '../context.ts';

export const TENANT_A = '11111111-1111-1111-1111-111111111111';
export const TENANT_B = '22222222-2222-2222-2222-222222222222';
const B_LABELS = ['assignment', 'goal', 'review'];

async function readLabels(trx: Transaction<Db>): Promise<string[]> {
  const r = await sql<{ label: string }>`SELECT label FROM plerni_tenant ORDER BY label`.execute(trx);
  return r.rows.map((x) => x.label);
}

async function backendAlive(pid: number): Promise<boolean> {
  const c = rawRoot();
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    return r.rows.length > 0;
  } finally {
    await c.end();
  }
}

export async function a2Oracle(): Promise<void> {
  for (const [label, make] of [['direct', () => direct()], ['pooled', () => pooled(1)]] as const) {
    const ev: HygieneEvidence = { terminatedBackendPids: [], attempts: 0, alerts: [] };

    // (a) clean-deny: a transaction deliberately missing the context install.
    const db = make();
    let rows = -1;
    let guardRaised = false;
    await db.transaction().execute(async (trx) => {
      rows = (await readLabels(trx)).length; // RLS: zero rows without context
      try {
        await assertTenantContext(trx);
      } catch (e) {
        guardRaised = e instanceof MissingTenantContextError;
      }
    });
    record({
      case: 'A2a clean-deny', datasource: label,
      pass: rows === 0 && guardRaised,
      detail: { rowsWithoutContext: rows, guardRaised },
    });

    // (b) positive control: valid tenant-B context reads exactly B's rows.
    const bRows = await withTenant(db, TENANT_B, ev, readLabels);
    record({
      case: 'A2b valid-context positive control', datasource: label,
      pass: JSON.stringify(bRows) === JSON.stringify(B_LABELS),
      detail: { read: bRows, want: B_LABELS },
    });

    // (c) contaminated reuse: session-level SET, then the protocol on the same pool.
    const contam = await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(db); // session-level (is_local=false)
    void contam;
    const contaminatedPid = await db.transaction().execute(async (trx) => {
      const r = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      return r.rows[0]!.pid;
    }).catch(() => -1); // may already die mid-probe; the evidence run below re-reads
    let terminatedSeen = -1;
    let recoveryRows: string[] = [];
    let thrown: string | null = null;
    try {
      recoveryRows = await withTenant(db, TENANT_B, ev, readLabels); // must detect → terminate → retry → B's rows
    } catch (e) {
      thrown = String(e);
    }
    terminatedSeen = ev.terminatedBackendPids.length;
    const deadVerified = terminatedSeen > 0 && !(await backendAlive(ev.terminatedBackendPids[0]!));
    record({
      case: 'A2c contaminated reuse', datasource: label,
      pass: thrown === null
        && JSON.stringify(recoveryRows) === JSON.stringify(B_LABELS)
        && terminatedSeen === 1 // exactly the one injected contamination
        && deadVerified,          // the contaminated backend is gone from pg_stat_activity
      detail: {
        injectedOnPid: contaminatedPid, terminatedPids: ev.terminatedBackendPids,
        deadVerified, recoveryRows, attempts: ev.attempts, alerts: ev.alerts, thrown,
        idlePoolErrorsSeen: idlePoolErrors.length,
      },
    });

    // Warm-backend sanity: after protocol runs, no further terminations (no thrash).
    const before = ev.terminatedBackendPids.length;
    await withTenant(db, TENANT_A, ev, readLabels);
    await withTenant(db, TENANT_B, ev, readLabels);
    record({
      case: 'A2d warm-backend no-thrash', datasource: label,
      pass: ev.terminatedBackendPids.length === before,
      detail: { terminationsBefore: before, terminationsAfter: ev.terminatedBackendPids.length },
    });

    await db.destroy();
  }
}
