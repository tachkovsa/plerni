// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { errorStatus, kernelNotificationSend, kernelRoutes } from '@plerni/contracts';
import pg from 'pg';
import { bootstrapInstallation } from '../src/identity/bootstrap.ts';
import type { IdentityContext } from '../src/identity/context.ts';
import { createIdentityLog } from '../src/identity/log.ts';
import { login } from '../src/identity/login.ts';
import { createUser } from '../src/identity/users.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { handleKernelRequest, kernelRequestContext } from '../src/transport/kernel-request.ts';
import { POOLED, ROOT, appDb, ready, terminate } from './support.ts';

function secret(): string {
  return randomBytes(18).toString('hex');
}

function email(label: string): string {
  return `${label}.${randomBytes(3).toString('hex')}@example.com`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function request(path: string, body?: unknown, method = 'POST', token?: string): Request {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (Object.keys(headers).length > 0) init.headers = headers;
  return new Request(`http://kernel.test${path}`, init);
}

async function read(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
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

async function resetRows(): Promise<void> {
  await withRoot(async (client) => {
    const present = await client.query<{ relname: string }>(
      `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kernel' AND c.relname = 'service_principal'`,
    );
    if (present.rows[0]) {
      await client.query('DELETE FROM kernel.service_credential');
      await client.query('DELETE FROM kernel.service_principal_scope');
      await client.query('DELETE FROM kernel.service_principal');
    }
    await client.query('DELETE FROM kernel.notification_delivery');
    await client.query('DELETE FROM kernel.notification_preference');
    await client.query('DELETE FROM kernel.password_reset');
    await client.query('DELETE FROM kernel.rescue_code');
    await client.query('DELETE FROM kernel.session');
    await client.query('DELETE FROM kernel.login_throttle');
    await client.query('DELETE FROM kernel.auth_audit');
    await client.query('DELETE FROM kernel.user_auth_state');
    await client.query('DELETE FROM kernel.user_account');
    await client.query('DELETE FROM kernel.tenant_auth_policy');
    await client.query('DELETE FROM kernel.quota_warning');
    await client.query('DELETE FROM kernel.package_enablement');
    await client.query('DELETE FROM kernel.tenant_idempotency');
    await client.query('DELETE FROM kernel.audit_record');
    await client.query('DELETE FROM kernel.outbox');
    await client.query('DELETE FROM kernel.tenants');
    await client.query('UPDATE kernel.bootstrap_state SET consumed_at = NULL');
  });
}

function hides(haystack: string, values: readonly string[]): void {
  for (const value of values) {
    assert.equal(value.length > 0 && haystack.includes(value), false);
  }
}

test('principal suite: provision, call a routine route, rotate, and revoke', async () => {
  assert.equal(kernelNotificationSend.action, 'routine');
  const provisionRoute = kernelRoutes.find((route) => route.operationId === 'kernel.service_principal.provision');
  const rotateRoute = kernelRoutes.find((route) => route.operationId === 'kernel.service_principal.rotate');
  const revokeRoute = kernelRoutes.find((route) => route.operationId === 'kernel.service_principal.revoke');
  assert.equal(provisionRoute?.method, 'post');
  assert.equal(provisionRoute?.action, 'sensitive');
  assert.equal(provisionRoute?.scope, 'tenant');
  assert.equal(rotateRoute?.action, 'sensitive');
  assert.equal(revokeRoute?.action, 'sensitive');

  await ready();
  await resetRows();
  const credential = secret();
  const operatorPassword = secret();
  const customerPassword = secret();
  const memberPassword = secret();
  const operatorEmail = email('operator');
  const customerEmail = email('customer');
  const memberEmail = email('member');
  const sink = new Sink();
  const ctx: IdentityContext = { evidence: blankEvidence(), terminate, log: sink.log };
  const db = appDb(POOLED, 1);
  const hidden = [credential, operatorPassword, customerPassword, memberPassword];
  try {
    const previous = process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
    process.env.PLERNI_BOOTSTRAP_CREDENTIAL = credential;
    const installed = await bootstrapInstallation(db, {
      credential,
      operatorEmail,
      operatorPassword,
      customerEmail,
      customerPassword,
    }, ctx).finally(() => {
      if (previous === undefined) delete process.env.PLERNI_BOOTSTRAP_CREDENTIAL;
      else process.env.PLERNI_BOOTSTRAP_CREDENTIAL = previous;
    });
    hidden.push(...installed.operator.rescueCodes, ...installed.customer.rescueCodes);

    const admin = await login(db, {
      tenantId: installed.customer.tenantId,
      email: customerEmail,
      password: customerPassword,
    }, ctx);
    const operator = await login(db, {
      tenantId: installed.operator.tenantId,
      email: operatorEmail,
      password: operatorPassword,
    }, ctx);
    hidden.push(admin.token, operator.token);
    const member = await createUser(db, {
      tenantId: installed.customer.tenantId,
      token: admin.token,
    }, { email: memberEmail, password: memberPassword, kind: 'member' }, ctx);
    hidden.push(...member.rescueCodes);
    const memberSession = await login(db, {
      tenantId: installed.customer.tenantId,
      email: memberEmail,
      password: memberPassword,
    }, ctx);
    hidden.push(memberSession.token);

    const http = kernelRequestContext({
      session: { tenantId: installed.customer.tenantId },
      db,
      evidence: blankEvidence(),
      terminateBackend: terminate,
      log: sink.log,
    });
    const tenant = installed.customer.tenantId;
    const past = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, 'POST', admin.token), http);
    assert.equal(past.status, errorStatus('VALIDATION'));
    assert.equal((await read(past)).code, 'VALIDATION');

    const tooFar = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send'],
      expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString(),
    }, 'POST', admin.token), http);
    assert.equal(tooFar.status, errorStatus('VALIDATION'));

    const undeclaredName = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['not_a_grant'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, 'POST', admin.token), http);
    assert.equal(undeclaredName.status, errorStatus('VALIDATION'));

    const duplicate = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send', 'notify.send'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, 'POST', admin.token), http);
    assert.equal(duplicate.status, errorStatus('VALIDATION'));

    const memberCall = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, 'POST', memberSession.token), http);
    assert.equal(memberCall.status, errorStatus('FORBIDDEN'));
    assert.equal((await read(memberCall)).code, 'FORBIDDEN');

    const otherTenant = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }, 'POST', admin.token), {
      ...http,
      session: { tenantId: installed.operator.tenantId },
    });
    assert.equal(otherTenant.status, errorStatus('UNAUTHENTICATED'));

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send', 'directory.read'],
      expiresAt,
    }, 'POST', admin.token), http);
    assert.equal(created.status, 201);
    const principal = await read(created);
    assert.equal(typeof principal.id, 'string');
    assert.deepEqual(principal.permissions, ['directory.read', 'notify.send']);
    assert.equal(typeof principal.credential, 'string');
    assert.match(String(principal.credential), /^[0-9a-f]{64}$/);
    const serviceCredential = String(principal.credential);
    hidden.push(serviceCredential);
    assert.equal(principal.credential === sha256(serviceCredential), false);

    const stored = await withRoot(async (client) => client.query<{ token_hash: string; permission: string }>(
      `SELECT c.token_hash, s.permission
       FROM kernel.service_credential c
       JOIN kernel.service_principal_scope s
         ON s.tenant_id = c.tenant_id AND s.principal_id = c.principal_id
       WHERE c.principal_id = $1::uuid AND c.revoked_at IS NULL
       ORDER BY s.permission`,
      [principal.id],
    ));
    assert.deepEqual(stored.rows.map((row) => row.permission), ['directory.read', 'notify.send']);
    assert.equal(stored.rows[0]?.token_hash, sha256(serviceCredential));
    assert.equal(stored.rows.every((row) => row.token_hash !== serviceCredential), true);

    const preference = await handleKernelRequest(request('/kernel/notification-preferences', {
      channel: 'in_app',
      enabled: true,
    }), {
      ...http,
      session: { tenantId: tenant, actorId: installed.customer.userId },
    });
    assert.equal(preference.status, 200);

    const sendBody = {
      idempotencyKey: 'k5-a',
      recipientId: installed.customer.userId,
      channel: 'in_app',
      body: 'routine',
    };
    const sent = await handleKernelRequest(request('/kernel/notifications', sendBody, 'POST', serviceCredential), {
      ...http,
      session: { tenantId: tenant, grants: [] },
    });
    assert.equal(sent.status, 200);
    assert.equal((await read(sent)).outcome, 'delivered');

    const upstream = await handleKernelRequest(
      request('/kernel/notifications', sendBody, 'POST', 'upstream.idp.token'),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(upstream.status, errorStatus('UNAUTHENTICATED'));
    const sessionAsPrincipal = await handleKernelRequest(
      request('/kernel/notifications', sendBody, 'POST', admin.token),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(sessionAsPrincipal.status, errorStatus('UNAUTHENTICATED'));
    const hashAsSecret = await handleKernelRequest(
      request('/kernel/notifications', sendBody, 'POST', sha256(serviceCredential)),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(hashAsSecret.status, errorStatus('UNAUTHENTICATED'));

    const rotated = await handleKernelRequest(request('/kernel/service-principal-rotations', {
      principalId: principal.id,
    }, 'POST', admin.token), http);
    assert.equal(rotated.status, 200);
    const next = await read(rotated);
    assert.equal(next.id, principal.id);
    assert.deepEqual(next.permissions, ['directory.read', 'notify.send']);
    const rotatedCredential = String(next.credential);
    assert.match(rotatedCredential, /^[0-9a-f]{64}$/);
    assert.notEqual(rotatedCredential, serviceCredential);
    hidden.push(rotatedCredential);

    const stale = await handleKernelRequest(
      request('/kernel/notifications', sendBody, 'POST', serviceCredential),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(stale.status, errorStatus('UNAUTHENTICATED'));
    const current = await handleKernelRequest(
      request('/kernel/notifications', { ...sendBody, idempotencyKey: 'k5-b' }, 'POST', rotatedCredential),
      { ...http, session: { tenantId: tenant, grants: [] } },
    );
    assert.equal(current.status, 200);

    const revoked = await handleKernelRequest(request('/kernel/service-principal-revocations', {
      principalId: principal.id,
    }, 'POST', admin.token), http);
    assert.equal(revoked.status, 200);
    assert.equal((await read(revoked)).revoked, true);
    const afterRevoke = await handleKernelRequest(
      request('/kernel/notifications', sendBody, 'POST', rotatedCredential),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(afterRevoke.status, errorStatus('UNAUTHENTICATED'));

    const narrow = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['directory.read'],
      expiresAt,
    }, 'POST', admin.token), http);
    assert.equal(narrow.status, 201);
    const narrowBody = await read(narrow);
    assert.deepEqual(narrowBody.permissions, ['directory.read']);
    const narrowCredential = String(narrowBody.credential);
    hidden.push(narrowCredential);
    const denied = await handleKernelRequest(
      request('/kernel/notifications', { ...sendBody, idempotencyKey: 'k5-c' }, 'POST', narrowCredential),
      { ...http, session: { tenantId: tenant, grants: ['notify.send', 'directory.read', 'secrets.sign'] } },
    );
    assert.equal(denied.status, errorStatus('FORBIDDEN'));
    assert.equal((await read(denied)).code, 'FORBIDDEN');
    const scope = await withRoot(async (client) => client.query<{ permission: string }>(
      `SELECT permission FROM kernel.service_principal_scope
       WHERE principal_id = $1::uuid
       ORDER BY permission`,
      [narrowBody.id],
    ));
    assert.deepEqual(scope.rows.map((row) => row.permission), ['directory.read']);

    const expired = await handleKernelRequest(request('/kernel/service-principals', {
      permissions: ['notify.send'],
      expiresAt,
    }, 'POST', admin.token), http);
    assert.equal(expired.status, 201);
    const expiredBody = await read(expired);
    hidden.push(String(expiredBody.credential));
    await withRoot(async (client) => {
      await client.query(
        `UPDATE kernel.service_principal
         SET expires_at = clock_timestamp() - interval '1 minute'
         WHERE id = $1::uuid`,
        [expiredBody.id],
      );
      await client.query(
        `UPDATE kernel.service_credential
         SET expires_at = clock_timestamp() - interval '1 minute'
         WHERE principal_id = $1::uuid`,
        [expiredBody.id],
      );
    });
    const expiredCall = await handleKernelRequest(
      request('/kernel/notifications', { ...sendBody, idempotencyKey: 'k5-d' }, 'POST', String(expiredBody.credential)),
      { ...http, session: { tenantId: tenant, grants: ['notify.send'] } },
    );
    assert.equal(expiredCall.status, errorStatus('UNAUTHENTICATED'));

    const audits = await withRoot(async (client) => client.query<{ action: string }>(
      `SELECT action FROM kernel.audit_record
       WHERE action LIKE 'service_principal.%'
       ORDER BY action`,
    ));
    assert.deepEqual(audits.rows.map((row) => row.action), [
      'service_principal.provision',
      'service_principal.provision',
      'service_principal.provision',
      'service_principal.revoke',
      'service_principal.rotate',
    ]);

    hides(sink.text(), hidden);
    assert.match(sink.text(), /"event":"principal.provision"/);
    const persisted = await withRoot(async (client) => client.query<{ body: string }>(
      `SELECT concat_ws(' ',
         (SELECT string_agg(token_hash, ' ') FROM kernel.service_credential),
         (SELECT string_agg(permission, ' ') FROM kernel.service_principal_scope)
       ) AS body`,
    ));
    hides(`${sink.text()}\n${persisted.rows[0]?.body ?? ''}`, hidden);

    const app = new pg.Client({ connectionString: POOLED });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query('SET LOCAL ROLE plerni_plugin_a');
      await assert.rejects(
        () => app.query('SELECT id FROM kernel.service_principal'),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === '42501',
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  } finally {
    await db.destroy();
    await resetRows();
  }
});
