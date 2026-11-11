// SPDX-License-Identifier: Apache-2.0
// Any change to an existing operation is treated as breaking; no semantic diff.
// An operation already in the baseline is identified by method and path. Its
// hash covers parameters, the request body, and responses, with every $ref
// inlined and object keys sorted. A new operation is allowed. A removed
// operation, or a hash change, fails unless the API major changes or the
// operation is listed in the allow file with a reason.
import { createHash } from 'node:crypto';
import type { OpenApiDocument } from './types.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Method = (typeof METHODS)[number];

export interface OperationAllow {
  method: string;
  path: string;
  reason: string;
}

export interface OperationBreak {
  method: string;
  path: string;
  change: 'removed' | 'changed';
}

function major(version: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!match?.[1]) throw new Error('public API version is not major.minor.patch');
  return Number(match[1]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
  return sorted;
}

function inlineRefs(document: OpenApiDocument, value: unknown, stack: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineRefs(document, item, stack));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const name = record.$ref.split('/').pop() ?? record.$ref;
    if (stack.includes(name)) return { $ref: record.$ref };
    const target = document.components.schemas[name];
    const inlined = target ? inlineRefs(document, target, [...stack, name]) : { $ref: record.$ref };
    const siblings: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key !== '$ref') siblings[key] = inlineRefs(document, record[key], [...stack, name]);
    }
    if (Object.keys(siblings).length === 0) return inlined;
    return { $refTarget: inlined, siblings };
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) out[key] = inlineRefs(document, record[key], stack);
  return out;
}

function operationHash(document: OpenApiDocument, method: string, path: string): string | null {
  const item = document.paths[path] as Partial<Record<Method, Record<string, unknown>>> | undefined;
  const operation = item?.[method as Method];
  if (!operation) return null;
  const contract = sortKeys(inlineRefs(document, {
    parameters: operation.parameters ?? null,
    requestBody: operation.requestBody ?? null,
    responses: operation.responses ?? null,
  }, []));
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function operations(document: OpenApiDocument): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];
  for (const path of Object.keys(document.paths).sort()) {
    const item = document.paths[path];
    if (!item) continue;
    for (const method of METHODS) {
      if (item[method]) found.push({ method, path });
    }
  }
  return found;
}

function allowed(allow: readonly OperationAllow[], method: string, path: string): boolean {
  return allow.some((entry) => entry.method === method && entry.path === path && entry.reason.trim().length > 0);
}

/** Hash each baseline operation. A change or removal is breaking; a new operation is not. */
export function operationBreaks(
  baseline: OpenApiDocument,
  next: OpenApiDocument,
  allow: readonly OperationAllow[] = [],
): OperationBreak[] {
  if (major(baseline.info.version) !== major(next.info.version)) return [];
  const breaks: OperationBreak[] = [];
  for (const operation of operations(baseline)) {
    if (allowed(allow, operation.method, operation.path)) continue;
    const before = operationHash(baseline, operation.method, operation.path);
    const after = operationHash(next, operation.method, operation.path);
    if (after === null) breaks.push({ ...operation, change: 'removed' });
    else if (before !== after) breaks.push({ ...operation, change: 'changed' });
  }
  return breaks;
}
