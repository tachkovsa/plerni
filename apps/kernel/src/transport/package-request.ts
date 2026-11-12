// SPDX-License-Identifier: Apache-2.0
// HTTP adapter for the package registry. Failures use the shared envelope.
import {
  errorEnvelope,
  errorStatus,
  installPackageRequestSchema,
  installPackageResponseSchema,
  packageEnablementRequestSchema,
  packageEnablementResponseSchema,
  packageExportRequestSchema,
  packageExportResponseSchema,
  packageForceAdvanceRequestSchema,
  packageForceAdvanceResponseSchema,
  type ErrorEnvelope,
} from '@plerni/contracts';
import type { Kysely } from 'kysely';
import type { Database } from '../db/database.ts';
import { packageEnvelope } from '../package/errors.ts';
import {
  exportPackage,
  forceAdvancePackage,
  installPackage,
  setPackageEnabled,
  type EnablementRecord,
  type ExportRecord,
  type InstallPackageInput,
  type PackageRecord,
  type SessionTenant,
} from '../package/registry.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import { PlatformScopeError } from '../tenant/errors.ts';

export interface PackageHttp {
  installPackage: (
    input: InstallPackageInput,
    session: SessionTenant,
  ) => Promise<PackageRecord>;
  setPackageEnabled: (
    packageId: string,
    enabled: boolean,
    session: SessionTenant,
  ) => Promise<EnablementRecord>;
  exportPackage: (packageId: string, session: SessionTenant) => Promise<ExportRecord>;
  forceAdvancePackage: (
    packageId: string,
    tenantId: string,
    session: SessionTenant,
  ) => Promise<EnablementRecord>;
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

function rejectedBody(): ErrorEnvelope {
  return errorEnvelope({
    code: 'VALIDATION',
    message: 'The request body was rejected.',
    next_step: 'Send a JSON object that matches the published schema.',
  });
}

function internalFailure(): ErrorEnvelope {
  return errorEnvelope({
    code: 'INTERNAL',
    message: 'The request could not be completed.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

function envelopeFor(error: unknown): ErrorEnvelope {
  if (error instanceof PlatformScopeError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Send the request with an operator session.',
    });
  }
  return packageEnvelope(error) ?? internalFailure();
}

function isJson(request: Request): boolean {
  const header = request.headers.get('content-type');
  if (!header) return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

async function readBody(request: Request): Promise<unknown | Response> {
  if (!isJson(request)) return fail(rejectedBody());
  try {
    return await request.json();
  } catch {
    return fail(rejectedBody());
  }
}

export async function handlePackageRequest(
  request: Request,
  operationId: string,
  session: SessionTenant,
  http: PackageHttp,
): Promise<Response> {
  const payload = await readBody(request);
  if (payload instanceof Response) return payload;
  try {
    if (operationId === 'kernel.package.install') {
      const parsed = installPackageRequestSchema.safeParse(payload);
      if (!parsed.success) return fail(rejectedBody());
      const record = await http.installPackage(parsed.data, session);
      const checked = installPackageResponseSchema.safeParse(record);
      if (!checked.success) return fail(internalFailure());
      return json(201, checked.data);
    }
    if (operationId === 'kernel.package.enablement') {
      const parsed = packageEnablementRequestSchema.safeParse(payload);
      if (!parsed.success) return fail(rejectedBody());
      const record = await http.setPackageEnabled(parsed.data.packageId, parsed.data.enabled, session);
      const checked = packageEnablementResponseSchema.safeParse(record);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    }
    if (operationId === 'kernel.package.export') {
      const parsed = packageExportRequestSchema.safeParse(payload);
      if (!parsed.success) return fail(rejectedBody());
      const record = await http.exportPackage(parsed.data.packageId, session);
      const body = { packageId: record.packageId, exportedAt: record.exportedAt.toISOString() };
      const checked = packageExportResponseSchema.safeParse(body);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    }
    if (operationId === 'kernel.package.forceAdvance') {
      const parsed = packageForceAdvanceRequestSchema.safeParse(payload);
      if (!parsed.success) return fail(rejectedBody());
      const record = await http.forceAdvancePackage(parsed.data.packageId, parsed.data.tenantId, session);
      const checked = packageForceAdvanceResponseSchema.safeParse(record);
      if (!checked.success) return fail(internalFailure());
      return json(200, checked.data);
    }
  } catch (error) {
    return fail(envelopeFor(error));
  }
  return fail(internalFailure());
}

export function packageHttp(deps: {
  db: Kysely<Database>;
  evidence: HygieneEvidence;
  terminateBackend: (pid: number) => Promise<void>;
}): PackageHttp {
  return {
    installPackage: (input, session) => installPackage(
      deps.db,
      session,
      input,
      deps.evidence,
      deps.terminateBackend,
    ),
    setPackageEnabled: (packageId, enabled, session) => setPackageEnabled(
      deps.db,
      session,
      packageId,
      enabled,
      deps.evidence,
      deps.terminateBackend,
    ),
    exportPackage: (packageId, session) => exportPackage(
      deps.db,
      session,
      packageId,
      deps.evidence,
      deps.terminateBackend,
    ),
    forceAdvancePackage: (packageId, tenantId, session) => forceAdvancePackage(
      deps.db,
      session,
      packageId,
      tenantId,
      deps.evidence,
      deps.terminateBackend,
    ),
  };
}
