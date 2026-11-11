// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractFailure, errorEnvelopeSchema } from '@plerni/contracts';
import { MAX_OBJECT_BYTES, getObject, putObject, type StorageCaller } from '../src/storage/gateway.ts';
import { readLimited } from '../src/storage/s3.ts';
import type { ObjectStore } from '../src/storage/store.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function caller(tenantId: string, pluginId = 'alpha', grants: readonly string[] = ['storage.prefix']): StorageCaller {
  return { tenantId, pluginId, grants };
}

function memory(): ObjectStore & { keys: () => string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    close() {},
  };
}

function envelope(error: unknown) {
  assert.ok(error instanceof ContractFailure);
  return errorEnvelopeSchema.parse({
    code: error.code,
    message: error.message,
    next_step: error.next_step,
  });
}

test('a caller without storage.prefix does not touch the store', async () => {
  const store = memory();
  const body = new Uint8Array([1]);
  for (const grants of [[], ['storage.prefix.extra'], ['notify.send']] as const) {
    await assert.rejects(() => putObject(store, caller(TENANT_A, 'alpha', grants), 'notes/one', body));
    await assert.rejects(() => getObject(store, caller(TENANT_A, 'alpha', grants), 'notes/one'));
  }
  assert.deepEqual(store.keys(), []);
});

test('a rejected key does not touch the store', async () => {
  const store = memory();
  const body = new Uint8Array([1]);
  const rejected = ['', '/notes', 'notes/', 'notes//one', '.', '..', 'notes/../one', 'notes/./one', 'a\\b', 'a%2e', 'notes/one '];
  for (const key of rejected) {
    await assert.rejects(
      () => putObject(store, caller(TENANT_A), key, body),
      (error: unknown) => envelope(error).code === 'VALIDATION',
    );
  }
  const tooLong = 'a'.repeat(1000);
  await assert.rejects(
    () => putObject(store, caller(TENANT_A), tooLong, body),
    (error: unknown) => envelope(error).code === 'VALIDATION',
  );
  assert.deepEqual(store.keys(), []);
});

test('a body that is not bytes, or is over the cap, does not touch the store', async () => {
  const store = memory();
  await assert.rejects(
    () => putObject(store, caller(TENANT_A), 'notes/one', 'text' as unknown as Uint8Array),
    (error: unknown) => envelope(error).code === 'VALIDATION',
  );
  const over = new Uint8Array(MAX_OBJECT_BYTES + 1);
  await assert.rejects(
    () => putObject(store, caller(TENANT_A), 'notes/one', over),
    (error: unknown) => envelope(error).code === 'VALIDATION',
  );
  assert.deepEqual(store.keys(), []);
});

test('a missing object is NOT_FOUND with next_step', async () => {
  const store = memory();
  await assert.rejects(
    () => getObject(store, caller(TENANT_A), 'notes/missing'),
    (error: unknown) => {
      const body = envelope(error);
      return body.code === 'NOT_FOUND' && body.next_step.length > 0 && body.reason === undefined;
    },
  );
});

test('tenant B does not receive tenant A bytes from the derived key', async () => {
  const store = memory();
  const bytes = Uint8Array.from([0, 255, 10]);
  await putObject(store, caller(TENANT_A), 'notes/one', bytes);
  await assert.rejects(
    () => getObject(store, caller(TENANT_B), 'notes/one'),
    (error: unknown) => envelope(error).code === 'NOT_FOUND',
  );
  assert.deepEqual(store.keys(), [`t/${TENANT_A}/p/alpha/notes/one`]);
  assert.deepEqual(await getObject(store, caller(TENANT_A), 'notes/one'), bytes);
});

function byteStream(parts: Uint8Array[]) {
  const state = { destroyed: false };
  return {
    get destroyed() {
      return state.destroyed;
    },
    destroy() {
      state.destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        if (state.destroyed) return;
        yield part;
      }
    },
  };
}

test('a declared length over the cap destroys the stream before it is read', async () => {
  const stream = byteStream([Uint8Array.from([1, 2, 3, 4, 5])]);
  await assert.rejects(() => readLimited(stream, 5, 4));
  assert.equal(stream.destroyed, true);
});

test('a body that grows past the cap stops and does not return the bytes', async () => {
  const stream = byteStream([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6])]);
  await assert.rejects(() => readLimited(stream, undefined, 4));
  assert.equal(stream.destroyed, true);
});

test('a body inside the cap is returned whole', async () => {
  const stream = byteStream([Uint8Array.from([1, 2]), Uint8Array.from([3])]);
  assert.deepEqual(await readLimited(stream, 3, 4), Uint8Array.from([1, 2, 3]));
  assert.equal(stream.destroyed, false);
});

test('a store failure is INTERNAL and drops the store message', async () => {
  const detail = 'backend-refused-the-call';
  const store: ObjectStore = {
    async put() {
      throw new Error(detail);
    },
    async get() {
      throw new Error(detail);
    },
    close() {},
  };
  for (const run of [
    () => putObject(store, caller(TENANT_A), 'notes/one', new Uint8Array([1])),
    () => getObject(store, caller(TENANT_A), 'notes/one'),
  ]) {
    await assert.rejects(run, (error: unknown) => {
      const body = envelope(error);
      const text = `${body.message} ${body.next_step}`;
      return body.code === 'INTERNAL' && !text.includes(detail);
    });
  }
});
