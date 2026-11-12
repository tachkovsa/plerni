// SPDX-License-Identifier: Apache-2.0
// HTTP adapter for the notification routes. The session actor is the only
// recipient a preference record can name. The message text is not returned.
import {
  ContractFailure,
  errorEnvelope,
  errorStatus,
  kernelNotificationPreferenceRecord,
  kernelNotificationSend,
  notificationPreferenceRequestSchema,
  notificationPreferenceResponseSchema,
  notificationSendRequestSchema,
  notificationSendResponseSchema,
  type ErrorEnvelope,
} from '@plerni/contracts';
import { NOTIFY_SEND } from '../notify/failures.ts';
import type { DeliveryRecord, NotifyCaller, SendNotificationInput } from '../notify/deliver.ts';
import type { PreferenceCaller, PreferenceInput, PreferenceRecord } from '../notify/preference.ts';

export interface NotificationHandlers {
  recordNotificationPreference?: (
    input: PreferenceInput,
    caller: PreferenceCaller,
  ) => Promise<PreferenceRecord>;
  sendNotification?: (
    input: SendNotificationInput,
    caller: NotifyCaller,
  ) => Promise<DeliveryRecord>;
}

export interface NotificationSession {
  tenantId: string;
  actorId?: string;
  grants?: readonly string[];
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

function rejected(nextStep: string): ErrorEnvelope {
  return errorEnvelope({
    code: 'VALIDATION',
    message: 'The request body was rejected.',
    next_step: nextStep,
  });
}

function unauthenticatedActor(): ErrorEnvelope {
  return errorEnvelope({
    code: 'UNAUTHENTICATED',
    message: 'The session does not name an actor.',
    next_step: 'Retry with a session that names the actor.',
  });
}

function internalFailure(): ErrorEnvelope {
  return errorEnvelope({
    code: 'INTERNAL',
    message: 'The request could not be completed.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

function fromError(error: unknown): ErrorEnvelope {
  if (error instanceof ContractFailure) {
    return errorEnvelope({
      code: error.code,
      message: error.message,
      next_step: error.next_step,
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
    });
  }
  return internalFailure();
}

function isJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  if (!header) return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJson(request: Request, nextStep: string): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJson(request)) return { ok: false, response: fail(rejected(nextStep)) };
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: fail(rejected(nextStep)) };
  }
}

export async function handleNotificationRequest(
  operationId: string,
  request: Request,
  session: NotificationSession,
  handlers: NotificationHandlers,
): Promise<Response> {
  if (!session.actorId) return fail(unauthenticatedActor());
  if (operationId === kernelNotificationPreferenceRecord.operationId) {
    const record = handlers.recordNotificationPreference;
    if (!record) return fail(internalFailure());
    const body = await readJson(request, 'Send a JSON object with channel in_app and an enabled flag.');
    if (!body.ok) return body.response;
    const parsed = notificationPreferenceRequestSchema.safeParse(body.value);
    if (!parsed.success) return fail(rejected('Send a JSON object with channel in_app and an enabled flag.'));
    try {
      const stored = await record(parsed.data, { tenantId: session.tenantId, actorId: session.actorId });
      const checked = notificationPreferenceResponseSchema.safeParse(stored);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    } catch (error) {
      return fail(fromError(error));
    }
  }
  if (operationId === kernelNotificationSend.operationId) {
    const send = handlers.sendNotification;
    if (!send) return fail(internalFailure());
    const grants = session.grants;
    if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string') || !grants.includes(NOTIFY_SEND)) {
      return fail(errorEnvelope({
        code: 'FORBIDDEN',
        message: 'The caller does not hold notify.send.',
        next_step: 'Ask the operator to approve the notify.send grant for this plugin.',
      }));
    }
    const body = await readJson(
      request,
      'Send a JSON object with an idempotency key, a recipient id, channel in_app, and the message text.',
    );
    if (!body.ok) return body.response;
    const parsed = notificationSendRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return fail(rejected(
        'Send a JSON object with an idempotency key, a recipient id, channel in_app, and the message text.',
      ));
    }
    try {
      const stored = await send(parsed.data, {
        tenantId: session.tenantId,
        actorId: session.actorId,
        grants,
      });
      const checked = notificationSendResponseSchema.safeParse(stored);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    } catch (error) {
      return fail(fromError(error));
    }
  }
  return fail(internalFailure());
}
