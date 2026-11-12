// SPDX-License-Identifier: Apache-2.0
import { ContractFailure } from '@plerni/contracts';

/** Label bound in sql/0010_directory.sql. */
export const DIRECTORY_LABEL_MAX = 200;

/** Keyset page bound for directory lists. */
export const DIRECTORY_PAGE_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_TYPE_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function postgresCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

function invalid(nextStep: string): ContractFailure {
  return new ContractFailure({
    code: 'VALIDATION',
    message: 'The directory value was rejected.',
    next_step: nextStep,
  });
}

export function assertTenantId(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalid('Retry with a tenant id that is a UUID.');
  }
  return canonicalUuid(value);
}

export function assertDirectoryId(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalid('Retry with a directory id that is a UUID.');
  }
  return canonicalUuid(value);
}

export function assertLabel(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > DIRECTORY_LABEL_MAX || value !== value.trim()) {
    throw invalid(`Send a label of 1 to ${DIRECTORY_LABEL_MAX} characters without surrounding spaces.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`Send a label of 1 to ${DIRECTORY_LABEL_MAX} characters without control characters.`);
  }
  return value;
}

export function assertEdgeTypeName(value: string): string {
  if (typeof value !== 'string' || !EDGE_TYPE_NAME.test(value)) {
    throw invalid('Send an edge type name using a leading letter, then lowercase letters, digits, or underscore.');
  }
  return value;
}

export function rejectedPlugin(): ContractFailure {
  return invalid('Use a plugin id that matches the manifest grammar.');
}

export function rejectedEdgeUsers(): ContractFailure {
  return invalid('Choose two different users in this tenant.');
}

export function brokerForbidden(): ContractFailure {
  return new ContractFailure({
    code: 'FORBIDDEN',
    message: 'Directory access runs as the broker.',
    next_step: 'Call the directory port before switching to the plugin role.',
  });
}

export function edgeTypeForbidden(): ContractFailure {
  return new ContractFailure({
    code: 'FORBIDDEN',
    message: 'The edge type is not listed for this caller.',
    next_step: 'List that type with directory.write_edge before registering or writing it.',
  });
}

export function registerForbidden(): ContractFailure {
  return new ContractFailure({
    code: 'FORBIDDEN',
    message: 'The caller cannot register an edge type.',
    next_step: 'Ask the operator to approve directory.register_edge_type for this plugin.',
  });
}

export function directoryNotFound(nextStep: string): ContractFailure {
  return new ContractFailure({
    code: 'NOT_FOUND',
    message: 'The directory record was not found.',
    next_step: nextStep,
  });
}

export function directoryConflict(): ContractFailure {
  return new ContractFailure({
    code: 'CONCURRENCY_CONFLICT',
    message: 'The directory record is in conflict.',
    next_step: 'Retry with the existing directory id, or choose a different name.',
  });
}
