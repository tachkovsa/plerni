// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  ERROR_REASONS,
  ContractFailure,
  errorEnvelope,
  errorStatus,
  isIdempotencyKey,
  toMcpToolResult,
} from '../src/index.ts';

const closedCodes = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONCURRENCY_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
  'UNKNOWN_EVENT_VERSION',
] as const;

test('the error code set is the convention R3.3 set plus UNKNOWN_EVENT_VERSION', () => {
  assert.deepEqual(ERROR_CODES, closedCodes);
});

test('CONCURRENCY_CONFLICT is HTTP 409 and every code has its own status', () => {
  assert.equal(errorStatus('CONCURRENCY_CONFLICT'), 409);
  const statuses = closedCodes.map((code) => errorStatus(code));
  assert.equal(new Set(statuses).size, statuses.length);
  assert.ok(statuses.every((status) => status >= 400 && status <= 599));
});

test('an envelope requires code, message, and next_step, and omits reason when absent', () => {
  const envelope = errorEnvelope({
    code: 'NOT_FOUND',
    message: 'The tenant was not found.',
    next_step: 'Check the tenant id and retry.',
  });
  assert.deepEqual(envelope, {
    code: 'NOT_FOUND',
    message: 'The tenant was not found.',
    next_step: 'Check the tenant id and retry.',
  });
  assert.equal('reason' in envelope, false);
});

test('reason is the closed set from plan section 6', () => {
  assert.deepEqual(ERROR_REASONS, [
    'maintenance',
    'dependency_disabled',
    'cache_unavailable',
    'parked',
    'quota',
  ]);
  const envelope = errorEnvelope({
    code: 'UNAVAILABLE',
    message: 'The installation is in maintenance.',
    next_step: 'Retry after the operator clears maintenance.',
    reason: 'maintenance',
  });
  assert.equal(envelope.reason, 'maintenance');
});

test('an unknown code, an empty next_step, or an unknown reason is rejected', () => {
  assert.throws(() => errorEnvelope({
    code: 'INVALID_ARGUMENT' as 'VALIDATION',
    message: 'no',
    next_step: 'Fix the request.',
  }));
  assert.throws(() => errorEnvelope({
    code: 'VALIDATION',
    message: 'The request was rejected.',
    next_step: '',
  }));
  assert.throws(() => errorEnvelope({
    code: 'UNAVAILABLE',
    message: 'Unavailable.',
    next_step: 'Retry later.',
    reason: 'weekend' as 'quota',
  }));
});

test('an MCP tool result carries the envelope and is not a JSON-RPC error', () => {
  const envelope = errorEnvelope({
    code: 'CONCURRENCY_CONFLICT',
    message: 'The write lost a version check.',
    next_step: 'Reload the resource and retry the write.',
  });
  const result = toMcpToolResult(envelope);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, envelope);
  assert.equal(result.content[0]?.type, 'text');
  assert.ok(result.content[0]?.text.includes(envelope.next_step));
  assert.equal('jsonrpc' in result, false);
  assert.equal(Object.hasOwn(result, 'error'), false);
  const failure = new ContractFailure(envelope);
  assert.equal(failure.code, 'CONCURRENCY_CONFLICT');
  assert.equal(errorStatus(failure.code), 409);
});

test('the published idempotency key rule accepts the K2 alphabet and rejects the rest', () => {
  assert.equal(isIdempotencyKey('tenant.key:1'), true);
  assert.equal(isIdempotencyKey(''), false);
  assert.equal(isIdempotencyKey('has space'), false);
  assert.equal(isIdempotencyKey('a'.repeat(201)), false);
});
