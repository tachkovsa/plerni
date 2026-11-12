// SPDX-License-Identifier: Apache-2.0
// Kernel routes. Create-tenant is the K2 API. Package routes are K18.
// Bootstrap stays an internal call and is not a public route.
import { z } from 'zod';
import { packageRoutes } from './packages.ts';
import type { RouteContract } from './types.ts';

/** The same rule createTenant enforces for a direct caller. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export function isIdempotencyKey(value: string): boolean {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export const createTenantRequestSchema = z.strictObject({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});

export const createTenantResponseSchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal('customer'),
  createdAt: z.iso.datetime(),
});

export const kernelTenantCreate: RouteContract = {
  operationId: 'kernel.tenant.create',
  method: 'post',
  path: '/kernel/tenants',
  summary: 'Create a customer tenant',
  visibility: 'public',
  action: 'sensitive',
  scope: 'platform',
  request: {
    schemaName: 'CreateTenantRequest',
    schema: createTenantRequestSchema,
  },
  success: {
    status: 201,
    description: 'The customer tenant. The same idempotency key returns that tenant again.',
    schemaName: 'CreateTenantResponse',
    schema: createTenantResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONCURRENCY_CONFLICT', 'INTERNAL'],
};

export const kernelRoutes: readonly RouteContract[] = Object.freeze([
  kernelTenantCreate,
  ...packageRoutes,
]);

export const KERNEL_API_VERSION = '1.0.0';
