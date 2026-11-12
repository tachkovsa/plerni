// SPDX-License-Identifier: Apache-2.0
// Package registry routes (plan §3.2, K18). New operations. The create-tenant
// operation is unchanged.
import { z } from 'zod';
import type { RouteContract } from './types.ts';

const PACKAGE_ID = /^[a-z][a-z0-9_]{0,40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT = /^[a-z][a-z0-9_.]{0,80}$/;
const RANGE = /^(?:\*|(\^|~|>=|<=|>|<)?\d+\.\d+\.\d+)$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEQ = /^[0-9]+$/;

const packageEdgeSchema = z.strictObject({
  plugin: z.string().regex(PACKAGE_ID),
  contract: z.string().regex(CONTRACT),
  range: z.string().regex(RANGE),
});

const filterEntrySchema = z.strictObject({
  type: z.string().regex(EVENT_TYPE),
  versions: z.array(z.number().int().min(1)).min(1).max(16),
});

export const installPackageRequestSchema = z.strictObject({
  id: z.string().regex(PACKAGE_ID),
  version: z.string().regex(VERSION),
  digest: z.string().regex(DIGEST),
  filter: z.array(filterEntrySchema).max(32),
  requires: z.array(packageEdgeSchema).max(32),
  optionalRequires: z.array(packageEdgeSchema).max(32),
});

export const installPackageResponseSchema = z.strictObject({
  id: z.string().regex(PACKAGE_ID),
  version: z.string().regex(VERSION),
  digest: z.string().regex(DIGEST),
  subscriptionId: z.uuid(),
});

export const packageEnablementRequestSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  enabled: z.boolean(),
});

export const packageEnablementResponseSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  tenantId: z.string().regex(UUID),
  enabled: z.boolean(),
  watermarkSeq: z.string().regex(SEQ),
});

export const packageExportRequestSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
});

export const packageExportResponseSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  exportedAt: z.iso.datetime(),
});

export const packageForceAdvanceRequestSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  tenantId: z.string().regex(UUID),
});

export const packageForceAdvanceResponseSchema = z.strictObject({
  packageId: z.string().regex(PACKAGE_ID),
  tenantId: z.string().regex(UUID),
  watermarkSeq: z.string().regex(SEQ),
});

export const kernelPackageInstall: RouteContract = {
  operationId: 'kernel.package.install',
  method: 'post',
  path: '/kernel/packages',
  summary: 'Register an installed package',
  visibility: 'public',
  action: 'sensitive',
  scope: 'platform',
  request: {
    schemaName: 'InstallPackageRequest',
    schema: installPackageRequestSchema,
  },
  success: {
    status: 201,
    description: 'The registry row. The same id, version, and digest returns that row again.',
    schemaName: 'InstallPackageResponse',
    schema: installPackageResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'CONCURRENCY_CONFLICT', 'INTERNAL'],
};

export const kernelPackageEnablement: RouteContract = {
  operationId: 'kernel.package.enablement',
  method: 'post',
  path: '/kernel/package-enablement',
  summary: 'Enable or disable a package for the session tenant',
  visibility: 'public',
  action: 'sensitive',
  scope: 'tenant',
  request: {
    schemaName: 'PackageEnablementRequest',
    schema: packageEnablementRequestSchema,
  },
  success: {
    status: 200,
    description: 'The enablement row for the session tenant. Grants are unchanged.',
    schemaName: 'PackageEnablementResponse',
    schema: packageEnablementResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
};

export const kernelPackageExport: RouteContract = {
  operationId: 'kernel.package.export',
  method: 'post',
  path: '/kernel/package-export',
  summary: 'Record the export procedure for a package',
  visibility: 'public',
  action: 'sensitive',
  scope: 'platform',
  request: {
    schemaName: 'PackageExportRequest',
    schema: packageExportRequestSchema,
  },
  success: {
    status: 200,
    description: 'The export timestamp. Repeating the call keeps the first timestamp.',
    schemaName: 'PackageExportResponse',
    schema: packageExportResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
};

export const kernelPackageForceAdvance: RouteContract = {
  operationId: 'kernel.package.forceAdvance',
  method: 'post',
  path: '/kernel/package-force-advance',
  summary: 'Force-advance a disabled tenant watermark after export',
  visibility: 'public',
  action: 'destructive',
  scope: 'platform',
  request: {
    schemaName: 'PackageForceAdvanceRequest',
    schema: packageForceAdvanceRequestSchema,
  },
  success: {
    status: 200,
    description: 'The watermark after it leaves the retention minimum. Log rows are not deleted here.',
    schemaName: 'PackageForceAdvanceResponse',
    schema: packageForceAdvanceResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INTERNAL'],
};

export const packageRoutes: readonly RouteContract[] = Object.freeze([
  kernelPackageInstall,
  kernelPackageEnablement,
  kernelPackageExport,
  kernelPackageForceAdvance,
]);
