// SPDX-License-Identifier: Apache-2.0

export class MissingTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingTenantContextError';
  }
}

export class ContaminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContaminationError';
  }
}

export class ContextInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextInstallError';
  }
}
