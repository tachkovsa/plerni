// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findRouteBreaks,
  generateKernelOpenApi,
  unversionedRouteBreaks,
  type OpenApiDocument,
  type SchemaObject,
} from '../src/index.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const contractPath = 'packages/contracts/openapi/kernel.openapi.json';

function clone(): OpenApiDocument {
  return structuredClone(generateKernelOpenApi());
}

function schemaAt(document: OpenApiDocument, refOrSchema: SchemaObject | undefined): SchemaObject {
  assert.ok(refOrSchema);
  if (typeof refOrSchema.$ref === 'string') {
    const name = refOrSchema.$ref.split('/').pop();
    assert.equal(typeof name, 'string');
    const resolved = document.components.schemas[name as string];
    assert.ok(resolved);
    return resolved;
  }
  return refOrSchema;
}

function requestSchema(document: OpenApiDocument): SchemaObject {
  const requestBody = document.paths['/kernel/tenants']?.post?.requestBody;
  return schemaAt(document, requestBody?.content?.['application/json']?.schema);
}

function responseSchema(document: OpenApiDocument): SchemaObject {
  const response = document.paths['/kernel/tenants']?.post?.responses?.['201'];
  return schemaAt(document, response?.content?.['application/json']?.schema);
}

test('the generated kernel routes have no unversioned break against themselves', () => {
  const document = generateKernelOpenApi();
  assert.deepEqual(unversionedRouteBreaks(document, document), []);
});

test('removing or renaming an operation id is an unversioned break', () => {
  const next = clone();
  const operation = next.paths['/kernel/tenants']?.post;
  assert.ok(operation);
  operation.operationId = 'kernel.tenant.add';
  const breaks = unversionedRouteBreaks(clone(), next);
  assert.ok(breaks.some((item) => item.kind === 'operation_removed' && item.operationId === 'kernel.tenant.create'));
});

test('a major version bump records the same removal as a versioned break', () => {
  const before = clone();
  const next = clone();
  delete next.paths['/kernel/tenants'];
  next.info = { ...next.info, version: '2.0.0' };
  assert.ok(findRouteBreaks(before, next).some((item) => item.kind === 'operation_removed'));
  assert.deepEqual(unversionedRouteBreaks(before, next), []);
});

test('tightening the create-tenant request is an unversioned break', () => {
  const before = clone();
  const next = clone();
  const request = requestSchema(next);
  request.properties = { ...request.properties, label: { type: 'string' } };
  request.required = [...(request.required ?? []), 'label'];
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'request_tightened'));
});

test('an optional request field is not a break', () => {
  const before = clone();
  const next = clone();
  const request = requestSchema(next);
  request.properties = { ...request.properties, note: { type: 'string' } };
  assert.deepEqual(unversionedRouteBreaks(before, next), []);
});

test('loosening the create-tenant response is an unversioned break', () => {
  const before = clone();
  const next = clone();
  const response = responseSchema(next);
  response.required = (response.required ?? []).filter((name) => name !== 'id');
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'response_loosened'));
});

test('removing the concurrency response is an unversioned break', () => {
  const before = clone();
  const next = clone();
  const responses = next.paths['/kernel/tenants']?.post?.responses;
  assert.ok(responses);
  delete responses['409'];
  assert.ok(unversionedRouteBreaks(before, next).some((item) => item.kind === 'response_loosened'));
});

test('dropping a response enum loosens the response', () => {
  const before = clone();
  const next = clone();
  const kind = responseSchema(next).properties?.kind;
  assert.ok(kind?.enum);
  delete kind.enum;
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'response_loosened' && item.detail === 'enum removed'));
});

test('replacing a request pattern with an enum tightens the request', () => {
  const before = clone();
  const next = clone();
  const key = requestSchema(next).properties?.idempotencyKey;
  assert.ok(key?.pattern);
  delete key.pattern;
  key.enum = ['ok'];
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'request_tightened' && item.detail === 'enum added'));
});

test('dropping the tenant id format loosens the response', () => {
  const before = clone();
  const next = clone();
  const id = responseSchema(next).properties?.id;
  assert.equal(id?.format, 'uuid');
  delete id.format;
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'response_loosened' && item.detail === 'format removed'));
});

test('dropping the timestamp format loosens the response', () => {
  const before = clone();
  const next = clone();
  const createdAt = responseSchema(next).properties?.createdAt;
  assert.equal(createdAt?.format, 'date-time');
  delete createdAt.format;
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'response_loosened' && item.detail === 'format removed'));
});

test('adding a request format tightens the request', () => {
  const before = clone();
  const next = clone();
  const key = requestSchema(next).properties?.idempotencyKey;
  assert.ok(key);
  assert.equal(key.format, undefined);
  key.format = 'uuid';
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'request_tightened' && item.detail === 'format added'));
});

test('dropping the message type loosens the response', () => {
  const before = clone();
  const next = clone();
  const message = next.components.schemas.ErrorEnvelope?.properties?.message;
  assert.equal(message?.type, 'string');
  delete message.type;
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'response_loosened' && item.detail === 'type removed'));
});

test('removing a request type is not a tightening', () => {
  const before = clone();
  const next = clone();
  const key = requestSchema(next).properties?.idempotencyKey;
  assert.equal(key?.type, 'string');
  delete key.type;
  const breaks = unversionedRouteBreaks(before, next);
  assert.equal(breaks.some((item) => item.kind === 'request_tightened'), false);
});

test('adding a request type tightens the request', () => {
  const before = clone();
  const next = clone();
  const beforeKey = requestSchema(before).properties?.idempotencyKey;
  assert.ok(beforeKey);
  delete beforeKey.type;
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'request_tightened' && item.detail === 'type added'));
});

test('removing a request format is not a tightening', () => {
  const before = clone();
  const next = clone();
  const beforeKey = requestSchema(before).properties?.idempotencyKey;
  assert.ok(beforeKey);
  beforeKey.format = 'uuid';
  const breaks = unversionedRouteBreaks(before, next);
  assert.equal(breaks.some((item) => 'detail' in item && (item.detail === 'format added' || item.detail === 'format changed')), false);
});

test('removing a request enum without adding one is not a tightening', () => {
  const before = clone();
  const next = clone();
  for (const document of [before, next]) {
    const key = requestSchema(document).properties?.idempotencyKey;
    assert.ok(key);
    delete key.pattern;
  }
  const beforeKey = requestSchema(before).properties?.idempotencyKey;
  assert.ok(beforeKey);
  beforeKey.enum = ['alpha', 'beta'];
  const breaks = unversionedRouteBreaks(before, next);
  assert.equal(breaks.some((item) => item.kind === 'request_tightened'), false);
});

function contractOnRevision(revision: string): OpenApiDocument | null {
  try {
    const text = execFileSync('git', ['show', `${revision}:${contractPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(text) as OpenApiDocument;
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr)
      : '';
    if (stderr.includes('does not exist') || stderr.includes('exists on disk, but not')) return null;
    throw error;
  }
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function parentsOf(revision: string): string[] {
  const line = gitOutput(['rev-list', '--parents', '-n', '1', revision]);
  if (!line) return [];
  return line.split(/\s+/).slice(1);
}

/** CI checks out a merge commit. Its second parent is the pull-request head. */
function reviewedHead(): string {
  const parents = parentsOf('HEAD');
  if (parents.length >= 2 && parents[1]) return parents[1];
  return 'HEAD';
}

test('the generated contract has no unversioned break against the preserved baseline', () => {
  const head = reviewedHead();
  const originDev = gitOutput(['rev-parse', '--verify', 'origin/dev']);
  const released = originDev
    ? contractOnRevision(execFileSync('git', ['merge-base', head, 'origin/dev'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim())
    : null;
  // The merge base is the released contract. Before that blob exists, the
  // previous commit on the reviewed head is the preserved contract.
  // Regenerating the working-tree file does not replace either blob.
  const previous = parentsOf(head)[0];
  const baseline = released ?? (previous ? contractOnRevision(previous) : null);
  const generated = generateKernelOpenApi();
  if (baseline === null) {
    assert.equal(generated.info.version, '1.0.0');
    return;
  }
  assert.deepEqual(unversionedRouteBreaks(baseline, generated), []);
});

test('regenerating the OpenAPI file does not hide a break against a preserved baseline', () => {
  const baseline = clone();
  const regenerated = clone();
  delete regenerated.paths['/kernel/tenants'];
  assert.ok(unversionedRouteBreaks(baseline, regenerated).some((item) => item.kind === 'operation_removed'));
});

test('changing the CONCURRENCY_CONFLICT status changes the code meaning', () => {
  const before = clone();
  const next = clone();
  next['x-plerni-error-statuses'] = {
    ...next['x-plerni-error-statuses'],
    CONCURRENCY_CONFLICT: 400,
  };
  const breaks = unversionedRouteBreaks(before, next);
  assert.ok(breaks.some((item) => item.kind === 'error_code_meaning' && item.code === 'CONCURRENCY_CONFLICT'));
});
