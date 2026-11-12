// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import {
  assertOpenApiReview,
  createTenantRequestSchema,
  errorStatus,
  generateKernelOpenApi,
  generateOpenApi,
  kernelRoutes,
  type RouteContract,
} from '../src/index.ts';

const documentPath = new URL('../openapi/kernel.openapi.json', import.meta.url);

function privateRoute(): RouteContract {
  return {
    operationId: 'plugin.note.list',
    method: 'get',
    path: '/plugin/notes',
    summary: 'List private notes',
    visibility: 'plugin-private',
    success: {
      status: 200,
      description: 'Private notes',
      schemaName: 'PrivateNoteList',
      schema: z.strictObject({ ids: z.array(z.string()) }),
    },
    errors: ['FORBIDDEN'],
  };
}

function deprecatedRoute(): RouteContract {
  return {
    operationId: 'kernel.example.get',
    method: 'get',
    path: '/kernel/example',
    summary: 'Deprecated example',
    visibility: 'public',
    deprecation: { since: '1.0.0', until: '2.0.0' },
    success: {
      status: 200,
      description: 'Example',
      schemaName: 'DeprecatedExample',
      schema: z.strictObject({ ok: z.literal(true) }),
    },
    errors: ['NOT_FOUND'],
  };
}

test('kernel OpenAPI is generated from the zod registry', () => {
  const document = generateKernelOpenApi();
  const committed = JSON.parse(readFileSync(documentPath, 'utf8')) as unknown;
  assert.deepEqual(document, committed);
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document['x-plerni-error-statuses'].CONCURRENCY_CONFLICT, 409);
  const operation = document.paths['/kernel/tenants']?.post;
  assert.equal(operation?.operationId, 'kernel.tenant.create');
  assert.equal(operation?.['x-plerni-action'], 'sensitive');
  assert.equal(operation?.['x-plerni-scope'], 'platform');
  const envelope = document.components.schemas.ErrorEnvelope;
  assert.ok(envelope);
  assert.deepEqual(envelope.required, ['code', 'message', 'next_step']);
  assert.equal(envelope.properties?.reason?.enum?.includes('parked'), true);
  assert.equal((envelope.required ?? []).includes('reason'), false);
  assertOpenApiReview(document, kernelRoutes);
});

test('a plugin-private route is marked on the registry and omitted from OpenAPI', () => {
  const routes = [...kernelRoutes, privateRoute()];
  const document = generateOpenApi(routes);
  assert.equal(routes.at(-1)?.visibility, 'plugin-private');
  assert.equal(document.paths['/plugin/notes'], undefined);
  assert.equal(document.components.schemas.PrivateNoteList, undefined);
  assert.ok(document.paths['/kernel/tenants']?.post);
});

test('a public schema carries its deprecation window', () => {
  const document = generateOpenApi([...kernelRoutes, deprecatedRoute()]);
  const operation = document.paths['/kernel/example']?.get;
  assert.equal(operation?.deprecated, true);
  assert.deepEqual(operation?.['x-plerni-deprecation'], { since: '1.0.0', until: '2.0.0' });
  assert.deepEqual(document.components.schemas.DeprecatedExample?.['x-plerni-deprecation'], {
    since: '1.0.0',
    until: '2.0.0',
  });
});

test('a hand-written path fails review', () => {
  const document = structuredClone(generateKernelOpenApi());
  document.paths['/hand-written'] = {
    get: {
      operationId: 'hand.written',
      responses: { '200': { description: 'Hand written' } },
    },
  };
  assert.throws(() => assertOpenApiReview(document, kernelRoutes), /hand-written path/);
});

test('the create-tenant request schema is the published body', () => {
  assert.equal(createTenantRequestSchema.safeParse({ idempotencyKey: 'ok' }).success, true);
  assert.equal(createTenantRequestSchema.safeParse({ idempotencyKey: 'bad key' }).success, false);
  assert.equal(createTenantRequestSchema.safeParse({ idempotencyKey: 'ok', extra: true }).success, false);
  const operation = generateKernelOpenApi().paths['/kernel/tenants']?.post;
  const statuses = Object.keys(operation?.responses ?? {});
  for (const code of ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONCURRENCY_CONFLICT', 'INTERNAL'] as const) {
    assert.ok(statuses.includes(String(errorStatus(code))));
  }
});
