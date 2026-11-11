// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateKernelOpenApi, operationBreaks, type OpenApiDocument, type OperationAllow } from '../src/index.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const contractPath = 'packages/contracts/openapi/kernel.openapi.json';

function clone(): OpenApiDocument {
  return structuredClone(generateKernelOpenApi());
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

function contractOnRevision(revision: string): OpenApiDocument | null {
  try {
    const text = execFileSync('git', ['show', `${revision}:${contractPath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(text) as OpenApiDocument;
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr) : '';
    if (stderr.includes('does not exist') || stderr.includes('exists on disk, but not')) return null;
    throw error;
  }
}

test('an unchanged contract passes', () => {
  const document = clone();
  assert.deepEqual(operationBreaks(document, document), []);
});

test('a new operation passes', () => {
  const baseline = clone();
  const next = clone();
  next.paths['/kernel/health'] = { get: { operationId: 'kernel.health.get', responses: { '200': { description: 'ok' } } } };
  assert.deepEqual(operationBreaks(baseline, next), []);
});

test('a changed existing operation fails', () => {
  const baseline = clone();
  const next = clone();
  const response = next.paths['/kernel/tenants']?.post?.responses?.['201'];
  assert.ok(response);
  response.description = 'changed';
  const breaks = operationBreaks(baseline, next);
  assert.deepEqual(breaks, [{ method: 'post', path: '/kernel/tenants', change: 'changed' }]);
});

test('renaming an operation id fails', () => {
  const baseline = clone();
  const next = clone();
  const operation = next.paths['/kernel/tenants']?.post;
  assert.ok(operation);
  operation.operationId = 'kernel.tenant.create.v2';
  assert.deepEqual(operationBreaks(baseline, next), [{ method: 'post', path: '/kernel/tenants', change: 'changed' }]);
});

test('changing an error status fails', () => {
  const baseline = clone();
  const next = clone();
  next['x-plerni-error-statuses'] = { ...next['x-plerni-error-statuses'], NOT_FOUND: 410 };
  const allow: OperationAllow[] = [{ method: 'post', path: '/kernel/tenants', reason: 'does not waive the status map' }];
  assert.deepEqual(operationBreaks(baseline, next, allow), [{
    method: 'document',
    path: 'x-plerni-error-statuses',
    change: 'changed',
  }]);
});

test('a removed operation fails', () => {
  const baseline = clone();
  const next = clone();
  delete next.paths['/kernel/tenants'];
  const breaks = operationBreaks(baseline, next);
  assert.deepEqual(breaks, [{ method: 'post', path: '/kernel/tenants', change: 'removed' }]);
});

test('an allow-file entry passes', () => {
  const baseline = clone();
  const next = clone();
  delete next.paths['/kernel/tenants'];
  const allow: OperationAllow[] = [{ method: 'post', path: '/kernel/tenants', reason: 'operation retired in this review' }];
  assert.deepEqual(operationBreaks(baseline, next, allow), []);
});

test('a version bump passes', () => {
  const baseline = clone();
  const next = clone();
  delete next.paths['/kernel/tenants'];
  next.info = { ...next.info, version: '2.0.0' };
  assert.deepEqual(operationBreaks(baseline, next), []);
});

test('the generated contract matches the committed snapshot', () => {
  const parents = gitOutput(['rev-list', '--parents', '-n', '1', 'HEAD'])?.split(/\s+/) ?? [];
  const head = parents.length >= 3 && parents[2] ? parents[2] : 'HEAD';
  const originDev = gitOutput(['rev-parse', '--verify', 'origin/dev']);
  const released = originDev
    ? contractOnRevision(execFileSync('git', ['merge-base', head, 'origin/dev'], { cwd: repoRoot, encoding: 'utf8' }).trim())
    : null;
  const previous = parents.length >= 2 ? parents[1] : undefined;
  const reviewedParents = gitOutput(['rev-list', '--parents', '-n', '1', head])?.split(/\s+/).slice(1) ?? [];
  const baseline = released ?? (reviewedParents[0] ? contractOnRevision(reviewedParents[0]) : null) ?? (previous ? contractOnRevision(previous) : null);
  const generated = generateKernelOpenApi();
  if (baseline === null) {
    assert.equal(generated.info.version, '1.0.0');
    return;
  }
  const allow = JSON.parse(readFileSync(new URL('../openapi/operation-allow.json', import.meta.url), 'utf8')) as OperationAllow[];
  assert.deepEqual(operationBreaks(baseline, generated, allow), []);
});
