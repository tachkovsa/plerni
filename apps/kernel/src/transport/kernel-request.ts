// SPDX-License-Identifier: Apache-2.0
// HTTP adapter for the public kernel routes. The handler speaks Request and
// Response. Session resolution stays with the caller until authentication
// lands. Failures use the shared envelope; unexpected text is not copied out.
import type { Kysely } from 'kysely';
import {
  ContractFailure,
  createTenantRequestSchema,
  createTenantResponseSchema,
  errorEnvelope,
  errorStatus,
  kernelNotificationList,
  kernelNotificationPreferenceRecord,
  kernelNotificationSend,
  kernelOidcAuthorize,
  kernelOidcCallback,
  kernelOidcConfigure,
  kernelRoutes,
  type ErrorEnvelope,
} from '@plerni/contracts';
import type { Database } from '../db/database.ts';
import {
  listNotifications,
  sendNotification,
  type DeliveryRecord,
  type InboxCaller,
  type NotifyCaller,
  type SendNotificationInput,
} from '../notify/deliver.ts';
import {
  recordNotificationPreference,
  type PreferenceCaller,
  type PreferenceInput,
  type PreferenceRecord,
} from '../notify/preference.ts';
import type { IdentityContext } from '../identity/context.ts';
import type { IdentityLog } from '../identity/log.ts';
import { configureOidc } from '../identity/oidc-config.ts';
import { finishOidc, startOidc } from '../identity/oidc-flow.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  IdempotencyConflict,
  InvalidIdempotencyKeyError,
  InvalidTenantIdError,
  PlatformScopeError,
} from '../tenant/errors.ts';
import { createTenant, type TenantRecord, type TenantSession } from '../tenant/registry.ts';
import { handleNotificationRequest, type NotificationSession } from './notify-request.ts';
import { handleOidcRequest, type OidcHandlers } from './oidc-request.ts';

export interface KernelCaller extends TenantSession {
  actorId?: string;
  grants?: readonly string[];
}

export interface KernelHttpContext {
  session: KernelCaller | null;
  createTenant: (input: { idempotencyKey: string }, session: TenantSession) => Promise<TenantRecord>;
  recordNotificationPreference?: (input: PreferenceInput, caller: PreferenceCaller) => Promise<PreferenceRecord>;
  sendNotification?: (input: SendNotificationInput, caller: NotifyCaller) => Promise<DeliveryRecord>;
  listNotifications?: (caller: InboxCaller) => Promise<DeliveryRecord[]>;
  configureOidc?: OidcHandlers['configureOidc'];
  startOidc?: OidcHandlers['startOidc'];
  finishOidc?: OidcHandlers['finishOidc'];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(envelope: ErrorEnvelope): Response {
  return json(errorStatus(envelope.code), envelope);
}

export function envelopeFor(error: unknown): ErrorEnvelope {
  if (error instanceof ContractFailure) {
    return errorEnvelope({
      code: error.code,
      message: error.message,
      next_step: error.next_step,
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
    });
  }
  if (error instanceof PlatformScopeError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Send the request with an operator session.',
    });
  }
  if (error instanceof InvalidIdempotencyKeyError) {
    return errorEnvelope({
      code: 'VALIDATION',
      message: error.message,
      next_step: 'Send an idempotencyKey of 1 to 200 characters using letters, digits, and . _ : -.',
    });
  }
  if (error instanceof InvalidTenantIdError) {
    return errorEnvelope({
      code: 'VALIDATION',
      message: error.message,
      next_step: 'Send the session tenant id as a UUID.',
    });
  }
  if (error instanceof IdempotencyConflict) {
    return errorEnvelope({
      code: 'CONCURRENCY_CONFLICT',
      message: 'The idempotency key is in conflict.',
      next_step: 'Retry the same idempotency key.',
    });
  }
  return internalFailure();
}

function rejectedBody(): ErrorEnvelope {
  return errorEnvelope({
    code: 'VALIDATION',
    message: 'The request body was rejected.',
    next_step: 'Send a JSON object with an idempotencyKey that matches the published schema.',
  });
}

function internalFailure(): ErrorEnvelope {
  return errorEnvelope({
    code: 'INTERNAL',
    message: 'The request could not be completed.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

function isJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  if (!header) return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function createTenantResponse(
  request: Request,
  session: TenantSession,
  run: KernelHttpContext['createTenant'],
): Promise<Response> {
  if (!isJson(request)) return fail(rejectedBody());
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(rejectedBody());
  }
  const parsed = createTenantRequestSchema.safeParse(payload);
  if (!parsed.success) return fail(rejectedBody());
  try {
    const record = await run(parsed.data, session);
    const body = {
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt.toISOString(),
    };
    const checked = createTenantResponseSchema.safeParse(body);
    if (!checked.success) return fail(internalFailure());
    return json(201, checked.data);
  } catch (error) {
    return fail(envelopeFor(error));
  }
}

export async function handleKernelRequest(request: Request, ctx: KernelHttpContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toLowerCase();
  const route = kernelRoutes.find((candidate) =>
    candidate.visibility === 'public' && candidate.method === method && candidate.path === url.pathname);
  if (!route) {
    return fail(errorEnvelope({
      code: 'NOT_FOUND',
      message: 'No kernel route matches this request.',
      next_step: 'Use an operation id published in the kernel OpenAPI document.',
    }));
  }
  if (
    route.operationId === kernelOidcConfigure.operationId
    || route.operationId === kernelOidcAuthorize.operationId
    || route.operationId === kernelOidcCallback.operationId
  ) {
    return handleOidcRequest(route.operationId, request, ctx.session, {
      ...(ctx.configureOidc ? { configureOidc: ctx.configureOidc } : {}),
      ...(ctx.startOidc ? { startOidc: ctx.startOidc } : {}),
      ...(ctx.finishOidc ? { finishOidc: ctx.finishOidc } : {}),
    });
  }
  if (!ctx.session) {
    const nextStep = route.scope === 'tenant'
      ? 'Retry with a tenant session.'
      : 'Retry with an operator session.';
    return fail(errorEnvelope({
      code: 'UNAUTHENTICATED',
      message: 'The request has no session.',
      next_step: nextStep,
    }));
  }
  if (route.operationId === 'kernel.tenant.create') {
    return createTenantResponse(request, ctx.session, ctx.createTenant);
  }
  if (
    route.operationId === kernelNotificationPreferenceRecord.operationId
    || route.operationId === kernelNotificationSend.operationId
    || route.operationId === kernelNotificationList.operationId
  ) {
    const session: NotificationSession = {
      tenantId: ctx.session.tenantId,
      ...(ctx.session.actorId !== undefined ? { actorId: ctx.session.actorId } : {}),
      ...(ctx.session.grants !== undefined ? { grants: ctx.session.grants } : {}),
    };
    return handleNotificationRequest(route.operationId, request, session, {
      ...(ctx.recordNotificationPreference
        ? { recordNotificationPreference: ctx.recordNotificationPreference }
        : {}),
      ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
      ...(ctx.listNotifications ? { listNotifications: ctx.listNotifications } : {}),
    });
  }
  return fail(internalFailure());
}

export function kernelRequestContext(deps: {
  session: KernelCaller | null;
  db: Kysely<Database>;
  evidence: HygieneEvidence;
  terminateBackend: (pid: number) => Promise<void>;
  log?: IdentityLog;
}): KernelHttpContext {
  const identity: IdentityContext = {
    evidence: deps.evidence,
    terminate: deps.terminateBackend,
    log: deps.log ?? { event() { return undefined; } },
  };
  return {
    session: deps.session,
    createTenant: (input, session) => createTenant(
      deps.db,
      session,
      input,
      deps.evidence,
      deps.terminateBackend,
    ),
    recordNotificationPreference: (input, caller) => recordNotificationPreference(
      deps.db,
      caller,
      input,
      deps.evidence,
      deps.terminateBackend,
    ),
    sendNotification: (input, caller) => sendNotification(
      deps.db,
      caller,
      input,
      deps.evidence,
      deps.terminateBackend,
    ),
    listNotifications: (caller) => listNotifications(
      deps.db,
      caller,
      deps.evidence,
      deps.terminateBackend,
    ),
    configureOidc: (actor, input) => configureOidc(deps.db, actor, input, identity),
    startOidc: (input) => startOidc(deps.db, input, identity),
    finishOidc: (currentUrl) => finishOidc(deps.db, currentUrl, identity),
  };
}
