// SPDX-License-Identifier: Apache-2.0
// Storage suite against an S3-compatible double (plan K11).
// The double is moto 5.2.5, Apache-2.0, from the Python package index.
// It accepts any signing key, so this file does not carry a store secret.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { CreateBucketCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ContractFailure, errorEnvelopeSchema, errorStatus } from '@plerni/contracts';
import { getObject, putObject, type StorageCaller } from '../src/storage/gateway.ts';
import { createS3Client, createS3ObjectStore } from '../src/storage/s3.ts';
import type { ObjectStore } from '../src/storage/store.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BUCKET = 'plerni-objects';
const REGION = 'us-east-1';
const MOTO_VERSION = '5.2.5';

let server: ChildProcess | undefined;
let client: S3Client | undefined;
let store: ObjectStore | undefined;

function caller(tenantId: string, pluginId: string): StorageCaller {
  return { tenantId, pluginId, grants: ['storage.prefix'] };
}

function objects(): ObjectStore {
  if (!store) throw new Error('storage suite is not started');
  return store;
}

function envelope(error: unknown) {
  assert.ok(error instanceof ContractFailure);
  const body = errorEnvelopeSchema.parse({
    code: error.code,
    message: error.message,
    next_step: error.next_step,
  });
  if (body.code === 'NOT_FOUND') assert.equal(errorStatus(body.code), 404);
  if (body.code === 'VALIDATION') assert.equal(errorStatus(body.code), 400);
  return body;
}

async function listed(prefix: string): Promise<string[]> {
  assert.ok(client);
  const response = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  return (response.Contents ?? []).flatMap((item) => (item.Key ? [item.Key] : [])).sort();
}

async function rawGet(key: string): Promise<Uint8Array> {
  assert.ok(client);
  const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  assert.ok(response.Body);
  return await response.Body.transformToByteArray();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('S3 double did not receive a port'));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (server?.exitCode !== null && server?.exitCode !== undefined) {
        reject(new Error('S3 double exited before it accepted connections'));
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('S3 double did not accept connections'));
        return;
      }
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

function motoVersion(): string {
  return execFileSync('python3', [
    '-c',
    'import importlib.metadata as meta; print(meta.version("moto"), end="")',
  ], { encoding: 'utf8' });
}

before(async () => {
  assert.equal(motoVersion(), MOTO_VERSION);
  const port = await freePort();
  server = spawn('python3', ['-m', 'moto.server', '-H', '127.0.0.1', '-p', String(port)], {
    stdio: 'ignore',
  });
  await waitForPort(port);
  const config = {
    endpoint: `http://127.0.0.1:${port}`,
    bucket: BUCKET,
    region: REGION,
    accessKeyId: 'test',
    secretAccessKey: 'test',
  };
  client = createS3Client(config);
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  store = createS3ObjectStore(config);
});

after(async () => {
  store?.close();
  client?.destroy();
  await stopServer(server);
});

test('put and get use the derived tenant and plugin prefix', async () => {
  const bytes = Uint8Array.from([0, 255, 10, 0]);
  const key = 'notes/one';
  const stored = `t/${TENANT_A}/p/alpha/${key}`;
  await putObject(objects(), caller(TENANT_A, 'alpha'), key, bytes);
  assert.deepEqual(await listed(stored), [stored]);
  assert.deepEqual(await getObject(objects(), caller(TENANT_A, 'alpha'), key), bytes);
  assert.deepEqual(await rawGet(stored), bytes);
});

test('tenant B cannot read tenant A, and a missing key is NOT_FOUND', async () => {
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const key = 'notes/shared-name';
  const stored = `t/${TENANT_A}/p/alpha/${key}`;
  await putObject(objects(), caller(TENANT_A, 'alpha'), key, bytes);

  await assert.rejects(
    () => getObject(objects(), caller(TENANT_B, 'alpha'), key),
    (error: unknown) => {
      const body = envelope(error);
      return body.code === 'NOT_FOUND' && body.next_step.length > 0;
    },
  );
  assert.deepEqual(await listed(`t/${TENANT_B}/`), []);
  assert.deepEqual(await rawGet(stored), bytes);

  await assert.rejects(
    () => getObject(objects(), caller(TENANT_A, 'alpha'), 'notes/missing'),
    (error: unknown) => {
      const body = envelope(error);
      return body.code === 'NOT_FOUND' && body.next_step.length > 0;
    },
  );
});

test('another plugin in the same tenant cannot read the object', async () => {
  const bytes = Uint8Array.from([9]);
  await putObject(objects(), caller(TENANT_A, 'alpha'), 'notes/plugin', bytes);
  await assert.rejects(
    () => getObject(objects(), caller(TENANT_A, 'beta'), 'notes/plugin'),
    (error: unknown) => envelope(error).code === 'NOT_FOUND',
  );
  assert.deepEqual(await getObject(objects(), caller(TENANT_A, 'alpha'), 'notes/plugin'), bytes);
});

test('a relative key cannot escape into another tenant prefix', async () => {
  const stored = `t/${TENANT_A}/p/alpha/notes/owned`;
  await putObject(objects(), caller(TENANT_A, 'alpha'), 'notes/owned', Uint8Array.from([7]));
  const beforeKeys = await listed('t/');
  await assert.rejects(
    () => putObject(objects(), caller(TENANT_B, 'alpha'), `../${stored}`, Uint8Array.from([8])),
    (error: unknown) => envelope(error).code === 'VALIDATION',
  );
  await assert.rejects(
    () => getObject(objects(), caller(TENANT_B, 'alpha'), stored),
    (error: unknown) => envelope(error).code === 'NOT_FOUND',
  );
  assert.deepEqual(await listed('t/'), beforeKeys);
  assert.deepEqual(await rawGet(stored), Uint8Array.from([7]));
});

test('the tenant id is canonical and a later put replaces the object', async () => {
  const key = 'notes/replaced';
  const stored = `t/${TENANT_A}/p/alpha/${key}`;
  await putObject(objects(), caller(TENANT_A.toUpperCase(), 'alpha'), key, Uint8Array.from([1]));
  assert.deepEqual(await listed(stored), [stored]);
  await putObject(objects(), caller(TENANT_A, 'alpha'), key, Uint8Array.from([2, 2]));
  assert.deepEqual(await getObject(objects(), caller(TENANT_A, 'alpha'), key), Uint8Array.from([2, 2]));
  assert.deepEqual(await rawGet(stored), Uint8Array.from([2, 2]));
});

test('an empty body round-trips and is not NOT_FOUND', async () => {
  await putObject(objects(), caller(TENANT_A, 'alpha'), 'notes/empty', new Uint8Array());
  assert.deepEqual(await getObject(objects(), caller(TENANT_A, 'alpha'), 'notes/empty'), new Uint8Array());
});
