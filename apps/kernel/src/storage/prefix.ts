// SPDX-License-Identifier: Apache-2.0
// Stored keys are derived (ADR-0015). The caller never supplies the prefix.
import { ContractFailure } from '@plerni/contracts';
import { PLUGIN_ID } from '../plugin/ident.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELATIVE_KEY = /^(?:[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/;
const MAX_STORED_KEY_BYTES = 1024;

function badTenant(): ContractFailure {
  return new ContractFailure({
    code: 'VALIDATION',
    message: 'The tenant id was rejected.',
    next_step: 'Use the tenant id from the authorized session.',
  });
}

function badPlugin(): ContractFailure {
  return new ContractFailure({
    code: 'VALIDATION',
    message: 'The plugin id was rejected.',
    next_step: 'Use the plugin id from the spawn credential.',
  });
}

function badKey(): ContractFailure {
  return new ContractFailure({
    code: 'VALIDATION',
    message: 'The object key was rejected.',
    next_step: 'Send a relative key of letters, digits, and . _ - separated by single slashes.',
  });
}

function canonicalTenant(value: string): string {
  if (typeof value !== 'string') throw badTenant();
  const tenant = value.toLowerCase();
  if (!UUID.test(tenant)) throw badTenant();
  return tenant;
}

function canonicalPlugin(value: string): string {
  if (typeof value !== 'string' || !PLUGIN_ID.test(value)) throw badPlugin();
  return value;
}

/** `t/<tenant>/p/<plugin>/<relative-key>`. Rejects anything that could leave that prefix. */
export function derivedObjectKey(tenantId: string, pluginId: string, key: string): string {
  const tenant = canonicalTenant(tenantId);
  const plugin = canonicalPlugin(pluginId);
  if (typeof key !== 'string' || !RELATIVE_KEY.test(key)) throw badKey();
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) throw badKey();
  const stored = `t/${tenant}/p/${plugin}/${key}`;
  if (Buffer.byteLength(stored) > MAX_STORED_KEY_BYTES) throw badKey();
  return stored;
}
