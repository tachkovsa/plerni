// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Kysely } from 'kysely';
import { ContractFailure, errorStatus, isIdempotencyKey } from '@plerni/contracts';
import type { Database } from '../src/db/database.ts';
import { blankEvidence } from '../src/tenancy/hygiene.ts';
import { IdempotencyConflict, InvalidIdempotencyKeyError, PlatformScopeError } from '../src/tenant/errors.ts';
import { createTenant } from '../src/tenant/registry.ts';
import { handleKernelRequest, kernelRequestContext } from '../src/transport/kernel-request.ts';

const session = { tenantId: '11111111-1111-4111-8111-111111111111' };

function request(path: string, body?: unknown, method = 'POST'): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://kernel.test${path}`, init);
}

async function read(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('a path outside the registry is NOT_FOUND and does not run the route', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/hand-written', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, errorStatus('NOT_FOUND'));
  const body = await read(response);
  assert.equal(body.code, 'NOT_FOUND');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(called, 0);
});

test('a missing session is UNAUTHENTICATED', async () => {
  const response = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session: null,
    createTenant: async () => {
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, 401);
  const body = await read(response);
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.equal(typeof body.next_step, 'string');
  assert.equal('reason' in body, false);
});

test('a create-tenant body that is not JSON is VALIDATION', async () => {
  const response = await handleKernelRequest(
    new Request('http://kernel.test/kernel/tenants', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{',
    }),
    {
      session,
      createTenant: async () => {
        throw new Error('unexpected');
      },
    },
  );
  assert.equal(response.status, 400);
  const body = await read(response);
  assert.equal(body.code, 'VALIDATION');
  assert.equal(typeof body.next_step, 'string');
});

test('a rejected create-tenant body is VALIDATION and does not call the registry', async () => {
  let called = 0;
  const response = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'bad key' }), {
    session,
    createTenant: async () => {
      called += 1;
      throw new Error('unexpected');
    },
  });
  assert.equal(response.status, 400);
  const body = await read(response);
  assert.equal(body.code, 'VALIDATION');
  assert.equal(typeof body.message, 'string');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(called, 0);
});

test('a customer session is FORBIDDEN with next_step', async () => {
  const response = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async () => {
      throw new PlatformScopeError();
    },
  });
  assert.equal(response.status, 403);
  const body = await read(response);
  assert.equal(body.code, 'FORBIDDEN');
  assert.match(String(body.next_step), /operator/);
});

test('CONCURRENCY_CONFLICT maps to 409', async () => {
  assert.equal(errorStatus('CONCURRENCY_CONFLICT'), 409);
  const fromConflict = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async () => {
      throw new IdempotencyConflict();
    },
  });
  assert.equal(fromConflict.status, 409);
  const conflictBody = await read(fromConflict);
  assert.equal(conflictBody.code, 'CONCURRENCY_CONFLICT');
  assert.equal(typeof conflictBody.next_step, 'string');

  const fromCode = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async () => {
      throw new ContractFailure({
        code: 'CONCURRENCY_CONFLICT',
        message: 'The tenant version did not match.',
        next_step: 'Reload the tenant and retry the write.',
      });
    },
  });
  assert.equal(fromCode.status, 409);
  const codeBody = await read(fromCode);
  assert.equal(codeBody.code, 'CONCURRENCY_CONFLICT');
  assert.equal(codeBody.next_step, 'Reload the tenant and retry the write.');
});

test('a created tenant is the published response', async () => {
  const response = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async (input) => {
      assert.equal(input.idempotencyKey, 'ok');
      return {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'customer',
        createdAt: new Date('2026-11-11T00:00:00.000Z'),
      };
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await read(response), {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'customer',
    createdAt: '2026-11-11T00:00:00.000Z',
  });
});

test('an unexpected failure is INTERNAL and does not echo the thrown text', async () => {
  const response = await handleKernelRequest(request('/kernel/tenants', { idempotencyKey: 'ok' }), {
    session,
    createTenant: async () => {
      throw new Error('driver detail must stay internal');
    },
  });
  assert.equal(response.status, 500);
  const body = await read(response);
  assert.equal(body.code, 'INTERNAL');
  assert.equal(JSON.stringify(body).includes('driver detail'), false);
  assert.equal(typeof body.next_step, 'string');
});

test('the kernel route is wired to createTenant and hides database errors', async () => {
  const db = new Proxy({}, {
    get() {
      throw new Error('driver detail must stay internal');
    },
  }) as Kysely<Database>;
  const response = await handleKernelRequest(
    request('/kernel/tenants', { idempotencyKey: 'ok' }),
    kernelRequestContext({
      session,
      db,
      evidence: blankEvidence(),
      terminateBackend: async () => {},
    }),
  );
  assert.equal(response.status, 500);
  const body = await read(response);
  assert.equal(body.code, 'INTERNAL');
  assert.equal(typeof body.next_step, 'string');
  assert.equal(JSON.stringify(body).includes('driver detail'), false);
});

test('createTenant uses the published idempotency rule before touching the database', async () => {
  assert.equal(isIdempotencyKey('bad key'), false);
  const db = new Proxy({}, {
    get() {
      throw new Error('database used');
    },
  }) as Kysely<Database>;
  await assert.rejects(
    () => createTenant(
      db,
      session,
      { idempotencyKey: 'bad key' },
      blankEvidence(),
      async () => {},
    ),
    (error: unknown) => error instanceof InvalidIdempotencyKeyError,
  );
});
