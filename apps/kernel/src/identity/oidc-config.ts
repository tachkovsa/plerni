// SPDX-License-Identifier: Apache-2.0
// One OIDC issuer per tenant. Replacing it drops in-flight logins.
// The client secret is written and never returned.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalUuid, leaseOf, type IdentityContext } from './context.ts';
import { IdentityForbiddenError } from './errors.ts';
import { exactClientId, exactIssuer, exactRedirect, exactSecret } from './oidc-url.ts';
import { requireSession } from './session.ts';
import { writeAuthAudit } from './store.ts';

export interface OidcConfigInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OidcConfigView {
  issuer: string;
  clientId: string;
  redirectUri: string;
}

export async function configureOidc(
  db: Kysely<Database>,
  actor: { tenantId: string; token: string },
  input: OidcConfigInput,
  ctx: IdentityContext,
): Promise<OidcConfigView> {
  const tenantId = canonicalUuid(actor.tenantId);
  const issuer = exactIssuer(input.issuer);
  const clientId = exactClientId(input.clientId);
  const clientSecret = exactSecret(input.clientSecret);
  const redirectUri = exactRedirect(input.redirectUri);
  const userId = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const admin = await requireSession(trx, tenantId, actor.token, 'sensitive', leaseOf(ctx));
    if (admin.sessionKind !== 'admin') throw new IdentityForbiddenError();
    await sql`DELETE FROM kernel.oidc_login WHERE tenant_id = ${tenantId}::uuid`.execute(trx);
    await sql`DELETE FROM kernel.oidc_provider WHERE tenant_id = ${tenantId}::uuid`.execute(trx);
    await sql`
      INSERT INTO kernel.oidc_provider (tenant_id, id, issuer, client_id, client_secret, redirect_uri)
      VALUES (
        ${tenantId}::uuid,
        ${randomUUID()}::uuid,
        ${issuer},
        ${clientId},
        ${clientSecret},
        ${redirectUri}
      )`.execute(trx);
    await writeAuthAudit(trx, {
      tenantId,
      action: 'oidc_configure',
      actorUserId: admin.userId,
      targetUserId: admin.userId,
      sessionHash: admin.tokenHash,
      epochBefore: admin.epoch,
      epochAfter: admin.epoch,
      reason: 'admin',
    });
    return admin.userId;
  });
  ctx.log.event('oidc.configure', {
    tenantId,
    userId,
    action: 'oidc_configure',
    outcome: 'accepted',
  });
  return { issuer, clientId, redirectUri };
}
