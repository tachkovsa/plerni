// SPDX-License-Identifier: Apache-2.0
// Ordered hygiene inside the pinned transaction (ADR-0002 decision 2, ADR-0007):
// begin, inspect before any local override, terminate and discard on
// contamination, set_config(..., true), read back, then tenant access.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { discardPoolerSessions, unblockPool } from '../db/pool.ts';
import { MAX_RETRY, PINNED_SEARCH_PATH } from './constants.ts';
import { ContaminationError, ContextInstallError, MissingTenantContextError } from './errors.ts';

export interface SessionState {
  tenant_guc: string | null;
  current_user: string;
  session_user: string;
  search_path: string;
  pid: number;
}

export interface HygieneEvidence {
  terminatedBackendPids: number[];
  attempts: number;
  alerts: string[];
  /** Pooler client sockets closed so a tracked parameter cannot be replayed. */
  discardedPoolerSessions: number;
}

export function blankEvidence(): HygieneEvidence {
  return { terminatedBackendPids: [], attempts: 0, alerts: [], discardedPoolerSessions: 0 };
}

const absent = (value: string | null): boolean => value === null || value === '';

/** A blank id would install '' and the read-back would accept it. RLS treats that as no context. */
export function rejectBlankTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new MissingTenantContextError('plerni.tenant_id not installed');
  }
}

export function findContamination(state: SessionState): string[] {
  const reasons: string[] = [];
  if (!absent(state.tenant_guc)) {
    reasons.push(`GUC plerni.tenant_id session-set to '${state.tenant_guc}'`);
  }
  if (state.current_user !== state.session_user) {
    reasons.push(`role leaked: current=${state.current_user} session=${state.session_user}`);
  }
  if (state.search_path !== PINNED_SEARCH_PATH) {
    reasons.push(`search_path '${state.search_path}' != pinned '${PINNED_SEARCH_PATH}'`);
  }
  return reasons;
}

export async function readSessionState(trx: Transaction<Database>): Promise<SessionState> {
  const result = await sql<SessionState>`SELECT
      current_setting('plerni.tenant_id', true) AS tenant_guc,
      current_user, session_user,
      current_setting('search_path') AS search_path,
      pg_backend_pid() AS pid`.execute(trx);
  const row = result.rows[0];
  if (!row) throw new ContextInstallError('session-state read returned no row');
  return {
    tenant_guc: row.tenant_guc,
    current_user: row.current_user,
    session_user: row.session_user,
    search_path: row.search_path,
    pid: Number(row.pid),
  };
}

/** Inspect, then install and read back, on the transaction's pinned backend. */
export async function installTenantContext(
  trx: Transaction<Database>,
  tenantId: string,
  evidence: HygieneEvidence,
): Promise<void> {
  rejectBlankTenantId(tenantId);
  const before = await readSessionState(trx);
  const contamination = findContamination(before);
  if (contamination.length > 0) {
    evidence.alerts.push(`SECURITY contamination on backend ${before.pid}: ${contamination.join('; ')}`);
    throw new ContaminationError(JSON.stringify({ pid: before.pid, reasons: contamination }));
  }
  await sql`SELECT set_config('plerni.tenant_id', ${tenantId}, true)`.execute(trx);
  const after = await readSessionState(trx);
  if (after.tenant_guc !== tenantId) {
    throw new ContextInstallError(`readback '${after.tenant_guc}' != authorized '${tenantId}'`);
  }
}

function isConnectionDeath(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : '';
  return (typeof code === 'string' && (code === '57P01' || code.startsWith('08')))
    || message === 'server conn crashed?'
    || message.startsWith('terminating connection')
    || message.startsWith('Connection terminated')
    || message === 'Client has encountered a connection error and is not queryable'
    || message === 'Client was closed and is not queryable';
}

export async function withTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  rejectBlankTenantId(tenantId);
  for (let attempt = 1; ; attempt += 1) {
    evidence.attempts = attempt;
    const terminatedBefore = evidence.terminatedBackendPids.length;
    try {
      return await db.transaction().execute(async (trx) => {
        try {
          await installTenantContext(trx, tenantId, evidence);
        } catch (error) {
          if (error instanceof ContaminationError) {
            const pid = Number(JSON.parse(error.message).pid);
            let confirmed = false;
            try {
              await terminateBackend(pid);
              confirmed = true;
            } catch (termError) {
              unblockPool(db);
              throw new Error(`contaminated backend ${pid} was not confirmed dead`, { cause: termError });
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
            evidence.terminatedBackendPids.push(pid);
            evidence.discardedPoolerSessions += discardPoolerSessions(db);
          }
          throw error;
        }
        return fn(trx);
      });
    } catch (error) {
      const killedThisAttempt = evidence.terminatedBackendPids.length > terminatedBefore;
      if (killedThisAttempt && (error instanceof ContaminationError || isConnectionDeath(error))) {
        if (attempt > MAX_RETRY) {
          const kind = error instanceof ContaminationError ? 'contamination' : 'connection death';
          throw new Error(`loud failure: ${kind} persisted after ${MAX_RETRY} retries`, { cause: error });
        }
        continue;
      }
      throw error;
    }
  }
}
