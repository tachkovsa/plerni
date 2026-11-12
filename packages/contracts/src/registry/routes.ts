// SPDX-License-Identifier: Apache-2.0
// Kernel routes. Create-tenant is the K2 API. Notification preference and
// send are the K12 API. Bootstrap stays an internal call and is not a public route.
import { z } from 'zod';
import { kernelOidcAuthorize, kernelOidcCallback, kernelOidcConfigure } from './oidc.ts';
import type { RouteContract } from './types.ts';

/** The same rule createTenant enforces for a direct caller. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

const UUID_SCHEMA = z.uuid();

export function isIdempotencyKey(value: string): boolean {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/** Same UUID rule the published schemas use. */
export function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID_SCHEMA.safeParse(value).success;
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

/** The only channel K12 delivers. The caller supplies the already rendered text. */
export const NOTIFICATION_CHANNEL = 'in_app' as const;

export const NOTIFICATION_BODY_MAX = 4000;

/** Newest delivered rows returned to the recipient. */
export const NOTIFICATION_LIST_MAX = 50;

export const notificationPreferenceRequestSchema = z.strictObject({
  channel: z.literal(NOTIFICATION_CHANNEL),
  enabled: z.boolean(),
});

export const notificationPreferenceResponseSchema = z.strictObject({
  id: z.uuid(),
  recipientId: z.uuid(),
  channel: z.literal(NOTIFICATION_CHANNEL),
  enabled: z.boolean(),
});

export const notificationSendRequestSchema = z.strictObject({
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  recipientId: z.uuid(),
  channel: z.literal(NOTIFICATION_CHANNEL),
  body: z.string().min(1).max(NOTIFICATION_BODY_MAX),
});

export const notificationSendResponseSchema = z.strictObject({
  id: z.uuid(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_PATTERN),
  recipientId: z.uuid(),
  channel: z.literal(NOTIFICATION_CHANNEL),
  outcome: z.enum(['delivered', 'suppressed']),
  body: z.string().min(1).max(NOTIFICATION_BODY_MAX),
});

export const notificationDeliveryListSchema = z.strictObject({
  deliveries: z.array(notificationSendResponseSchema).max(NOTIFICATION_LIST_MAX),
});

export const kernelNotificationPreferenceRecord: RouteContract = {
  operationId: 'kernel.notification.preference.record',
  method: 'post',
  path: '/kernel/notification-preferences',
  summary: 'Record the caller preference for the in-app channel',
  visibility: 'public',
  action: 'routine',
  scope: 'tenant',
  request: {
    schemaName: 'NotificationPreferenceRequest',
    schema: notificationPreferenceRequestSchema,
  },
  success: {
    status: 200,
    description: 'The recorded preference. A later record for the same caller updates that row.',
    schemaName: 'NotificationPreferenceResponse',
    schema: notificationPreferenceResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'INTERNAL'],
};

export const kernelNotificationSend: RouteContract = {
  operationId: 'kernel.notification.send',
  method: 'post',
  path: '/kernel/notifications',
  summary: 'Deliver one notification, or return the delivery already stored for the key',
  visibility: 'public',
  action: 'routine',
  scope: 'tenant',
  request: {
    schemaName: 'NotificationSendRequest',
    schema: notificationSendRequestSchema,
  },
  success: {
    status: 200,
    description: 'The delivery for this idempotency key. A duplicate send returns that delivery.',
    schemaName: 'NotificationSendResponse',
    schema: notificationSendResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONCURRENCY_CONFLICT', 'INTERNAL'],
};

export const kernelNotificationList: RouteContract = {
  operationId: 'kernel.notification.list',
  method: 'get',
  path: '/kernel/notifications',
  summary: 'List delivered in-app notifications for the caller',
  visibility: 'public',
  scope: 'tenant',
  success: {
    status: 200,
    description: `Delivered rows for the caller, newest first, at most ${NOTIFICATION_LIST_MAX}.`,
    schemaName: 'NotificationDeliveryList',
    schema: notificationDeliveryListSchema,
  },
  errors: ['UNAUTHENTICATED', 'VALIDATION', 'INTERNAL'],
};

export const kernelRoutes: readonly RouteContract[] = Object.freeze([
  kernelTenantCreate,
  kernelNotificationPreferenceRecord,
  kernelNotificationSend,
  kernelNotificationList,
  kernelOidcConfigure,
  kernelOidcAuthorize,
  kernelOidcCallback,
]);

export const KERNEL_API_VERSION = '1.0.0';
