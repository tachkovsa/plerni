// SPDX-License-Identifier: Apache-2.0
// HTTP adapter for configure-OIDC, the authorization start, and the callback.
// Failures use the error envelope. The client secret and IdP tokens are not
// copied into the response.
import {
  errorEnvelope,
  errorStatus,
  kernelOidcAuthorize,
  kernelOidcCallback,
  kernelOidcConfigure,
  oidcAuthorizeRequestSchema,
  oidcAuthorizeResponseSchema,
  oidcCallbackResponseSchema,
  oidcConfigureRequestSchema,
  oidcConfigureResponseSchema,
  type ErrorEnvelope,
} from '@plerni/contracts';
import {
  AccountDisabledError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
  LoginRejectedError,
  OidcUnavailableError,
  SessionRejectedError,
} from '../identity/errors.ts';
import type { OidcConfigInput, OidcConfigView } from '../identity/oidc-config.ts';
import type { OidcAuthorization, OidcSession } from '../identity/oidc-flow.ts';

export interface OidcHandlers {
  configureOidc?: (
    actor: { tenantId: string; token: string },
    input: OidcConfigInput,
  ) => Promise<OidcConfigView>;
  startOidc?: (input: { tenantId: string; redirectUri: string }) => Promise<OidcAuthorization>;
  finishOidc?: (currentUrl: URL) => Promise<OidcSession>;
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

function internalFailure(): ErrorEnvelope {
  return errorEnvelope({
    code: 'INTERNAL',
    message: 'The request could not be completed.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

function envelopeFor(error: unknown): ErrorEnvelope {
  if (error instanceof IdentityValidationError) {
    return errorEnvelope({
      code: 'VALIDATION',
      message: 'The request was rejected.',
      next_step: 'Send the published fields. The redirect URI must match the configured value exactly.',
    });
  }
  if (error instanceof IdentityForbiddenError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: 'The session cannot configure OIDC.',
      next_step: 'Retry with an administrator session for this tenant.',
    });
  }
  if (error instanceof IdentityNotFoundError) {
    return errorEnvelope({
      code: 'NOT_FOUND',
      message: 'OIDC is not configured for this tenant.',
      next_step: 'Configure the issuer, then start the authorization again.',
    });
  }
  if (error instanceof OidcUnavailableError) {
    return errorEnvelope({
      code: 'UNAVAILABLE',
      message: 'The identity provider could not be reached.',
      next_step: 'Retry when the identity provider is available.',
    });
  }
  if (
    error instanceof LoginRejectedError
    || error instanceof AccountDisabledError
    || error instanceof SessionRejectedError
  ) {
    return errorEnvelope({
      code: 'UNAUTHENTICATED',
      message: 'login rejected',
      next_step: 'Start the authorization again with an enabled account.',
    });
  }
  return internalFailure();
}

function isJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  if (!header) return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function rejected(nextStep: string): Response {
  return fail(errorEnvelope({
    code: 'VALIDATION',
    message: 'The request body was rejected.',
    next_step: nextStep,
  }));
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header);
  return match?.[1] ?? null;
}

export async function handleOidcRequest(
  operationId: string,
  request: Request,
  session: { tenantId: string } | null,
  handlers: OidcHandlers,
): Promise<Response> {
  try {
    if (operationId === kernelOidcConfigure.operationId) {
      const token = bearer(request);
      if (!session || !token) {
        return fail(errorEnvelope({
          code: 'UNAUTHENTICATED',
          message: 'The request has no session.',
          next_step: 'Retry with an administrator session for this tenant.',
        }));
      }
      if (!handlers.configureOidc) return fail(internalFailure());
      if (!isJson(request)) {
        return rejected('Send a JSON object with issuer, clientId, clientSecret, and redirectUri.');
      }
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return rejected('Send a JSON object with issuer, clientId, clientSecret, and redirectUri.');
      }
      const parsed = oidcConfigureRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return rejected('Send a JSON object with issuer, clientId, clientSecret, and redirectUri.');
      }
      const view = await handlers.configureOidc(
        { tenantId: session.tenantId, token },
        parsed.data,
      );
      const body = oidcConfigureResponseSchema.safeParse(view);
      if (!body.success) return fail(internalFailure());
      return json(200, body.data);
    }
    if (operationId === kernelOidcAuthorize.operationId) {
      if (!handlers.startOidc) return fail(internalFailure());
      if (!isJson(request)) return rejected('Send a JSON object with tenantId and redirectUri.');
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return rejected('Send a JSON object with tenantId and redirectUri.');
      }
      const parsed = oidcAuthorizeRequestSchema.safeParse(payload);
      if (!parsed.success) return rejected('Send a JSON object with tenantId and redirectUri.');
      const started = await handlers.startOidc(parsed.data);
      const body = oidcAuthorizeResponseSchema.safeParse(started);
      if (!body.success) return fail(internalFailure());
      return json(200, body.data);
    }
    if (operationId === kernelOidcCallback.operationId) {
      if (!handlers.finishOidc) return fail(internalFailure());
      const finished = await handlers.finishOidc(new URL(request.url));
      const body = oidcCallbackResponseSchema.safeParse(finished);
      if (!body.success) return fail(internalFailure());
      return json(200, body.data);
    }
    return fail(internalFailure());
  } catch (error) {
    return fail(envelopeFor(error));
  }
}
