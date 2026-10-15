// context.ts — the ordered connection-hygiene protocol, verbatim from plan §2.
// ① BEGIN → ② inspect named session state BEFORE any local override (current_setting then
//   returns the session value; after a local override it would be masked) — named plerni.* GUCs
//   (normalize '' as absent: a warm backend reads back '' after a local-only set) plus
//   current_user = session_user (a leaked session-level SET ROLE survives transaction-mode
//   pooling) plus search_path equals the pinned value → ③ contamination: the privileged
//   terminator kills that backend before this checkout is released (a waiter must not be
//   handed the contaminated session), security alert, bounded retry ≤2 on a fresh
//   connection, then loud failure → ④ clean:
//   set_config('plerni.tenant_id', tenant, true) + readback must equal the authorized tenant →
// ⑤ tenant access.
import { sql, type Kysely, type Transaction } from 'kysely';
import { unblockPool, type Db } from './client.ts';

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
    ev.alerts.push(`SECURITY contamination on backend ${before.pid}: ${contamination.join('; ')}`);
    // The privileged terminator runs in withTenant before the checkout is released (γ-M1):
    // after a leaked SET ROLE, current_user cannot kill this backend. Self-termination is
    // not available to the role class.
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

function isConnectionDeath(e: unknown): boolean {
  // SQLSTATE only, plus the driver's exact death texts (γ-m1: a business message such as
  // "could not TERMINATE the rows" must not retry). 57P01 admin_shutdown, 08* connection
  // exceptions, PgBouncer's "server conn crashed?".
  const errCode = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
  const msg = e instanceof Error ? e.message : '';
  return (typeof errCode === 'string' && (errCode === '57P01' || errCode.startsWith('08')))
    || msg === 'server conn crashed?'
    || msg.startsWith('terminating connection')
    || msg.startsWith('Connection terminated')
    // The driver refuses a further query once the socket has already failed. That is this checkout dying.
    || msg === 'Client has encountered a connection error and is not queryable'
    || msg === 'Client was closed and is not queryable';
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
    const terminatedBefore = ev.terminatedBackendPids.length;
    try {
      return await db.transaction().execute(async (trx) => {
        try {
          await installTenantContext(trx, tenantId, ev);
        } catch (e) {
          if (e instanceof ContaminationError) {
            const pid = Number(JSON.parse(e.message).pid);
            // Kill before this callback returns. transaction().execute releases the
            // checkout in a finally, and a waiter queued on a size-1 pool would otherwise
            // take the contaminated session. The pid is recorded only after the
            // terminator returns and a follow-up query fails. A terminator error is not
            // a confirmed kill: drop the sockets and fail, so the retry cannot treat a
            // still-live checkout as connection death.
            let confirmed = false;
            try {
              await terminateBackend(pid);
              confirmed = true;
            } catch (termErr) {
              unblockPool(db);
              throw new Error(`contaminated backend ${pid} was not confirmed dead`, { cause: termErr });
            }
            let alive = true;
            try {
              await sql`SELECT 1`.execute(trx);
              alive = true;
            } catch {
              alive = false;
            }
            if (!confirmed || alive) {
              unblockPool(db);
              throw new Error(`contaminated backend ${pid} accepted a query after terminate`);
            }
            ev.terminatedBackendPids.push(pid);
          }
          throw e;
        }
        return fn(trx); // ⑤ tenant access
      });
    } catch (e) {
      // A connection death retries only after this attempt confirmed the backend was gone.
      // The pid is appended only then. Rollback on that killed backend hides ContaminationError
      // behind the driver's death text. A clean attempt, or a terminator that did not confirm
      // the kill, is not rerun.
      const killedThisAttempt = ev.terminatedBackendPids.length > terminatedBefore;
      if (killedThisAttempt && (e instanceof ContaminationError || isConnectionDeath(e))) {
        if (attempt > MAX_RETRY) {
          const kind = e instanceof ContaminationError ? 'contamination' : 'connection death';
          throw new Error(`loud failure: ${kind} persisted after ${MAX_RETRY} retries`, { cause: e });
        }
        continue;
      }
      throw e; // real failure — never retried
    }
  }
}
