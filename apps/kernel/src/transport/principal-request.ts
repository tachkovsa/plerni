// SPDX-License-Identifier: Apache-2.0
// HTTP adapter for service-principal routes. The bearer is an administrator
// session. The credential in a success body is the only place the secret appears.
import {
  errorEnvelope,
  errorStatus,
  kernelServicePrincipalProvision,
  kernelServicePrincipalRevoke,
  kernelServicePrincipalRotate,
  servicePrincipalCredentialSchema,
  servicePrincipalIdRequestSchema,
  servicePrincipalProvisionRequestSchema,
  servicePrincipalRevokeRequestSchema,
  servicePrincipalRevokeResponseSchema,
  servicePrincipalRotatedCredentialSchema,
  type ErrorEnvelope,
} from '@plerni/contracts';
import {
  FreshnessExpiredError,
  IdentityForbiddenError,
  IdentityValidationError,
  PrincipalNotFoundError,
  SessionRejectedError,
} from '../identity/errors.ts';
import type { ServicePrincipalRecord } from '../identity/principal.ts';

export interface PrincipalActor {
  tenantId: string;
  token: string;
}

export interface PrincipalHandlers {
  provisionServicePrincipal?: (
    input: { permissions: readonly string[]; expiresAt: string },
    actor: PrincipalActor,
  ) => Promise<ServicePrincipalRecord>;
  rotateServicePrincipal?: (principalId: string, actor: PrincipalActor) => Promise<ServicePrincipalRecord>;
  revokeServicePrincipal?: (principalId: string, actor: PrincipalActor) => Promise<{ id: string; revoked: true }>;
}

export function authorizationBearer(request: Request): { present: false } | { present: true; token: string | null } {
  const header = request.headers.get('authorization');
  if (header === null) return { present: false };
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(header);
  const token = match?.[1];
  if (!token || token !== token.toLowerCase()) return { present: true, token: null };
  return { present: true, token };
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

export function rejectedServiceCredential(): ErrorEnvelope {
  return errorEnvelope({
    code: 'UNAUTHENTICATED',
    message: 'The service credential was rejected.',
    next_step: 'Send a current service credential for this tenant.',
  });
}

function rejectedAdminSession(): ErrorEnvelope {
  return errorEnvelope({
    code: 'UNAUTHENTICATED',
    message: 'The administrator session was rejected.',
    next_step: 'Sign in again with an administrator session for this tenant.',
  });
}

function rejectedRequest(): ErrorEnvelope {
  return errorEnvelope({
    code: 'VALIDATION',
    message: 'The service principal request was rejected.',
    next_step: 'Send distinct permissions from the grant vocabulary and an expiresAt within 90 days.',
  });
}

function forbidden(): ErrorEnvelope {
  return errorEnvelope({
    code: 'FORBIDDEN',
    message: 'The caller cannot manage service principals.',
    next_step: 'Retry with an administrator session for this tenant.',
  });
}

function missing(): ErrorEnvelope {
  return errorEnvelope({
    code: 'NOT_FOUND',
    message: 'The service principal was not found.',
    next_step: 'Use a principal id from this tenant.',
  });
}

function internalFailure(): ErrorEnvelope {
  return errorEnvelope({
    code: 'INTERNAL',
    message: 'The request could not be completed.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

export function bearerFailure(error: unknown): ErrorEnvelope {
  if (error instanceof SessionRejectedError || error instanceof FreshnessExpiredError) return rejectedServiceCredential();
  if (error instanceof IdentityValidationError) return rejectedRequest();
  return internalFailure();
}

function principalFailure(error: unknown): ErrorEnvelope {
  if (error instanceof IdentityValidationError) return rejectedRequest();
  if (error instanceof IdentityForbiddenError) return forbidden();
  if (error instanceof PrincipalNotFoundError) return missing();
  if (error instanceof SessionRejectedError || error instanceof FreshnessExpiredError) return rejectedAdminSession();
  return internalFailure();
}

function isJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  if (!header) return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJson(request)) return { ok: false, response: fail(rejectedRequest()) };
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, response: fail(rejectedRequest()) };
  }
}

function actorFrom(request: Request, tenantId: string | undefined): PrincipalActor | null {
  const auth = authorizationBearer(request);
  if (!auth.present || !auth.token || !tenantId) return null;
  return { tenantId, token: auth.token };
}

export async function handlePrincipalRequest(
  operationId: string,
  request: Request,
  tenantId: string | undefined,
  handlers: PrincipalHandlers,
): Promise<Response> {
  const actor = actorFrom(request, tenantId);
  if (!actor) return fail(rejectedAdminSession());
  const body = await readJson(request);
  if (!body.ok) return body.response;
  try {
    if (operationId === kernelServicePrincipalProvision.operationId) {
      const provision = handlers.provisionServicePrincipal;
      if (!provision) return fail(internalFailure());
      const parsed = servicePrincipalProvisionRequestSchema.safeParse(body.value);
      if (!parsed.success) return fail(rejectedRequest());
      const stored = await provision(parsed.data, actor);
      const checked = servicePrincipalCredentialSchema.safeParse(stored);
      if (!checked.success) return fail(internalFailure());
      return json(201, checked.data);
    }
    if (operationId === kernelServicePrincipalRotate.operationId) {
      const rotate = handlers.rotateServicePrincipal;
      if (!rotate) return fail(internalFailure());
      const parsed = servicePrincipalIdRequestSchema.safeParse(body.value);
      if (!parsed.success) return fail(rejectedRequest());
      const stored = await rotate(parsed.data.principalId, actor);
      const checked = servicePrincipalRotatedCredentialSchema.safeParse(stored);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    }
    if (operationId === kernelServicePrincipalRevoke.operationId) {
      const revoke = handlers.revokeServicePrincipal;
      if (!revoke) return fail(internalFailure());
      const parsed = servicePrincipalRevokeRequestSchema.safeParse(body.value);
      if (!parsed.success) return fail(rejectedRequest());
      const stored = await revoke(parsed.data.principalId, actor);
      const checked = servicePrincipalRevokeResponseSchema.safeParse(stored);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    }
  } catch (error) {
    return fail(principalFailure(error));
  }
  return fail(internalFailure());
}
