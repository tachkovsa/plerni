// SPDX-License-Identifier: Apache-2.0

export class AuditPayloadError extends Error {
  constructor() {
    super('audit payload rejected');
    this.name = 'AuditPayloadError';
  }
}

export class AuditChainError extends Error {
  constructor() {
    super('audit chain does not verify');
    this.name = 'AuditChainError';
  }
}
