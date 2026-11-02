// SPDX-License-Identifier: Apache-2.0
// Application tenant guard (spec §5). RLS returning zero rows is the other
// layer. This one raises when the transaction has no tenant context.
import type { Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { MissingTenantContextError } from './errors.ts';
import { readSessionState } from './hygiene.ts';

export async function assertTenantContext(trx: Transaction<Database>): Promise<void> {
  const state = await readSessionState(trx);
  if (state.tenant_guc === null || state.tenant_guc === '') {
    throw new MissingTenantContextError('plerni.tenant_id not installed');
  }
}
