// SPDX-License-Identifier: Apache-2.0
// Route breaking changes (convention R2.2): a removed or renamed operation id,
// a tightened request, a loosened response, or an error code whose HTTP status
// changed. A different public-API major is a versioned break and does not fail
// the unversioned check.
import type { OpenApiDocument, OperationObject, RouteBreak, SchemaObject } from './types.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface IndexedOperation {
  method: string;
  path: string;
  operation: OperationObject;
}

function major(version: string): number {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (!match?.[1]) throw new Error('public API version is not major.minor.patch');
  return Number(match[1]);
}

function indexOperations(document: OpenApiDocument): Map<string, IndexedOperation> {
  const indexed = new Map<string, IndexedOperation>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item?.[method];
      if (!operation?.operationId) continue;
      indexed.set(operation.operationId, { method, path, operation });
    }
  }
  return indexed;
}

function resolve(document: OpenApiDocument, schema: SchemaObject | undefined, seen = new Set<string>()): SchemaObject | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.split('/').pop();
  if (!name || seen.has(name)) return schema;
  const target = document.components.schemas[name];
  if (!target) return schema;
  seen.add(name);
  return resolve(document, target, seen);
}

function typesOf(schema: SchemaObject): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  return [];
}

function allowsExtras(schema: SchemaObject): boolean {
  return schema.additionalProperties !== false;
}

/** A missing enum accepts every value. An empty enum accepts none. */
function enumAdded(before: SchemaObject, after: SchemaObject): boolean {
  return before.enum === undefined && after.enum !== undefined;
}

function enumRemoved(before: SchemaObject, after: SchemaObject): boolean {
  return before.enum !== undefined && after.enum === undefined;
}

function enumNarrowed(before: SchemaObject, after: SchemaObject): boolean {
  if (enumAdded(before, after)) return true;
  if (before.enum === undefined || after.enum === undefined) return false;
  return before.enum.some((value) => !after.enum?.includes(value));
}

function enumWidened(before: SchemaObject, after: SchemaObject): boolean {
  if (enumRemoved(before, after)) return true;
  if (before.enum === undefined || after.enum === undefined) return false;
  return after.enum.some((value) => !before.enum?.includes(value));
}

/** A missing format accepts every string of that type. */
function formatTightened(before: SchemaObject, after: SchemaObject): 'format added' | 'format changed' | null {
  if (before.format === after.format) return null;
  if (after.format === undefined) return null;
  return before.format === undefined ? 'format added' : 'format changed';
}

function formatLoosened(before: SchemaObject, after: SchemaObject): 'format removed' | 'format changed' | null {
  if (before.format === after.format) return null;
  if (before.format === undefined) return null;
  return after.format === undefined ? 'format removed' : 'format changed';
}

function requestBreaks(before: SchemaObject, after: SchemaObject, at: string): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  const beforeTypes = typesOf(before);
  const afterTypes = typesOf(after);
  if (beforeTypes.length > 0 && beforeTypes.some((type) => !afterTypes.includes(type))) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'type narrowed' });
  }
  if (enumAdded(before, after)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'enum added' });
  } else if (enumNarrowed(before, after)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'enum narrowed' });
  }
  if (after.pattern !== undefined && after.pattern !== before.pattern) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'pattern tightened' });
  }
  const tighterFormat = formatTightened(before, after);
  if (tighterFormat) breaks.push({ kind: 'request_tightened', path: at, detail: tighterFormat });
  if ((after.minLength ?? 0) > (before.minLength ?? 0)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'minLength increased' });
  }
  if (after.maxLength !== undefined && (before.maxLength === undefined || after.maxLength < before.maxLength)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'maxLength decreased' });
  }
  if (allowsExtras(before) && !allowsExtras(after)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'additional properties rejected' });
  }
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  for (const key of Object.keys(beforeProps)) {
    const afterProp = afterProps[key];
    if (!afterProp) {
      if (!allowsExtras(after)) breaks.push({ kind: 'request_tightened', path: `${at}.${key}`, detail: 'property removed' });
      continue;
    }
    breaks.push(...requestBreaks(beforeProps[key] as SchemaObject, afterProp, `${at}.${key}`));
  }
  for (const key of afterRequired) {
    if (!beforeRequired.has(key)) {
      breaks.push({ kind: 'request_tightened', path: `${at}.${key}`, detail: 'property became required' });
    }
  }
  if (before.items && after.items) breaks.push(...requestBreaks(before.items, after.items, `${at}[]`));
  return breaks;
}

function responseBreaks(before: SchemaObject, after: SchemaObject, at: string): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  const beforeTypes = typesOf(before);
  if (beforeTypes.length > 0 && typesOf(after).some((type) => !beforeTypes.includes(type))) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'type widened' });
  }
  if (enumRemoved(before, after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'enum removed' });
  } else if (enumWidened(before, after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'enum widened' });
  }
  const looserFormat = formatLoosened(before, after);
  if (looserFormat) breaks.push({ kind: 'response_loosened', path: at, detail: looserFormat });
  if ((before.minLength ?? 0) > (after.minLength ?? 0)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'minLength decreased' });
  }
  if (before.maxLength !== undefined && (after.maxLength === undefined || after.maxLength > before.maxLength)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'maxLength increased' });
  }
  if (!allowsExtras(before) && allowsExtras(after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'additional properties allowed' });
  }
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  for (const key of beforeRequired) {
    if (!afterRequired.has(key)) {
      breaks.push({ kind: 'response_loosened', path: `${at}.${key}`, detail: 'property no longer required' });
    }
  }
  for (const key of Object.keys(beforeProps)) {
    const afterProp = afterProps[key];
    if (!afterProp) {
      breaks.push({ kind: 'response_loosened', path: `${at}.${key}`, detail: 'property removed' });
      continue;
    }
    breaks.push(...responseBreaks(beforeProps[key] as SchemaObject, afterProp, `${at}.${key}`));
  }
  for (const key of Object.keys(afterProps)) {
    if (!(key in beforeProps) && !allowsExtras(before)) {
      breaks.push({ kind: 'response_loosened', path: `${at}.${key}`, detail: 'property added' });
    }
  }
  if (before.items && after.items) breaks.push(...responseBreaks(before.items, after.items, `${at}[]`));
  return breaks;
}

function jsonSchema(operation: OperationObject, kind: 'request' | 'response', status: string): SchemaObject | undefined {
  if (kind === 'request') return operation.requestBody?.content?.['application/json']?.schema;
  return operation.responses?.[status]?.content?.['application/json']?.schema;
}

function statusBreaks(before: OpenApiDocument, after: OpenApiDocument): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  for (const [code, status] of Object.entries(before['x-plerni-error-statuses'])) {
    const next = after['x-plerni-error-statuses'][code];
    if (next === undefined) breaks.push({ kind: 'error_code_meaning', code, from: status });
    else if (next !== status) breaks.push({ kind: 'error_code_meaning', code, from: status, to: next });
  }
  return breaks;
}

export function findRouteBreaks(before: OpenApiDocument, after: OpenApiDocument): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  const next = indexOperations(after);
  for (const [operationId, old] of indexOperations(before)) {
    const found = next.get(operationId);
    if (!found) {
      breaks.push({ kind: 'operation_removed', operationId });
      continue;
    }
    if (found.method !== old.method || found.path !== old.path) {
      breaks.push({
        kind: 'operation_moved',
        operationId,
        detail: `${old.method} ${old.path} -> ${found.method} ${found.path}`,
      });
    }
    const oldRequest = resolve(before, jsonSchema(old.operation, 'request', ''));
    const newRequest = resolve(after, jsonSchema(found.operation, 'request', ''));
    if (oldRequest && newRequest) breaks.push(...requestBreaks(oldRequest, newRequest, operationId));
    else if (oldRequest && !newRequest) {
      breaks.push({ kind: 'request_tightened', path: operationId, detail: 'request body removed' });
    }
    for (const status of Object.keys(old.operation.responses ?? {})) {
      const oldResponse = resolve(before, jsonSchema(old.operation, 'response', status));
      const newResponse = resolve(after, jsonSchema(found.operation, 'response', status));
      if (oldResponse && newResponse) breaks.push(...responseBreaks(oldResponse, newResponse, `${operationId} ${status}`));
      else if (oldResponse && !newResponse) {
        breaks.push({ kind: 'response_loosened', path: `${operationId} ${status}`, detail: 'response removed' });
      }
    }
  }
  breaks.push(...statusBreaks(before, after));
  return breaks;
}

export function unversionedRouteBreaks(before: OpenApiDocument, after: OpenApiDocument): RouteBreak[] {
  const breaks = findRouteBreaks(before, after);
  if (breaks.length === 0) return [];
  if (major(before.info.version) !== major(after.info.version)) return [];
  return breaks;
}
