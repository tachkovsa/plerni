// context.ts — the ordered connection-hygiene protocol, verbatim from plan §2.
// ① BEGIN → ② inspect named session state BEFORE any local override (current_setting then
//   returns the session value; after a local override it would be masked) — named plerni.* GUCs
//   (normalize '' as absent: a warm backend reads back '' after a local-only set) plus
//   current_user = session_user (a leaked session-level SET ROLE survives transaction-mode
//   pooling) plus search_path equals the pinned value → ③ contamination: terminate own backend
//   (pg_terminate_backend(pg_backend_pid()); PgBouncer evicts the dead server connection),
//   security alert, bounded retry ≤2 on a fresh connection, then loud failure → ④ clean:
//   set_config('plerni.tenant_id', tenant, true) + readback must equal the authorized tenant →
// ⑤ tenant access.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Db } from './client.ts';

export const CONTEXT_GUCS = ['plerni.tenant_id'] as const;
export const PINNED_SEARCH_PATH = 'public';
export const MAX_RETRY = 2;

export class ContaminationError extends Error {}
export class ContextInstallError extends Error {}

export interface HygieneEvidence {
  terminatedBackendPids: number[];
  attempts: number;
  alerts: string[];
}

interface SessionStateRow {
  tenant_guc: string | null;
  current_user: string;
  session_user: string;
  search_path: string;
  pid: number;
}

async function readSessionState(trx: Transaction<Db>): Promise<SessionStateRow> {
  const r = await sql<SessionStateRow>`SELECT
      current_setting('plerni.tenant_id', true) AS tenant_guc,
      current_user, session_user,
      current_setting('search_path') AS search_path,
      pg_backend_pid() AS pid`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new ContextInstallError('session-state read returned no row');
  return row;
}

const absent = (v: string | null) => v === null || v === '';

export function findContamination(s: SessionStateRow): string[] {
  const out: string[] = [];
  if (!absent(s.tenant_guc)) out.push(`GUC plerni.tenant_id session-set to '${s.tenant_guc}'`);
  if (s.current_user !== s.session_user) out.push(`role leaked: current=${s.current_user} session=${s.session_user}`);
  if (s.search_path !== PINNED_SEARCH_PATH) out.push(`search_path '${s.search_path}' != pinned '${PINNED_SEARCH_PATH}'`);
  return out;
}

/** ② + ④: verify-clean then install+verify, on the transaction's pinned backend. */
export async function installTenantContext(trx: Transaction<Db>, tenantId: string, ev: HygieneEvidence): Promise<void> {
  const before = await readSessionState(trx);
  const contamination = findContamination(before);
  if (contamination.length > 0) {
    ev.terminatedBackendPids.push(before.pid);
    ev.alerts.push(`SECURITY contamination on backend ${before.pid}: ${contamination.join('; ')}`);
    // Termination is performed by the PRIVILEGED terminator in withTenant (γ-M1):
    // after a leaked SET ROLE, current_user lacks the privilege to kill this backend
    // ("permission denied to terminate process") — self-termination is impossible for the
    // role class, and the TCP-healthy contaminated client would wedge the pool.
    throw new ContaminationError(JSON.stringify({ pid: before.pid, reasons: contamination }));
  }
  await sql`SELECT set_config('plerni.tenant_id', ${tenantId}, true)`.execute(trx);
  const after = await readSessionState(trx);
  if (after.tenant_guc !== tenantId) {
    throw new ContextInstallError(`readback '${after.tenant_guc}' != authorized '${tenantId}'`);
  }
}

/** The app-layer tenant guard (spec §5): independent of RLS, raises when context is missing. */
export class MissingTenantContextError extends Error {}
export async function assertTenantContext(trx: Transaction<Db>): Promise<void> {
  const s = await readSessionState(trx);
  if (absent(s.tenant_guc)) throw new MissingTenantContextError('plerni.tenant_id not installed');
}

/** Runs `fn` inside one pinned transaction with the full hygiene protocol; bounded retry on contamination. */
export async function withTenant<T>(
  db: Kysely<Db>,
  tenantId: string,
  ev: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>, // privileged path (γ-M1); spike: harness root
  fn: (trx: Transaction<Db>) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    ev.attempts = attempt;
    try {
      return await db.transaction().execute(async (trx) => {
        await installTenantContext(trx, tenantId, ev);
        return fn(trx); // ⑤ tenant access
      });
    } catch (e) {
      if (e instanceof ContaminationError) {
        const pid = Number(JSON.parse(e.message).pid);
        await terminateBackend(pid); // evict the contaminated backend, then retry on a fresh one
        if (attempt > MAX_RETRY) throw new Error(`loud failure: contamination persisted after ${MAX_RETRY} retries`, { cause: e });
        continue;
      }
      // Connection-death class only, classified by SQLSTATE (γ-m1: message matching catches
      // business text like "could not TERMINATE the rows" — never retry those):
      // 57P01 admin_shutdown, 08* connection exceptions, PgBouncer's exact "server conn crashed?".
      const errCode = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
      const msg = e instanceof Error ? e.message : '';
      const isDeath = (typeof errCode === 'string' && (errCode === '57P01' || errCode.startsWith('08')))
        || msg === 'server conn crashed?'
        || msg.startsWith('terminating connection')
        || msg.startsWith('Connection terminated');
      if (isDeath) {
        if (attempt > MAX_RETRY) throw new Error(`loud failure: connection death persisted after ${MAX_RETRY} retries`, { cause: e });
        continue; // fresh connection
      }
      throw e; // real failure — never retried
    }
  }
}
