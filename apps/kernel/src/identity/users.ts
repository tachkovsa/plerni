// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import {
  canonicalEmail,
  canonicalUuid,
  leaseOf,
  type AccountKind,
  type IdentityContext,
} from './context.ts';
import { IdentityForbiddenError } from './errors.ts';
import { hashPassword } from './password.ts';
import { generateRescueSet } from './rescue.ts';
import { requireSession } from './session.ts';
import { insertAccount, writeAuthAudit } from './store.ts';

export interface CreatedAccount {
  userId: string;
  rescueCodes: readonly string[];
}

async function requireAdmin(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  ctx: IdentityContext,
): Promise<{ tenantId: string; userId: string }> {
  const tenantId = canonicalUuid(actor.tenantId);
  return withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const live = await requireSession(trx, tenantId, actor.token, 'sensitive', leaseOf(ctx));
    if (live.sessionKind !== 'admin') throw new IdentityForbiddenError();
    return { tenantId, userId: live.userId };
  });
}

export async function createUser(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  input: { email: string; password: string; kind?: AccountKind },
  ctx: IdentityContext,
): Promise<CreatedAccount> {
  const admin = await requireAdmin(db, actor, ctx);
  const email = canonicalEmail(input.email);
  const kind = input.kind ?? 'member';
  const passwordHash = await hashPassword(input.password);
  const rescue = await generateRescueSet();
  const userId = await withTenant(db, admin.tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const again = await requireSession(trx, admin.tenantId, actor.token, 'sensitive', leaseOf(ctx));
    if (again.sessionKind !== 'admin') throw new IdentityForbiddenError();
    const id = await insertAccount(trx, {
      tenantId: admin.tenantId,
      email,
      passwordHash,
      kind,
      rescueHashes: rescue.hashes,
    });
    await writeAuthAudit(trx, {
      tenantId: admin.tenantId,
      action: 'create',
      actorUserId: again.userId,
      targetUserId: id,
      sessionHash: again.tokenHash,
      epochBefore: 0,
      epochAfter: 0,
      reason: 'admin',
    });
    return id;
  });
  ctx.log.event('account.create', { tenantId: admin.tenantId, userId, action: 'create' });
  return { userId, rescueCodes: rescue.plaintext };
}

export async function setStrictDisable(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  strictDisable: boolean,
  ctx: IdentityContext,
): Promise<void> {
  const admin = await requireAdmin(db, actor, ctx);
  await withTenant(db, admin.tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const again = await requireSession(trx, admin.tenantId, actor.token, 'sensitive', leaseOf(ctx));
    if (again.sessionKind !== 'admin') throw new IdentityForbiddenError();
    await sql`
      INSERT INTO kernel.tenant_auth_policy (tenant_id, id, strict_disable)
      VALUES (${admin.tenantId}::uuid, ${randomUUID()}::uuid, ${strictDisable})
      ON CONFLICT (tenant_id) DO UPDATE SET strict_disable = ${strictDisable}`.execute(trx);
  });
  ctx.log.event('auth.policy', { tenantId: admin.tenantId, outcome: 'accepted' });
}
