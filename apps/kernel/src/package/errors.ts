// SPDX-License-Identifier: Apache-2.0
// Failures of the package registry and enablement routes (ADR-0014).
import { errorEnvelope, type ErrorEnvelope } from '@plerni/contracts';

export class PackageInputError extends Error {
  constructor() {
    super('package input rejected');
    this.name = 'PackageInputError';
  }
}

export class PackageNotFoundError extends Error {
  constructor() {
    super('package is not registered');
    this.name = 'PackageNotFoundError';
  }
}

export class TenantNotFoundError extends Error {
  constructor() {
    super('tenant is not registered');
    this.name = 'TenantNotFoundError';
  }
}

export class EnablementNotFoundError extends Error {
  constructor() {
    super('enablement is not recorded');
    this.name = 'EnablementNotFoundError';
  }
}

export class PackageConflictError extends Error {
  constructor() {
    super('package id is already registered');
    this.name = 'PackageConflictError';
  }
}

export class ExportRequiredError extends Error {
  constructor() {
    super('force-advance requires the export procedure');
    this.name = 'ExportRequiredError';
  }
}

export class DependencyNotEnabledError extends Error {
  constructor() {
    super('a required package is not enabled for this tenant');
    this.name = 'DependencyNotEnabledError';
  }
}

export class PackageHoldError extends Error {
  constructor() {
    super('force-advance applies to a disabled hold');
    this.name = 'PackageHoldError';
  }
}

export class CursorNotParkedError extends Error {
  constructor() {
    super('force-advance applies to a parked cursor');
    this.name = 'CursorNotParkedError';
  }
}

export class SubscriptionNotFoundError extends Error {
  constructor() {
    super('subscription is not recorded');
    this.name = 'SubscriptionNotFoundError';
  }
}

/** Envelope for package failures. Null when the error belongs to another mapper. */
export function packageEnvelope(error: unknown): ErrorEnvelope | null {
  if (error instanceof PackageInputError) {
    return errorEnvelope({
      code: 'VALIDATION',
      message: error.message,
      next_step: 'Send the package fields published for this operation.',
    });
  }
  if (error instanceof PackageNotFoundError || error instanceof TenantNotFoundError
    || error instanceof EnablementNotFoundError || error instanceof SubscriptionNotFoundError) {
    return errorEnvelope({
      code: 'NOT_FOUND',
      message: error.message,
      next_step: 'Use an id that is already registered.',
    });
  }
  if (error instanceof PackageConflictError) {
    return errorEnvelope({
      code: 'CONCURRENCY_CONFLICT',
      message: error.message,
      next_step: 'Retry with the digest and version already registered for this id.',
    });
  }
  if (error instanceof ExportRequiredError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Run the export procedure, then retry force-advance.',
    });
  }
  if (error instanceof DependencyNotEnabledError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Enable the required package for this tenant, then retry.',
    });
  }
  if (error instanceof PackageHoldError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Disable the package for that tenant before force-advance.',
    });
  }
  if (error instanceof CursorNotParkedError) {
    return errorEnvelope({
      code: 'FORBIDDEN',
      message: error.message,
      next_step: 'Park the subscription before force-advance.',
    });
  }
  return null;
}
