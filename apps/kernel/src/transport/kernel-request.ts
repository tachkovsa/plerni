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
  kernelRoutes,
  type ErrorEnvelope,
} from '@plerni/contracts';
import type { Database } from '../db/database.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import {
  IdempotencyConflict,
  InvalidIdempotencyKeyError,
  InvalidTenantIdError,
  PlatformScopeError,
} from '../tenant/errors.ts';
import { createTenant, type TenantRecord, type TenantSession } from '../tenant/registry.ts';
import { handlePackageRequest, packageHttp, type PackageHttp } from './package-request.ts';

export interface KernelHttpContext {
  session: TenantSession | null;
  createTenant: (input: { idempotencyKey: string }, session: TenantSession) => Promise<TenantRecord>;
  packages?: PackageHttp;
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
  if (!ctx.session) {
    return fail(errorEnvelope({
      code: 'UNAUTHENTICATED',
      message: 'The request has no session.',
      next_step: 'Retry with an operator session.',
    }));
  }
  if (route.operationId === 'kernel.tenant.create') {
    return createTenantResponse(request, ctx.session, ctx.createTenant);
  }
  if (route.operationId.startsWith('kernel.package.')) {
    if (!ctx.packages) return fail(internalFailure());
    return handlePackageRequest(request, route.operationId, ctx.session, ctx.packages);
  }
  return fail(internalFailure());
}

export function kernelRequestContext(deps: {
  session: TenantSession | null;
  db: Kysely<Database>;
  evidence: HygieneEvidence;
  terminateBackend: (pid: number) => Promise<void>;
}): KernelHttpContext {
  return {
    session: deps.session,
    createTenant: (input, session) => createTenant(
      deps.db,
      session,
      input,
      deps.evidence,
      deps.terminateBackend,
    ),
    packages: packageHttp(deps),
  };
}
