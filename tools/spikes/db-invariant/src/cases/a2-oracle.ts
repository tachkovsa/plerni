// a2-oracle.ts — A2: transaction-local context cannot leak across pool reuse; absence fails closed.
// Three distinct cases (R2#1): (a) clean-deny — a transaction deliberately missing context reads
// zero rows AND the app guard raises; (b) valid-context positive control — a correctly initialized
// tenant-B transaction reads exactly B's rows; (c) leak-freedom oracle per plan §3.1 A2(c): after
// commit/abort, on the REUSED connection, NULLIF(current_setting('plerni.tenant_id', true), '')
// IS NULL, and a context-less follow-up reads zero rows.
// Plus the contamination lifecycle preview (battery 3's full home is T3b): session-level SET
// survives reuse; detection inside the pinned transaction; the contaminated backend terminated via
// the privileged path (γ-M1) and evicted (verified via pg_stat_activity); absence checked on the
// REPLACEMENT session; positive controls pass after recovery; terminations == injected (identity
// asserted, γ-m3); termination+retry within the bounded budget; no thrash on warm backends.
import { sql, type Kysely, type Transaction } from 'kysely';
import { direct, pooled, rawRoot, idlePoolErrors, terminateBackendByPid, type Db } from '../client.ts';
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
    const ev: HygieneEvidence = { terminatedBackendPids: [], attempts: 0, alerts: [], discardedPoolerSessions: 0 };
    let db = make(); // pool size 1: the follow-up provably reuses the same connection

    // (a) clean-deny: a transaction deliberately missing the context install.
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
    const bRows = await withTenant(db, TENANT_B, ev, terminateBackendByPid, readLabels);
    record({
      case: 'A2b valid-context positive control', datasource: label,
      pass: JSON.stringify(bRows) === JSON.stringify(B_LABELS),
      detail: { read: bRows, want: B_LABELS },
    });

    // (c) the mandated leak-freedom oracle (plan §3.1 A2(c)) — on the reused connection:
    const leak = await db.transaction().execute(async (trx) => {
      const absent = await sql<{ absent: boolean }>`
        SELECT NULLIF(current_setting('plerni.tenant_id', true), '') IS NULL AS absent`.execute(trx);
      const rowsAfter = (await readLabels(trx)).length; // context-less follow-up
      return { absent: absent.rows[0]!.absent, rowsAfter };
    });
    record({
      case: 'A2c leak-freedom on reused connection', datasource: label,
      pass: leak.absent && leak.rowsAfter === 0,
      detail: { contextAbsentAfterCommit: leak.absent, rowsWithoutContextFollowUp: leak.rowsAfter },
    });

    // Battery-3 preview: contamination lifecycle with the privileged terminator — per class.
    for (const [cls, inject] of [
      ['GUC', () => sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(db)],
      ['SET ROLE', () => sql`SET ROLE plerni_plugin_a`.execute(db)],
    ] as const) {
      const terminationsBeforeCls = ev.terminatedBackendPids.length;
      await inject();
      let recoveryRows: string[] = [];
      let thrown: string | null = null;
      try {
        recoveryRows = await withTenant(db, TENANT_B, ev, terminateBackendByPid, readLabels);
      } catch (e) {
        thrown = String(e);
      }
      const injectedPid = ev.terminatedBackendPids.at(-1);
      const terminatedThisCls = ev.terminatedBackendPids.length - terminationsBeforeCls;
      const deadVerified = injectedPid !== undefined && !(await backendAlive(injectedPid));
      record({
        case: `A2e contamination lifecycle — ${cls} (battery-3 preview)`, datasource: label,
        pass: thrown === null
          && JSON.stringify(recoveryRows) === JSON.stringify(B_LABELS)
          && terminatedThisCls === 1  // exactly this class's one injected contamination
          && deadVerified,            // and that very backend is gone (identity, γ-m3)
        detail: {
          class: cls, injectedAndTerminatedPid: injectedPid, deadVerified, recoveryRows,
          attempts: ev.attempts, alerts: ev.alerts, thrown, idlePoolErrorsSeen: idlePoolErrors.length,
        },
      });
      await db.destroy();
      db = make(); // fresh pool per class: the previous one is terminated through
    }

    // Warm-backend sanity: after protocol runs, no further terminations (no thrash).
    const terminationsAfterLifecycle = ev.terminatedBackendPids.length;
    await withTenant(db, TENANT_A, ev, terminateBackendByPid, readLabels);
    await withTenant(db, TENANT_B, ev, terminateBackendByPid, readLabels);
    record({
      case: 'A2d warm-backend no-thrash', datasource: label,
      pass: ev.terminatedBackendPids.length === terminationsAfterLifecycle,
      detail: { terminationsBefore: terminationsAfterLifecycle, terminationsAfter: ev.terminatedBackendPids.length },
    });

    await db.destroy();
  }
}
