// SPDX-License-Identifier: Apache-2.0

export class BootstrapRejectedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('bootstrap credential rejected');
    this.name = 'BootstrapRejectedError';
  }
}

export class BootstrapClosedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('bootstrap credential is no longer accepted');
    this.name = 'BootstrapClosedError';
  }
}

export class LoginRejectedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('login rejected');
    this.name = 'LoginRejectedError';
  }
}

export class AccountDisabledError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('account disabled');
    this.name = 'AccountDisabledError';
  }
}

export class SessionRejectedError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('session rejected');
    this.name = 'SessionRejectedError';
  }
}

export class FreshnessExpiredError extends Error {
  readonly code = 'UNAUTHENTICATED' as const;

  constructor() {
    super('session freshness expired');
    this.name = 'FreshnessExpiredError';
  }
}

export class ThrottledError extends Error {
  readonly code = 'RATE_LIMITED' as const;

  constructor() {
    super('login throttled');
    this.name = 'ThrottledError';
  }
}

export class IdentityValidationError extends Error {
  readonly code = 'VALIDATION' as const;

  constructor(message = 'identity input rejected') {
    super(message);
    this.name = 'IdentityValidationError';
  }
}

export class IdentityForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;

  constructor(message = 'identity action forbidden') {
    super(message);
    this.name = 'IdentityForbiddenError';
  }
}

export class IdentityNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;

  constructor() {
    super('user not found');
    this.name = 'IdentityNotFoundError';
  }
}

export class EmailInUseError extends Error {
  readonly code = 'VALIDATION' as const;

  constructor() {
    super('email rejected');
    this.name = 'EmailInUseError';
  }
}
