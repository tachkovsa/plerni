// SPDX-License-Identifier: Apache-2.0
// Directory calls run as the broker inside the tenant transaction (ADR-0008).
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { readSessionState, withTenant, type HygieneEvidence } from '../tenancy/hygiene.ts';
import { assertTenantId, brokerForbidden } from './errors.ts';

export async function brokerTenant(trx: Transaction<Database>): Promise<string> {
  await assertTenantContext(trx);
  const state = await readSessionState(trx);
  if (state.current_user !== state.session_user || state.tenant_guc === null || state.tenant_guc === '') {
    throw brokerForbidden();
  }
  return assertTenantId(state.tenant_guc);
}

export async function inDirectory<T>(
  db: Kysely<Database>,
  tenantId: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  fn: (trx: Transaction<Database>, tenantId: string) => Promise<T>,
): Promise<T> {
  const tenant = assertTenantId(tenantId);
  return withTenant(db, tenant, evidence, terminateBackend, async (trx) => {
    const installed = await brokerTenant(trx);
    return fn(trx, installed);
  });
}
