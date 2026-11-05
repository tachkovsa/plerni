// SPDX-License-Identifier: Apache-2.0
// SET LOCAL ROLE after hygiene, then a transaction-local search_path
// (ADR-0008 decision 3). The statement after commit measures whether
// PgBouncer replayed search_path or the role. A replay discards the pooler
// session (ADR-0007). It is not a reason to hand the plugin a connection.
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { discardPoolerSessions, sharePool } from '../db/pool.ts';
import { PINNED_SEARCH_PATH } from '../tenancy/constants.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import {
  executeTenantTransaction,
  readSessionState,
  rejectBlankTenantId,
  retryContaminated,
  type HygieneEvidence,
} from '../tenancy/hygiene.ts';
import { PluginPackageError } from './errors.ts';
import { pluginRoleName, pluginSchemaName, quoteIdent } from './ident.ts';

export interface RoleReplayMeasurement {
  afterSearchPath: string;
  afterUser: string;
  afterSessionUser: string;
  replayed: boolean;
}

const replays = new WeakMap<HygieneEvidence, RoleReplayMeasurement>();

export function roleReplay(evidence: HygieneEvidence): RoleReplayMeasurement | undefined {
  return replays.get(evidence);
}

export function isReplayedSession(state: {
  search_path: string;
  current_user: string;
  session_user: string;
}): boolean {
  return state.search_path !== PINNED_SEARCH_PATH || state.current_user !== state.session_user;
}

/** Discard only when the probe saw a replay. A discard of zero sockets fails loud. */
export function applyReplayDecision(
  replayed: boolean,
  evidence: HygieneEvidence,
  discard: () => number,
): number {
  if (!replayed) return 0;
  const closed = discard();
  evidence.discardedPoolerSessions += closed;
  evidence.alerts.push('SECURITY pooled parameter replay after plugin role switch');
  if (closed < 1) throw new PluginPackageError('pooled replay was not discarded');
  return closed;
}

async function observeReplay(
  pinned: Kysely<Database>,
  evidence: HygieneEvidence,
  pool: Kysely<Database>,
): Promise<void> {
  const probe = await sql<{
    search_path: string;
    current_user: string;
    session_user: string;
  }>`SELECT current_setting('search_path') AS search_path, current_user, session_user`.execute(pinned);
  const row = probe.rows[0];
  if (!row) throw new PluginPackageError('role replay probe returned no row');
  const replayed = isReplayedSession(row);
  replays.set(evidence, {
    afterSearchPath: row.search_path,
    afterUser: row.current_user,
    afterSessionUser: row.session_user,
    replayed,
  });
  applyReplayDecision(replayed, evidence, () => discardPoolerSessions(pool));
}

async function inPinnedTransaction<T>(
  db: Kysely<Database>,
  tenantId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  rejectBlankTenantId(tenantId);
  // The retry must check out again. A loop inside one connection().execute
  // would rerun the transaction on the backend that hygiene just terminated.
  return retryContaminated(evidence, () => db.connection().execute(async (pinned) => {
    sharePool(pinned, db);
    const value = await executeTenantTransaction(pinned, tenantId, evidence, terminateBackend, fn);
    await observeReplay(pinned, evidence, db);
    return value;
  }));
}

/** Switch role and pin search_path. Caller SQL runs only after both succeed. */
export async function installPluginRole(trx: Transaction<Database>, pluginId: string): Promise<void> {
  const role = pluginRoleName(pluginId);
  const searchPath = `${pluginSchemaName(pluginId)}, pg_catalog`;
  await sql.raw(`SET LOCAL ROLE ${quoteIdent(role)}`).execute(trx);
  await sql`SELECT set_config('search_path', ${searchPath}, true)`.execute(trx);
  const state = await readSessionState(trx);
  if (state.current_user !== role || state.session_user === role) {
    throw new PluginPackageError('plugin role was not installed for this transaction');
  }
  if (state.search_path !== searchPath) {
    throw new PluginPackageError('plugin search_path was not installed');
  }
}

export async function withPluginRole<T>(
  db: Kysely<Database>,
  tenantId: string,
  pluginId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return inPinnedTransaction(db, tenantId, evidence, terminateBackend, async (trx) => {
    await assertTenantContext(trx);
    await installPluginRole(trx, pluginId);
    return fn(trx);
  });
}

export { inPinnedTransaction };
