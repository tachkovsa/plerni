// SPDX-License-Identifier: Apache-2.0
export {
  ERROR_CODES,
  ERROR_REASONS,
  HTTP_STATUS_BY_CODE,
  errorStatus,
  type ErrorCode,
  type ErrorReason,
} from './error/codes.ts';
export {
  ContractFailure,
  errorEnvelope,
  errorEnvelopeSchema,
  toMcpToolResult,
  type ErrorEnvelope,
  type McpToolResult,
} from './error/envelope.ts';
export {
  IDEMPOTENCY_KEY_PATTERN,
  KERNEL_API_VERSION,
  createTenantRequestSchema,
  createTenantResponseSchema,
  isIdempotencyKey,
  kernelRoutes,
  kernelTenantCreate,
} from './registry/routes.ts';
export {
  installPackageRequestSchema,
  installPackageResponseSchema,
  kernelPackageEnablement,
  kernelPackageExport,
  kernelPackageForceAdvance,
  kernelPackageInstall,
  packageEnablementRequestSchema,
  packageEnablementResponseSchema,
  packageExportRequestSchema,
  packageExportResponseSchema,
  packageForceAdvanceRequestSchema,
  packageForceAdvanceResponseSchema,
  packageRoutes,
} from './registry/packages.ts';
export {
  assertOpenApiReview,
  generateKernelOpenApi,
  generateOpenApi,
  handWrittenPaths,
} from './registry/openapi.ts';
export { operationBreaks, type OperationAllow, type OperationBreak } from './registry/breaking.ts';
export type {
  DeprecationWindow,
  OpenApiDocument,
  OperationObject,
  ResponseObject,
  RouteContract,
  RouteSchema,
  SchemaObject,
} from './registry/types.ts';
