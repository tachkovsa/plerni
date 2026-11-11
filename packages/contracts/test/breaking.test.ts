// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findRouteBreaks,
  generateKernelOpenApi,
  unversionedRouteBreaks,
  type OpenApiDocument,
  type SchemaObject,
} from '../src/index.ts';

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
