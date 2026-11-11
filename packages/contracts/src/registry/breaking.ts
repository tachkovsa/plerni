// SPDX-License-Identifier: Apache-2.0
// Route breaking changes (convention R2.2). Unsupported schema differences fail
// closed. The checker compares paths, operations, required fields, property
// add/remove, type, enum, min/max, pattern, format, items, and
// additionalProperties. Any other keyword difference, including composition
// and a $ref it cannot match, is a break unless the public API major changes
// or the caller passes an allow entry for that path and keyword.
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

/** A missing type accepts every value. An empty type list accepts none. */
function typesOf(schema: SchemaObject): string[] | null {
  if (schema.type === undefined) return null;
  if (Array.isArray(schema.type)) return schema.type;
  if (typeof schema.type === 'string') return [schema.type];
  return null;
}

function typeTightened(before: SchemaObject, after: SchemaObject): 'type added' | 'type narrowed' | null {
  const beforeTypes = typesOf(before);
  const afterTypes = typesOf(after);
  if (beforeTypes === null && afterTypes === null) return null;
  if (beforeTypes === null && afterTypes !== null) return 'type added';
  if (beforeTypes === null || afterTypes === null) return null;
  return beforeTypes.some((type) => !afterTypes.includes(type)) ? 'type narrowed' : null;
}

function typeLoosened(before: SchemaObject, after: SchemaObject): 'type removed' | 'type widened' | null {
  const beforeTypes = typesOf(before);
  const afterTypes = typesOf(after);
  if (beforeTypes === null && afterTypes === null) return null;
  if (beforeTypes !== null && afterTypes === null) return 'type removed';
  if (beforeTypes === null || afterTypes === null) return null;
  return afterTypes.some((type) => !beforeTypes.includes(type)) ? 'type widened' : null;
}

function allowsExtras(schema: SchemaObject): boolean {
  return schema.additionalProperties !== false;
}

/**
 * The schema for names that are not declared properties.
 * `null` means extras are forbidden. `{}` means they are unrestricted.
 */
function extraSchema(schema: SchemaObject): SchemaObject | null {
  if (schema.additionalProperties === false) return null;
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') return schema.additionalProperties;
  return {};
}

/** Keywords beside `$ref` are not combined with the target. A difference fails closed. */
function refSiblingBreaks(
  before: SchemaObject,
  after: SchemaObject,
  at: string,
  kind: 'request_tightened' | 'response_loosened',
  allow: readonly UnsupportedSchemaAllow[],
): RouteBreak[] {
  const siblings = (schema: SchemaObject): Record<string, unknown> => {
    const fields = schema as SchemaObject & Record<string, unknown>;
    if (typeof fields.$ref !== 'string') return {};
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      if (key !== '$ref') copy[key] = fields[key];
    }
    return copy;
  };
  const left = siblings(before);
  const right = siblings(after);
  if (Object.keys(left).length === 0 && Object.keys(right).length === 0) return [];
  const keywords = new Set([...Object.keys(left), ...Object.keys(right)]);
  const breaks: RouteBreak[] = [];
  for (const keyword of [...keywords].sort()) {
    if (JSON.stringify(left[keyword]) === JSON.stringify(right[keyword])) continue;
    if (allow.some((entry) => entry.path === at && entry.keyword === keyword)) continue;
    breaks.push({ kind, path: at, detail: `unsupported schema difference: ${keyword}` });
  }
  return breaks;
}

/** Compared directly. Every other keyword difference fails closed. */
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'items',
  'additionalProperties',
  'properties',
  'required',
]);

export interface UnsupportedSchemaAllow {
  path: string;
  keyword: string;
}

function schemaFields(schema: SchemaObject): Record<string, unknown> {
  return schema as SchemaObject & Record<string, unknown>;
}

function unsupportedBreaks(
  before: SchemaObject,
  after: SchemaObject,
  at: string,
  kind: 'request_tightened' | 'response_loosened',
  allow: readonly UnsupportedSchemaAllow[],
): RouteBreak[] {
  const left = schemaFields(before);
  const right = schemaFields(after);
  const keywords = new Set([...Object.keys(left), ...Object.keys(right)]);
  const breaks: RouteBreak[] = [];
  for (const keyword of [...keywords].sort()) {
    if (SUPPORTED_KEYWORDS.has(keyword)) continue;
    if (JSON.stringify(left[keyword]) === JSON.stringify(right[keyword])) continue;
    if (allow.some((entry) => entry.path === at && entry.keyword === keyword)) continue;
    breaks.push({ kind, path: at, detail: `unsupported schema difference: ${keyword}` });
  }
  return breaks;
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

function patternLoosened(before: SchemaObject, after: SchemaObject): 'pattern removed' | 'pattern changed' | null {
  if (before.pattern === after.pattern) return null;
  if (before.pattern === undefined) return null;
  return after.pattern === undefined ? 'pattern removed' : 'pattern changed';
}

type SeenPairs = WeakMap<SchemaObject, WeakSet<SchemaObject>>;

function visited(seen: SeenPairs, left: SchemaObject, right: SchemaObject): boolean {
  const rights = seen.get(left);
  if (rights?.has(right)) return true;
  if (rights) rights.add(right);
  else {
    const created = new WeakSet<SchemaObject>();
    created.add(right);
    seen.set(left, created);
  }
  return false;
}

function requestBreaks(
  beforeDoc: OpenApiDocument,
  afterDoc: OpenApiDocument,
  beforeSchema: SchemaObject,
  afterSchema: SchemaObject,
  at: string,
  seen: SeenPairs,
  allow: readonly UnsupportedSchemaAllow[],
): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  breaks.push(...refSiblingBreaks(beforeSchema, afterSchema, at, 'request_tightened', allow));
  const before = resolve(beforeDoc, beforeSchema) ?? beforeSchema;
  const after = resolve(afterDoc, afterSchema) ?? afterSchema;
  if (visited(seen, before, after)) return breaks;
  breaks.push(...unsupportedBreaks(before, after, at, 'request_tightened', allow));
  const tighterType = typeTightened(before, after);
  if (tighterType) breaks.push({ kind: 'request_tightened', path: at, detail: tighterType });
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
  if (after.minimum !== undefined && (before.minimum === undefined || after.minimum > before.minimum)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'minimum increased' });
  }
  if (after.maximum !== undefined && (before.maximum === undefined || after.maximum < before.maximum)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'maximum decreased' });
  }
  if (allowsExtras(before) && !allowsExtras(after)) {
    breaks.push({ kind: 'request_tightened', path: at, detail: 'additional properties rejected' });
  }
  if (allowsExtras(before) && allowsExtras(after)
    && (typeof before.additionalProperties === 'object' || typeof after.additionalProperties === 'object')) {
    breaks.push(...requestBreaks(
      beforeDoc,
      afterDoc,
      extraSchema(before) ?? {},
      extraSchema(after) ?? {},
      `${at} additionalProperties`,
      seen,
      allow,
    ));
  }
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  for (const key of Object.keys(beforeProps)) {
    const afterProp = afterProps[key];
    if (!afterProp) {
      const declared = beforeProps[key];
      if (!allowsExtras(after)) {
        breaks.push({ kind: 'request_tightened', path: `${at}.${key}`, detail: 'property removed' });
      } else if (declared) {
        breaks.push(...requestBreaks(beforeDoc, afterDoc, declared, extraSchema(after) ?? {}, `${at}.${key}`, seen, allow));
      }
      continue;
    }
    breaks.push(...requestBreaks(beforeDoc, afterDoc, beforeProps[key] as SchemaObject, afterProp, `${at}.${key}`, seen, allow));
  }
  if (allowsExtras(before)) {
    const baseline = extraSchema(before) ?? {};
    for (const key of Object.keys(afterProps)) {
      if (key in beforeProps) continue;
      const declared = afterProps[key];
      if (!declared) continue;
      breaks.push(...requestBreaks(beforeDoc, afterDoc, baseline, declared, `${at}.${key}`, seen, allow));
    }
  }
  for (const key of afterRequired) {
    if (!beforeRequired.has(key)) {
      breaks.push({ kind: 'request_tightened', path: `${at}.${key}`, detail: 'property became required' });
    }
  }
  if (!before.items && after.items) {
    breaks.push({ kind: 'request_tightened', path: `${at}[]`, detail: 'items added' });
  } else if (before.items && after.items) {
    breaks.push(...requestBreaks(beforeDoc, afterDoc, before.items, after.items, `${at}[]`, seen, allow));
  }
  return breaks;
}

function responseBreaks(
  beforeDoc: OpenApiDocument,
  afterDoc: OpenApiDocument,
  beforeSchema: SchemaObject,
  afterSchema: SchemaObject,
  at: string,
  seen: SeenPairs,
  allow: readonly UnsupportedSchemaAllow[],
): RouteBreak[] {
  const breaks: RouteBreak[] = [];
  breaks.push(...refSiblingBreaks(beforeSchema, afterSchema, at, 'response_loosened', allow));
  const before = resolve(beforeDoc, beforeSchema) ?? beforeSchema;
  const after = resolve(afterDoc, afterSchema) ?? afterSchema;
  if (visited(seen, before, after)) return breaks;
  breaks.push(...unsupportedBreaks(before, after, at, 'response_loosened', allow));
  const looserType = typeLoosened(before, after);
  if (looserType) breaks.push({ kind: 'response_loosened', path: at, detail: looserType });
  if (enumRemoved(before, after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'enum removed' });
  } else if (enumWidened(before, after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'enum widened' });
  }
  const looserFormat = formatLoosened(before, after);
  if (looserFormat) breaks.push({ kind: 'response_loosened', path: at, detail: looserFormat });
  const looserPattern = patternLoosened(before, after);
  if (looserPattern) breaks.push({ kind: 'response_loosened', path: at, detail: looserPattern });
  if ((before.minLength ?? 0) > (after.minLength ?? 0)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'minLength decreased' });
  }
  if (before.maxLength !== undefined && (after.maxLength === undefined || after.maxLength > before.maxLength)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'maxLength increased' });
  }
  if (before.minimum !== undefined && (after.minimum === undefined || after.minimum < before.minimum)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'minimum decreased' });
  }
  if (before.maximum !== undefined && (after.maximum === undefined || after.maximum > before.maximum)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'maximum increased' });
  }
  if (!allowsExtras(before) && allowsExtras(after)) {
    breaks.push({ kind: 'response_loosened', path: at, detail: 'additional properties allowed' });
  }
  if (allowsExtras(before) && allowsExtras(after)
    && (typeof before.additionalProperties === 'object' || typeof after.additionalProperties === 'object')) {
    breaks.push(...responseBreaks(
      beforeDoc,
      afterDoc,
      extraSchema(before) ?? {},
      extraSchema(after) ?? {},
      `${at} additionalProperties`,
      seen,
      allow,
    ));
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
    breaks.push(...responseBreaks(beforeDoc, afterDoc, beforeProps[key] as SchemaObject, afterProp, `${at}.${key}`, seen, allow));
  }
  for (const key of Object.keys(afterProps)) {
    if (key in beforeProps) continue;
    const declared = afterProps[key];
    if (!declared) continue;
    if (!allowsExtras(before)) {
      breaks.push({ kind: 'response_loosened', path: `${at}.${key}`, detail: 'property added' });
    } else {
      breaks.push(...responseBreaks(beforeDoc, afterDoc, extraSchema(before) ?? {}, declared, `${at}.${key}`, seen, allow));
    }
  }
  if (before.items && !after.items) {
    breaks.push({ kind: 'response_loosened', path: `${at}[]`, detail: 'items removed' });
  } else if (before.items && after.items) {
    breaks.push(...responseBreaks(beforeDoc, afterDoc, before.items, after.items, `${at}[]`, seen, allow));
  }
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

export function findRouteBreaks(
  before: OpenApiDocument,
  after: OpenApiDocument,
  allow: readonly UnsupportedSchemaAllow[] = [],
): RouteBreak[] {
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
    if (old.operation.requestBody?.required !== true && found.operation.requestBody?.required === true) {
      breaks.push({ kind: 'request_tightened', path: operationId, detail: 'request body added' });
    }
    if (oldRequest && newRequest) breaks.push(...requestBreaks(before, after, oldRequest, newRequest, operationId, new WeakMap(), allow));
    else if (oldRequest && !newRequest) {
      breaks.push({ kind: 'request_tightened', path: operationId, detail: 'request body removed' });
    }
    for (const status of Object.keys(old.operation.responses ?? {})) {
      const oldResponse = resolve(before, jsonSchema(old.operation, 'response', status));
      const newResponse = resolve(after, jsonSchema(found.operation, 'response', status));
      if (oldResponse && newResponse) breaks.push(...responseBreaks(before, after, oldResponse, newResponse, `${operationId} ${status}`, new WeakMap(), allow));
      else if (oldResponse && !newResponse) {
        breaks.push({ kind: 'response_loosened', path: `${operationId} ${status}`, detail: 'response removed' });
      }
    }
  }
  breaks.push(...statusBreaks(before, after));
  return breaks;
}

export function unversionedRouteBreaks(
  before: OpenApiDocument,
  after: OpenApiDocument,
  allow: readonly UnsupportedSchemaAllow[] = [],
): RouteBreak[] {
  const breaks = findRouteBreaks(before, after, allow);
  if (breaks.length === 0) return [];
  if (major(before.info.version) !== major(after.info.version)) return [];
  return breaks;
}
