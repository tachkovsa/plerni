// SPDX-License-Identifier: Apache-2.0

export class PlatformScopeError extends Error {
  readonly code = 'FORBIDDEN' as const;

  constructor() {
    super('platform scope requires an operator session');
    this.name = 'PlatformScopeError';
  }
}

export class InvalidIdempotencyKeyError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor() {
    super('idempotency key rejected');
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export class InvalidTenantIdError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor() {
    super('tenant id rejected');
    this.name = 'InvalidTenantIdError';
  }
}

/** Same-key race: the other transaction owns the key. Roll back and re-read. */
export class IdempotencyConflict extends Error {
  constructor() {
    super('idempotency key already stored');
    this.name = 'IdempotencyConflict';
  }
}
