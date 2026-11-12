// SPDX-License-Identifier: Apache-2.0
// Authorization code with PKCE S256, state, nonce, and the issuer parameter.
// A local disable is left in place. The IdP token is not stored or returned.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { assertTenantContext } from '../tenancy/guard.ts';
import { withTenant } from '../tenancy/hygiene.ts';
import { canonicalEmail, canonicalUuid, type AccountKind, type IdentityContext } from './context.ts';
import { AccountDisabledError, IdentityNotFoundError, IdentityValidationError, LoginRejectedError } from './errors.ts';
import { assertOpaque, authorizationUrl, newNonce, newPkce, redeemCode, type OidcClaims } from './oidc-client.ts';
import { callbackMatches, exactRedirect } from './oidc-url.ts';
import { asEpoch, insertSession, lifetimeFor, writeAuthAudit } from './store.ts';
import { sha256Hex, newSecretToken } from './token.ts';

const STATE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export interface OidcAuthorization {
  authorizationUrl: string;
}

export interface OidcSession {
  token: string;
  userId: string;
  sessionKind: AccountKind;
}

interface StoredProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function stateFor(tenantId: string): string {
  return `${tenantId}.${randomBytes(32).toString('base64url')}`;
}

function tenantFromState(state: string): string {
  const match = STATE.exec(state);
  const tenantId = match?.[1];
  if (!tenantId) throw new LoginRejectedError();
  return tenantId;
}

async function loadProvider(
  db: Kysely<Database>,
  tenantId: string,
  ctx: IdentityContext,
): Promise<StoredProvider | null> {
  return withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const found = await sql<{
      issuer: string;
      client_id: string;
      client_secret: string;
      redirect_uri: string;
    }>`
      SELECT issuer, client_id, client_secret, redirect_uri
      FROM kernel.oidc_provider
      WHERE tenant_id = ${tenantId}::uuid`.execute(trx);
    const row = found.rows[0];
    if (!row) return null;
    return {
      issuer: row.issuer,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      redirectUri: row.redirect_uri,
    };
  });
}

export async function startOidc(
  db: Kysely<Database>,
  input: { tenantId: string; redirectUri: string },
  ctx: IdentityContext,
): Promise<OidcAuthorization> {
  const tenantId = canonicalUuid(input.tenantId);
  const redirectUri = exactRedirect(input.redirectUri);
  const provider = await loadProvider(db, tenantId, ctx);
  if (!provider) throw new IdentityNotFoundError();
  if (redirectUri !== provider.redirectUri) throw new IdentityValidationError('redirect rejected');
  const state = stateFor(tenantId);
  const nonce = assertOpaque(newNonce());
  const pkce = newPkce();
  const codeChallenge = assertOpaque(await pkce.challenge);
  const verifier = assertOpaque(pkce.verifier);
  const url = await authorizationUrl({
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    redirectUri,
    state,
    nonce,
    codeChallenge,
  });
  if (url.searchParams.get('redirect_uri') !== redirectUri) throw new LoginRejectedError();
  if (url.searchParams.get('code_challenge_method') !== 'S256') throw new LoginRejectedError();
  if (url.searchParams.get('code_challenge') !== codeChallenge) throw new LoginRejectedError();
  await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    await sql`
      INSERT INTO kernel.oidc_login (
        tenant_id, id, state_hash, nonce, code_verifier, redirect_uri, expires_at
      ) VALUES (
        ${tenantId}::uuid,
        ${randomUUID()}::uuid,
        ${sha256Hex(state)},
        ${nonce},
        ${verifier},
        ${redirectUri},
        clock_timestamp() + make_interval(mins => 10)
      )`.execute(trx);
  });
  ctx.log.event('oidc.authorize', { tenantId, action: 'login', outcome: 'accepted' });
  return { authorizationUrl: url.href };
}

interface TakenLogin {
  verifier: string;
  nonce: string;
  state: string;
}

async function takeLogin(
  db: Kysely<Database>,
  tenantId: string,
  state: string,
  redirectUri: string,
  ctx: IdentityContext,
): Promise<TakenLogin | null> {
  return withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const found = await sql<{ id: string; nonce: string; redirect_uri: string; code_verifier: string }>`
      SELECT id::text AS id, nonce, redirect_uri, code_verifier
      FROM kernel.oidc_login
      WHERE tenant_id = ${tenantId}::uuid
        AND state_hash = ${sha256Hex(state)}
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      FOR UPDATE`.execute(trx);
    const row = found.rows[0];
    if (!row || row.redirect_uri !== redirectUri || !row.code_verifier) return null;
    const consumed = await sql<{ id: string }>`
      UPDATE kernel.oidc_login
      SET consumed_at = clock_timestamp(), code_verifier = NULL
      WHERE tenant_id = ${tenantId}::uuid AND id = ${row.id}::uuid AND consumed_at IS NULL
      RETURNING id::text AS id`.execute(trx);
    if (!consumed.rows[0]) return null;
    return { verifier: row.code_verifier, nonce: row.nonce, state };
  });
}

async function openSession(
  db: Kysely<Database>,
  tenantId: string,
  provider: StoredProvider,
  claims: OidcClaims,
  ctx: IdentityContext,
): Promise<OidcSession> {
  const opened = await withTenant(db, tenantId, ctx.evidence, ctx.terminate, async (trx) => {
    await assertTenantContext(trx);
    const linked = await sql<{ user_id: string }>`
      SELECT user_id::text AS user_id
      FROM kernel.oidc_link
      WHERE tenant_id = ${tenantId}::uuid
        AND issuer = ${provider.issuer}
        AND subject = ${claims.subject}`.execute(trx);
    let userId = linked.rows[0]?.user_id ?? null;
    if (!userId) {
      if (!claims.emailVerified || !claims.email) throw new LoginRejectedError();
      let email: string;
      try {
        email = canonicalEmail(claims.email);
      } catch {
        throw new LoginRejectedError();
      }
      const accounts = await sql<{ id: string }>`
        SELECT id::text AS id
        FROM kernel.user_account
        WHERE tenant_id = ${tenantId}::uuid AND email = ${email}`.execute(trx);
      const account = accounts.rows[0];
      if (!account || accounts.rows.length !== 1) throw new LoginRejectedError();
      const taken = await sql<{ id: string }>`
        SELECT id::text AS id FROM kernel.oidc_link
        WHERE tenant_id = ${tenantId}::uuid AND user_id = ${account.id}::uuid`.execute(trx);
      if (taken.rows[0]) throw new LoginRejectedError();
      userId = account.id;
    }
    const state = await sql<{ epoch: string; disabled: boolean; kind: string }>`
      SELECT s.revocation_epoch::text AS epoch,
             (s.disabled_at IS NOT NULL) AS disabled,
             u.kind
      FROM kernel.user_account u
      JOIN kernel.user_auth_state s ON s.tenant_id = u.tenant_id AND s.id = u.id
      WHERE u.tenant_id = ${tenantId}::uuid AND u.id = ${userId}::uuid`.execute(trx);
    const account = state.rows[0];
    if (!account || (account.kind !== 'admin' && account.kind !== 'member')) throw new LoginRejectedError();
    const kind: AccountKind = account.kind;
    const epoch = asEpoch(account.epoch);
    if (account.disabled) {
      await writeAuthAudit(trx, {
        tenantId,
        action: 'login_rejected',
        actorUserId: null,
        targetUserId: userId,
        sessionHash: null,
        epochBefore: epoch,
        epochAfter: epoch,
        reason: 'disabled',
      });
      return { disabled: true as const };
    }
    if (!linked.rows[0]) {
      await sql`
        INSERT INTO kernel.oidc_link (tenant_id, id, user_id, issuer, subject)
        VALUES (
          ${tenantId}::uuid,
          ${randomUUID()}::uuid,
          ${userId}::uuid,
          ${provider.issuer},
          ${claims.subject}
        )`.execute(trx);
    }
    const token = newSecretToken();
    await insertSession(trx, {
      tenantId,
      userId,
      tokenHash: sha256Hex(token),
      kind,
      epoch,
      lifetime: lifetimeFor(kind),
    });
    await writeAuthAudit(trx, {
      tenantId,
      action: 'login',
      actorUserId: userId,
      targetUserId: userId,
      sessionHash: sha256Hex(token),
      epochBefore: epoch,
      epochAfter: epoch,
      reason: 'oidc',
      decisionBasis: 'idp-confirmed',
    });
    return { disabled: false as const, token, userId, sessionKind: kind };
  });
  if (opened.disabled) {
    ctx.log.event('oidc.login', { tenantId, action: 'login', outcome: 'disabled' });
    throw new AccountDisabledError();
  }
  ctx.log.event('oidc.login', { tenantId, userId: opened.userId, action: 'login', outcome: 'accepted' });
  return { token: opened.token, userId: opened.userId, sessionKind: opened.sessionKind };
}

export async function finishOidc(
  db: Kysely<Database>,
  currentUrl: URL,
  ctx: IdentityContext,
): Promise<OidcSession> {
  const state = currentUrl.searchParams.get('state') ?? '';
  const tenantId = tenantFromState(state);
  const provider = await loadProvider(db, tenantId, ctx);
  if (!provider) throw new LoginRejectedError();
  const iss = currentUrl.searchParams.get('iss');
  if (iss !== provider.issuer || !callbackMatches(provider.redirectUri, currentUrl)) {
    throw new LoginRejectedError();
  }
  const taken = await takeLogin(db, tenantId, state, provider.redirectUri, ctx);
  if (!taken) throw new LoginRejectedError();
  const claims = await redeemCode({
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    currentUrl,
    codeVerifier: taken.verifier,
    expectedState: taken.state,
    expectedNonce: taken.nonce,
    expectedIssuer: provider.issuer,
  });
  if (claims.issuer !== provider.issuer) throw new LoginRejectedError();
  return openSession(db, tenantId, provider, claims, ctx);
}
