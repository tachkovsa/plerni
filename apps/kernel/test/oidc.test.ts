// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { calculatePKCECodeChallenge } from 'openid-client';
import { errorStatus } from '@plerni/contracts';
import type { Kysely } from 'kysely';
import pg from 'pg';
import type { Database } from '../src/db/database.ts';
import { bootstrapInstallation } from '../src/identity/bootstrap.ts';
import type { IdentityContext } from '../src/identity/context.ts';
import { disableUser } from '../src/identity/disable.ts';
import { SessionRejectedError } from '../src/identity/errors.ts';
import { createIdentityLog } from '../src/identity/log.ts';
import { login } from '../src/identity/login.ts';
import { authenticate } from '../src/identity/session.ts';
import { sha256Hex } from '../src/identity/token.ts';
import { createUser } from '../src/identity/users.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { handleKernelRequest, kernelRequestContext } from '../src/transport/kernel-request.ts';
import { POOLED, ROOT, appDb, ready, terminate } from './support.ts';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  startTestIssuer,
  type TestIssuer,
} from './oidc-issuer.ts';

const here = dirname(fileURLToPath(import.meta.url));

function password(): string {
  return randomBytes(18).toString('hex');
}

function email(label: string): string {
  return `${label}.${randomBytes(3).toString('hex')}@example.com`;
}

class Sink {
  readonly lines: string[] = [];
  readonly log = createIdentityLog((line) => {
    this.lines.push(line);
  });

  text(): string {
    return this.lines.join('\n');
  }
}

function hides(haystack: string, values: readonly string[]): void {
  for (const value of values) assert.equal(haystack.includes(value), false);
}

async function withRoot<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: ROOT });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetOidc(): Promise<void> {
  await withRoot(async (client) => {
    await client.query('DELETE FROM kernel.oidc_link');
    await client.query('DELETE FROM kernel.oidc_login');
    await client.query('DELETE FROM kernel.oidc_provider');
    await client.query('DELETE FROM kernel.password_reset');
    await client.query('DELETE FROM kernel.rescue_code');
    await client.query('DELETE FROM kernel.session');
    await client.query('DELETE FROM kernel.login_throttle');
    await client.query('DELETE FROM kernel.auth_audit');
    await client.query('DELETE FROM kernel.user_auth_state');
    await client.query('DELETE FROM kernel.user_account');
    await client.query('DELETE FROM kernel.tenant_auth_policy');
    await client.query('DELETE FROM kernel.tenant_idempotency');
    await client.query('DELETE FROM kernel.audit_record');
    await client.query('DELETE FROM kernel.outbox');
    await client.query('DELETE FROM kernel.tenants');
    await client.query('UPDATE kernel.bootstrap_state SET consumed_at = NULL');
  });
}

async function withCredential<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
  process.env.PLERNI_BOOTSTRAP_CREDENTIAL = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
    else process.env.PLERNI_BOOTSTRAP_CREDENTIAL = previous;
  }
}

interface World {
  sink: Sink;
  ctx: IdentityContext;
  http: ReturnType<typeof kernelRequestContext>;
  tenantId: string;
  adminToken: string;
}

let issuer: TestIssuer;
let db: Kysely<Database>;
let chain: Promise<void> = Promise.resolve();

function serial(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    await run;
  });
}

before(async () => {
  await ready();
  issuer = await startTestIssuer();
  db = appDb(POOLED, 2);
});

after(async () => {
  await issuer.close();
  await db.destroy();
});

function post(path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://kernel.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function read(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function prepare(): Promise<World> {
  await resetOidc();
  const sink = new Sink();
  const evidence = blankEvidence();
  const ctx: IdentityContext = { evidence, terminate, log: sink.log };
  const credential = password();
  const adminPassword = password();
  const adminEmail = email('customer');
  const installed = await withCredential(credential, () => bootstrapInstallation(db, {
    credential,
    operatorEmail: email('operator'),
    operatorPassword: password(),
    customerEmail: adminEmail,
    customerPassword: adminPassword,
  }, ctx));
  const admin = await login(db, {
    tenantId: installed.customer.tenantId,
    email: adminEmail,
    password: adminPassword,
  }, ctx);
  const http = kernelRequestContext({
    session: { tenantId: installed.customer.tenantId },
    db,
    evidence,
    terminateBackend: terminate,
    log: sink.log,
  });
  const configured = await handleKernelRequest(post('/kernel/oidc', {
    issuer: issuer.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  }, admin.token), http);
  assert.equal(configured.status, 200);
  const body = await read(configured);
  assert.deepEqual(Object.keys(body).sort(), ['clientId', 'issuer', 'redirectUri']);
  assert.equal(body.issuer, issuer.issuer);
  assert.equal(body.redirectUri, REDIRECT_URI);
  hides(JSON.stringify(body), [CLIENT_SECRET]);
  return { sink, ctx, http, tenantId: installed.customer.tenantId, adminToken: admin.token };
}

function cookies() {
  const jar = new Map<string, string>();
  return {
    store(response: Response): void {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';', 1)[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header(): string {
      return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
    },
  };
}

async function follow(start: string): Promise<URL> {
  const jar = cookies();
  let current = start;
  for (let i = 0; i < 12; i += 1) {
    if (current === REDIRECT_URI || current.startsWith(`${REDIRECT_URI}?`)) return new URL(current);
    const headers: Record<string, string> = {};
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const response = await fetch(current, { redirect: 'manual', headers });
    jar.store(response);
    const location = response.headers.get('location');
    if (!location) throw new Error(`issuer status ${response.status}`);
    current = new URL(location, current).href;
  }
  throw new Error('issuer redirects did not end');
}

function watchFetch(): { tokens: string[]; bodies: string[]; restore: () => void } {
  const tokens: string[] = [];
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href).pathname;
    if (pathname === '/token') {
      if (typeof init?.body === 'string') bodies.push(init.body);
      else if (init?.body instanceof URLSearchParams) bodies.push(init.body.toString());
      const payload = await response.clone().json() as { access_token?: unknown; id_token?: unknown };
      if (typeof payload.access_token === 'string') tokens.push(payload.access_token);
      if (typeof payload.id_token === 'string') tokens.push(payload.id_token);
    }
    return response;
  };
  return { tokens, bodies, restore: () => { globalThis.fetch = original; } };
}

async function authorize(world: World, redirectUri = REDIRECT_URI): Promise<Response> {
  world.http.session = null;
  return handleKernelRequest(post('/kernel/oidc/authorizations', {
    tenantId: world.tenantId,
    redirectUri,
  }), world.http);
}

async function callback(world: World, url: URL): Promise<Response> {
  world.http.session = null;
  return handleKernelRequest(new Request(url, { method: 'GET' }), world.http);
}

async function member(world: World, address: string): Promise<{ userId: string; password: string }> {
  const memberPassword = password();
  const created = await createUser(db, {
    tenantId: world.tenantId,
    token: world.adminToken,
  }, { email: address, password: memberPassword }, world.ctx);
  return { userId: created.userId, password: memberPassword };
}

test('configure requires a session and does not run the handler without one', async () => {
  let called = 0;
  const response = await handleKernelRequest(post('/kernel/oidc', {
    issuer: 'https://idp.example.test',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  }), {
    session: null,
    createTenant: async () => { throw new Error('unexpected'); },
    configureOidc: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, errorStatus('UNAUTHENTICATED'));
  const body = await read(response);
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(called, 0);
});

test('oidc sources do not embed the synthetic client secret', () => {
  const dir = join(here, '../src/identity');
  const bodies = readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => readFileSync(join(dir, name), 'utf8'));
  bodies.push(readFileSync(join(here, '../sql/0012_oidc.sql'), 'utf8'));
  bodies.push(readFileSync(join(here, '../src/transport/oidc-request.ts'), 'utf8'));
  for (const body of bodies) {
    assert.equal(body.includes(CLIENT_SECRET), false);
    assert.equal(body.includes('console.'), false);
  }
});

serial('authorization code with PKCE returns a local session and rejects the IdP token', async () => {
  const world = await prepare();
  const address = email('member');
  const userId = (await member(world, address)).userId;
  issuer.account = { id: 'subject-member', email: address, emailVerified: true };
  const started = await authorize(world);
  assert.equal(started.status, 200);
  const startBody = await read(started);
  const authorizationUrl = String(startBody.authorizationUrl);
  const url = new URL(authorizationUrl);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  const state = url.searchParams.get('state') ?? '';
  const row = await withRoot(async (client) => {
    const result = await client.query<{ state_hash: string; code_verifier: string }>(
      `SELECT state_hash, code_verifier FROM kernel.oidc_login
       WHERE tenant_id = $1 AND consumed_at IS NULL`,
      [world.tenantId],
    );
    return result.rows[0];
  });
  assert.ok(row);
  assert.equal(row.state_hash, sha256Hex(state));
  assert.equal(url.searchParams.get('code_challenge'), await calculatePKCECodeChallenge(row.code_verifier));
  hides(authorizationUrl, [CLIENT_SECRET, row.code_verifier]);
  const landed = await follow(authorizationUrl);
  assert.equal(landed.searchParams.get('iss'), issuer.issuer);
  const seen = watchFetch();
  try {
    const finished = await callback(world, landed);
    assert.equal(finished.status, 200);
    const body = await read(finished);
    const token = String(body.token);
    assert.equal(body.userId, userId);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(seen.tokens.length >= 2, true);
    hides(JSON.stringify(body), [CLIENT_SECRET, row.code_verifier, ...seen.tokens]);
    hides(world.sink.text(), [CLIENT_SECRET, row.code_verifier, token, ...seen.tokens]);
    const live = await authenticate(db, { tenantId: world.tenantId, token, routeClass: 'read' }, world.ctx);
    assert.equal(live.userId, userId);
    for (const idpToken of seen.tokens) {
      await assert.rejects(
        () => authenticate(db, { tenantId: world.tenantId, token: idpToken, routeClass: 'read' }, world.ctx),
        (error: unknown) => error instanceof SessionRejectedError,
      );
      world.http.session = { tenantId: world.tenantId };
      const rejected = await handleKernelRequest(post('/kernel/oidc', {
        issuer: issuer.issuer,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      }, idpToken), world.http);
      assert.equal(rejected.status, errorStatus('UNAUTHENTICATED'));
    }
  } finally {
    seen.restore();
  }
});

serial('a redirect that is not exactly the configured URI is rejected', async () => {
  const world = await prepare();
  const mismatched = await authorize(world, `${REDIRECT_URI}/extra`);
  assert.equal(mismatched.status, errorStatus('VALIDATION'));
  const body = await read(mismatched);
  assert.equal(body.code, 'VALIDATION');
  assert.match(String(body.next_step), /exactly/);
  const rows = await withRoot(async (client) => {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM kernel.oidc_login WHERE tenant_id = $1',
      [world.tenantId],
    );
    return result.rows[0]?.count;
  });
  assert.equal(rows, '0');
  const prefixed = await authorize(world, REDIRECT_URI.slice(0, -1));
  assert.equal(prefixed.status, errorStatus('VALIDATION'));
  const exact = await authorize(world);
  assert.equal(exact.status, 200);
  const start = await read(exact);
  assert.equal(new URL(String(start.authorizationUrl)).searchParams.get('redirect_uri'), REDIRECT_URI);
});

serial('a local disable survives a successful IdP login', async () => {
  const world = await prepare();
  const address = email('member');
  const userId = (await member(world, address)).userId;
  await disableUser(db, { tenantId: world.tenantId, token: world.adminToken }, userId, world.ctx);
  const before = await withRoot(async (client) => {
    const result = await client.query<{ disabled_at: string; epoch: string }>(
      `SELECT disabled_at::text AS disabled_at, revocation_epoch::text AS epoch
       FROM kernel.user_auth_state WHERE tenant_id = $1 AND id = $2`,
      [world.tenantId, userId],
    );
    return result.rows[0];
  });
  assert.ok(before?.disabled_at);
  issuer.account = { id: 'subject-disabled', email: address, emailVerified: true };
  const started = await authorize(world);
  assert.equal(started.status, 200);
  const start = await read(started);
  const landed = await follow(String(start.authorizationUrl));
  const seen = watchFetch();
  try {
    const finished = await callback(world, landed);
    assert.equal(finished.status, errorStatus('UNAUTHENTICATED'));
    const body = await read(finished);
    assert.equal(body.code, 'UNAUTHENTICATED');
    assert.equal(seen.tokens.length >= 2, true);
    hides(JSON.stringify(body), [CLIENT_SECRET, ...seen.tokens]);
  } finally {
    seen.restore();
  }
  const after = await withRoot(async (client) => {
    const result = await client.query<{ disabled_at: string; epoch: string; live: string }>(
      `SELECT s.disabled_at::text AS disabled_at,
              s.revocation_epoch::text AS epoch,
              (SELECT count(*) FROM kernel.session
                WHERE tenant_id = s.tenant_id AND user_id = s.id AND revoked_at IS NULL)::text AS live
       FROM kernel.user_auth_state s
       WHERE s.tenant_id = $1 AND s.id = $2`,
      [world.tenantId, userId],
    );
    return result.rows[0];
  });
  assert.equal(after?.disabled_at, before.disabled_at);
  assert.equal(after?.epoch, before.epoch);
  assert.equal(after?.live, '0');
});

serial('state, nonce, PKCE, and issuer mismatches do not create a session', async () => {
  const world = await prepare();
  const address = email('member');
  const userId = (await member(world, address)).userId;
  issuer.account = { id: 'subject-checks', email: address, emailVerified: true };

  async function liveCount(): Promise<string> {
    return withRoot(async (client) => {
      const result = await client.query<{ live: string }>(
        `SELECT count(*)::text AS live FROM kernel.session
         WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [world.tenantId, userId],
      );
      return result.rows[0]?.live ?? '0';
    });
  }

  const badState = await authorize(world);
  const badStateBody = await read(badState);
  const badStateUrl = new URL(String(badStateBody.authorizationUrl));
  const landedState = await follow(badStateUrl.href);
  landedState.searchParams.set('state', `${world.tenantId}.${'a'.repeat(43)}`);
  const stateResult = await callback(world, landedState);
  assert.equal(stateResult.status, errorStatus('UNAUTHENTICATED'));
  assert.equal(await liveCount(), '0');

  const badIss = await authorize(world);
  const badIssBody = await read(badIss);
  const landedIss = await follow(String(badIssBody.authorizationUrl));
  landedIss.searchParams.set('iss', 'http://127.0.0.1:1');
  assert.equal((await callback(world, landedIss)).status, errorStatus('UNAUTHENTICATED'));
  landedIss.searchParams.delete('iss');
  assert.equal((await callback(world, landedIss)).status, errorStatus('UNAUTHENTICATED'));
  assert.equal(await liveCount(), '0');

  const badNonce = await authorize(world);
  const nonceUrl = new URL(String((await read(badNonce)).authorizationUrl));
  await withRoot(async (client) => {
    await client.query(
      `UPDATE kernel.oidc_login SET nonce = $2
       WHERE tenant_id = $1 AND state_hash = $3 AND consumed_at IS NULL`,
      [world.tenantId, 'b'.repeat(43), sha256Hex(nonceUrl.searchParams.get('state') ?? '')],
    );
  });
  const landedNonce = await follow(nonceUrl.href);
  assert.equal((await callback(world, landedNonce)).status, errorStatus('UNAUTHENTICATED'));
  assert.equal(await liveCount(), '0');

  const badPkce = await authorize(world);
  const pkceUrl = new URL(String((await read(badPkce)).authorizationUrl));
  const original = await withRoot(async (client) => {
    const result = await client.query<{ code_verifier: string }>(
      `SELECT code_verifier FROM kernel.oidc_login
       WHERE tenant_id = $1 AND state_hash = $2`,
      [world.tenantId, sha256Hex(pkceUrl.searchParams.get('state') ?? '')],
    );
    return result.rows[0]?.code_verifier ?? '';
  });
  const replacement = `${'c'.repeat(43)}`;
  await withRoot(async (client) => {
    await client.query(
      `UPDATE kernel.oidc_login SET code_verifier = $2
       WHERE tenant_id = $1 AND state_hash = $3`,
      [world.tenantId, replacement, sha256Hex(pkceUrl.searchParams.get('state') ?? '')],
    );
  });
  const landedPkce = await follow(pkceUrl.href);
  const seen = watchFetch();
  try {
    assert.equal((await callback(world, landedPkce)).status, errorStatus('UNAUTHENTICATED'));
    assert.equal(seen.bodies.some((body) => body.includes(replacement)), true);
    assert.equal(seen.bodies.some((body) => body.includes(original)), false);
  } finally {
    seen.restore();
  }
  assert.equal(await liveCount(), '0');
  hides(world.sink.text(), [CLIENT_SECRET, original, replacement]);
});

serial('a member cannot configure OIDC and a closed issuer is unavailable', async () => {
  const world = await prepare();
  const address = email('member');
  const created = await member(world, address);
  const memberLogin = await login(db, {
    tenantId: world.tenantId,
    email: address,
    password: created.password,
  }, world.ctx);
  world.http.session = { tenantId: world.tenantId };
  const remoteHttp = await handleKernelRequest(post('/kernel/oidc', {
    issuer: 'http://idp.example.test',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  }, world.adminToken), world.http);
  assert.equal(remoteHttp.status, errorStatus('VALIDATION'));
  const forbidden = await handleKernelRequest(post('/kernel/oidc', {
    issuer: issuer.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  }, memberLogin.token), world.http);
  assert.equal(forbidden.status, errorStatus('FORBIDDEN'));
  assert.equal((await read(forbidden)).code, 'FORBIDDEN');

  world.http.session = { tenantId: world.tenantId };
  const closed = await handleKernelRequest(post('/kernel/oidc', {
    issuer: 'http://127.0.0.1:1',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  }, world.adminToken), world.http);
  assert.equal(closed.status, 200);
  const unavailable = await authorize(world, REDIRECT_URI);
  assert.equal(unavailable.status, errorStatus('UNAVAILABLE'));
  assert.equal((await read(unavailable)).code, 'UNAVAILABLE');
});
