// SPDX-License-Identifier: Apache-2.0
// Closed transport-neutral codes (convention R3.3 plus plan §6).
// HTTP status is a property of the code. Only CONCURRENCY_CONFLICT is
// assigned by the plan (409). The other statuses are frozen here so a later
// change is an error-code meaning change. ADR-0014 records that choice.

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONCURRENCY_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
  'UNKNOWN_EVENT_VERSION',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_REASONS = [
  'maintenance',
  'dependency_disabled',
  'cache_unavailable',
  'parked',
  'quota',
] as const;

export type ErrorReason = (typeof ERROR_REASONS)[number];

/** One status per code, so an HTTP response names a single code. */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONCURRENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  UNKNOWN_EVENT_VERSION: 422,
};

export function errorStatus(code: ErrorCode): number {
  const status = HTTP_STATUS_BY_CODE[code];
  if (status === undefined) throw new Error('unknown error code');
  return status;
}
