// SPDX-License-Identifier: Apache-2.0
// Put and get under the derived prefix (plan K11, ADR-0015).
// The grant is checked before the store is touched. A missing object is
// NOT_FOUND. The store's own message never becomes the envelope.
import { ContractFailure } from '@plerni/contracts';
import { derivedObjectKey } from './prefix.ts';
import type { ObjectStore } from './store.ts';

/** Provisional bound on one call. Not the K26 envelope note. */
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

const GRANT = 'storage.prefix';

export interface StorageCaller {
  tenantId: string;
  pluginId: string;
  grants: readonly string[];
}

function forbidden(): ContractFailure {
  return new ContractFailure({
    code: 'FORBIDDEN',
    message: 'The caller does not hold storage.prefix.',
    next_step: 'Ask the operator to approve the storage.prefix grant for this plugin.',
  });
}

function notFound(): ContractFailure {
  return new ContractFailure({
    code: 'NOT_FOUND',
    message: 'The object is not in this tenant.',
    next_step: 'Check the key. Put the object for this tenant before reading it.',
  });
}

function badBody(): ContractFailure {
  return new ContractFailure({
    code: 'VALIDATION',
    message: 'The object body was rejected.',
    next_step: 'Send the object bytes, at most 32 MiB.',
  });
}

function internal(): ContractFailure {
  return new ContractFailure({
    code: 'INTERNAL',
    message: 'The object store could not complete the request.',
    next_step: 'Retry later. If it continues, contact the operator.',
  });
}

function assertGrant(grants: readonly string[]): void {
  if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== 'string') || !grants.includes(GRANT)) {
    throw forbidden();
  }
}

function copyBytes(body: Uint8Array): Uint8Array {
  if (!(body instanceof Uint8Array) || body.byteLength > MAX_OBJECT_BYTES) throw badBody();
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

function asStoredBytes(body: Uint8Array | null): Uint8Array {
  if (body === null) throw notFound();
  if (!(body instanceof Uint8Array) || body.byteLength > MAX_OBJECT_BYTES) throw internal();
  return copyBytes(body);
}

export async function putObject(
  store: ObjectStore,
  caller: StorageCaller,
  key: string,
  body: Uint8Array,
): Promise<void> {
  assertGrant(caller.grants);
  const bytes = copyBytes(body);
  const stored = derivedObjectKey(caller.tenantId, caller.pluginId, key);
  try {
    await store.put(stored, bytes);
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw internal();
  }
}

export async function getObject(
  store: ObjectStore,
  caller: StorageCaller,
  key: string,
): Promise<Uint8Array> {
  assertGrant(caller.grants);
  const stored = derivedObjectKey(caller.tenantId, caller.pluginId, key);
  try {
    return asStoredBytes(await store.get(stored));
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw internal();
  }
}
