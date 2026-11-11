// SPDX-License-Identifier: Apache-2.0
// One-time installation bootstrap (plan §5.2, ADR-0010). The credential is
// read from the process environment and compared without being logged or
// stored. The call creates the operator tenant and its admin, then one
// customer tenant and its admin, then marks the credential consumed.
// Switching tenant inside this transaction is the installation itself:
// the registry has no session yet, and a partial commit would leave the
// credential live against a half-built installation. Fan-out stays one
// transaction per tenant after this call.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { installTenantContext, replaceTenantContext, withInspectedTransaction } from '../tenancy/hygiene.ts';
import { insertTenantRow, readOperatorTenant, recordTenantCreated } from '../tenant/registry.ts';
import { canonicalEmail, type IdentityContext } from './context.ts';
import { BootstrapClosedError, BootstrapRejectedError } from './errors.ts';
import { hashPassword } from './password.ts';
import { generateRescueSet } from './rescue.ts';
import { insertAccount, writeAuthAudit } from './store.ts';
import { credentialMatches } from './token.ts';

export interface BootstrapInput {
  credential: string;
  operatorEmail: string;
  operatorPassword: string;
  customerEmail: string;
  customerPassword: string;
}

export interface BootstrapAdmin {
  tenantId: string;
  userId: string;
  rescueCodes: readonly string[];
}

export interface BootstrapResult {
  operator: BootstrapAdmin;
  customer: BootstrapAdmin;
}

export interface BootstrapHooks {
  afterOperator?(trx: Transaction<Database>): Promise<void>;
}

const CUSTOMER_KEY = 'bootstrap';

async function preparedSecrets(input: BootstrapInput): Promise<{
  operatorEmail: string;
  customerEmail: string;
  operatorHash: string;
  customerHash: string;
  operatorRescue: { plaintext: string[]; hashes: string[] };
  customerRescue: { plaintext: string[]; hashes: string[] };
}> {
  const operatorEmail = canonicalEmail(input.operatorEmail);
  const customerEmail = canonicalEmail(input.customerEmail);
  if (operatorEmail === customerEmail) throw new BootstrapRejectedError();
  if (!credentialMatches(input.credential)) throw new BootstrapRejectedError();
  const [operatorHash, customerHash, operatorRescue, customerRescue] = await Promise.all([
    hashPassword(input.operatorPassword),
    hashPassword(input.customerPassword),
    generateRescueSet(),
    generateRescueSet(),
  ]);
  return { operatorEmail, customerEmail, operatorHash, customerHash, operatorRescue, customerRescue };
}

export async function bootstrapInstallation(
  db: Kysely<Database>,
  input: BootstrapInput,
  ctx: IdentityContext,
  hooks: BootstrapHooks = {},
): Promise<BootstrapResult> {
  let secrets: Awaited<ReturnType<typeof preparedSecrets>>;
  try {
    secrets = await preparedSecrets(input);
  } catch (error) {
    if (error instanceof BootstrapRejectedError) {
      ctx.log.event('bootstrap.rejected', { action: 'bootstrap', outcome: 'rejected' });
    }
    throw error;
  }
  try {
    const result = await withInspectedTransaction(db, ctx.evidence, ctx.terminate, async (trx) => {
      const locked = await sql<{ consumed_at: Date | null }>`
        SELECT consumed_at
        FROM kernel.bootstrap_state
        WHERE id
        FOR UPDATE`.execute(trx);
      if (!locked.rows[0]) throw new Error('bootstrap state missing');
      if (locked.rows[0].consumed_at) throw new BootstrapClosedError();
      if (!credentialMatches(input.credential)) throw new BootstrapRejectedError();
      const customers = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM kernel.tenants WHERE kind = 'customer'`.execute(trx);
      if (customers.rows[0]?.count !== '0') throw new BootstrapRejectedError();
      const existing = await readOperatorTenant(trx);
      const operatorId = existing?.id ?? randomUUID();
      if (!existing) await insertTenantRow(trx, operatorId, 'operator');
      await installTenantContext(trx, operatorId, ctx.evidence);
      await assertTenantContext(trx);
      if (!existing) await recordTenantCreated(trx, operatorId, operatorId, 'operator');
      const operatorUserId = await insertAccount(trx, {
        tenantId: operatorId,
        email: secrets.operatorEmail,
        passwordHash: secrets.operatorHash,
        kind: 'admin',
        rescueHashes: secrets.operatorRescue.hashes,
      });
      await writeAuthAudit(trx, {
        tenantId: operatorId,
        action: 'create',
        actorUserId: null,
        targetUserId: operatorUserId,
        sessionHash: null,
        epochBefore: 0,
        epochAfter: 0,
        reason: 'bootstrap',
      });
      if (hooks.afterOperator) await hooks.afterOperator(trx);
      const customerId = randomUUID();
      await insertTenantRow(trx, customerId, 'customer');
      await recordTenantCreated(trx, operatorId, customerId, 'customer');
      const stored = await sql<{ id: string }>`
        INSERT INTO kernel.tenant_idempotency (idempotency_key, tenant_id)
        VALUES (${CUSTOMER_KEY}, ${customerId}::uuid)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING tenant_id::text AS id`.execute(trx);
      if (!stored.rows[0]) throw new BootstrapRejectedError();
      await replaceTenantContext(trx, customerId);
      await assertTenantContext(trx);
      const customerUserId = await insertAccount(trx, {
        tenantId: customerId,
        email: secrets.customerEmail,
        passwordHash: secrets.customerHash,
        kind: 'admin',
        rescueHashes: secrets.customerRescue.hashes,
      });
      await writeAuthAudit(trx, {
        tenantId: customerId,
        action: 'create',
        actorUserId: null,
        targetUserId: customerUserId,
        sessionHash: null,
        epochBefore: 0,
        epochAfter: 0,
        reason: 'bootstrap',
      });
      const consumed = await sql<{ consumed_at: Date }>`
        UPDATE kernel.bootstrap_state
        SET consumed_at = clock_timestamp()
        WHERE id AND consumed_at IS NULL
        RETURNING consumed_at`.execute(trx);
      if (!consumed.rows[0]) throw new BootstrapClosedError();
      return {
        operator: {
          tenantId: operatorId,
          userId: operatorUserId,
          rescueCodes: secrets.operatorRescue.plaintext,
        },
        customer: {
          tenantId: customerId,
          userId: customerUserId,
          rescueCodes: secrets.customerRescue.plaintext,
        },
      };
    });
    ctx.log.event('bootstrap.completed', {
      action: 'bootstrap',
      outcome: 'accepted',
      operatorTenantId: result.operator.tenantId,
      customerTenantId: result.customer.tenantId,
    });
    return result;
  } catch (error) {
    if (error instanceof BootstrapClosedError) {
      ctx.log.event('bootstrap.rejected', { action: 'bootstrap', outcome: 'closed' });
    } else if (error instanceof BootstrapRejectedError) {
      ctx.log.event('bootstrap.rejected', { action: 'bootstrap', outcome: 'rejected' });
    }
    throw error;
  }
}
