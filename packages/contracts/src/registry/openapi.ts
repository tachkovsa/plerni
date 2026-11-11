// SPDX-License-Identifier: Apache-2.0
// OpenAPI 3.1 comes from the zod registry (spec §10, convention R1.1).
// OpenApiGeneratorV31 is the 3.1 generator. Plugin-private routes are not registered.
import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ZodType } from 'zod';
import { ERROR_CODES, errorStatus } from '../error/codes.ts';
import { errorEnvelopeSchema } from '../error/envelope.ts';
import { KERNEL_API_VERSION, kernelRoutes } from './routes.ts';
import type { OpenApiDocument, OperationObject, RouteContract, SchemaObject } from './types.ts';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function assertUnique(routes: readonly RouteContract[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const names = new Set<string>(['ErrorEnvelope']);
  for (const route of routes) {
    if (ids.has(route.operationId)) throw new Error(`duplicate operation id ${route.operationId}`);
    ids.add(route.operationId);
    const key = `${route.method} ${route.path}`;
    if (paths.has(key)) throw new Error(`duplicate route ${key}`);
    paths.add(key);
    if (route.visibility !== 'public') continue;
    for (const name of [route.request?.schemaName, route.success.schemaName]) {
      if (!name) continue;
      if (names.has(name)) throw new Error(`duplicate schema ${name}`);
      names.add(name);
    }
    for (const code of route.errors) {
      if (errorStatus(code) === route.success.status) {
        throw new Error(`${route.operationId} uses ${code} on its success status`);
      }
    }
  }
}

function asDocument(value: unknown): OpenApiDocument {
  if (!value || typeof value !== 'object') throw new Error('OpenAPI generator returned no document');
  const document = value as OpenApiDocument;
  if (document.openapi !== '3.1.0') throw new Error('OpenAPI generator did not emit 3.1.0');
  document.paths ??= {};
  document.components ??= { schemas: {} };
  document.components.schemas ??= {};
  return document;
}

function operationOf(document: OpenApiDocument, route: RouteContract): OperationObject {
  const operation = document.paths[route.path]?.[route.method];
  if (!operation) throw new Error(`generator omitted ${route.operationId}`);
  return operation;
}

function stamp(document: OpenApiDocument, route: RouteContract): void {
  const operation = operationOf(document, route);
  if (route.action) operation['x-plerni-action'] = route.action;
  if (route.scope) operation['x-plerni-scope'] = route.scope;
  if (route.deprecation) {
    operation.deprecated = true;
    operation['x-plerni-deprecation'] = { since: route.deprecation.since, until: route.deprecation.until };
    const schema: SchemaObject | undefined = document.components.schemas[route.success.schemaName];
    if (!schema) throw new Error(`generator omitted ${route.success.schemaName}`);
    schema['x-plerni-deprecation'] = { since: route.deprecation.since, until: route.deprecation.until };
  }
  for (const code of route.errors) {
    const response = operation.responses?.[String(errorStatus(code))];
    if (!response) throw new Error(`generator omitted ${route.operationId} ${code}`);
    response['x-plerni-error-code'] = code;
  }
}

export function generateOpenApi(routes: readonly RouteContract[], version = KERNEL_API_VERSION): OpenApiDocument {
  assertUnique(routes);
  const registry = new OpenAPIRegistry();
  const envelope = registry.register('ErrorEnvelope', errorEnvelopeSchema);
  for (const route of routes) {
    if (route.visibility !== 'public') continue;
    const success = registry.register(route.success.schemaName, route.success.schema);
    const request = route.request ? registry.register(route.request.schemaName, route.request.schema) : undefined;
    const responses: Record<string, { description: string; content: { 'application/json': { schema: ZodType } } }> = {
      [String(route.success.status)]: {
        description: route.success.description,
        content: { 'application/json': { schema: success } },
      },
    };
    for (const code of route.errors) {
      responses[String(errorStatus(code))] = {
        description: code,
        content: { 'application/json': { schema: envelope } },
      };
    }
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      summary: route.summary,
      ...(request
        ? { request: { body: { required: true, content: { 'application/json': { schema: request } } } } }
        : {}),
      responses,
    });
  }
  const generated = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Plerni kernel API', version },
  });
  const document = asDocument(JSON.parse(JSON.stringify(generated)) as unknown);
  document['x-plerni-error-statuses'] = Object.fromEntries(ERROR_CODES.map((code) => [code, errorStatus(code)]));
  for (const route of routes) {
    if (route.visibility === 'public') stamp(document, route);
  }
  return document;
}

export function generateKernelOpenApi(): OpenApiDocument {
  return generateOpenApi(kernelRoutes);
}

export function handWrittenPaths(document: OpenApiDocument, routes: readonly RouteContract[]): string[] {
  const expected = new Map<string, string>();
  for (const route of routes) {
    if (route.visibility !== 'public') continue;
    expected.set(`${route.method} ${route.path}`, route.operationId);
  }
  const problems: string[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item?.[method];
      if (!operation) continue;
      const key = `${method} ${path}`;
      if (expected.get(key) !== operation.operationId) problems.push(key);
    }
  }
  for (const key of expected.keys()) {
    const space = key.indexOf(' ');
    const method = key.slice(0, space) as RouteContract['method'];
    const path = key.slice(space + 1);
    if (!document.paths[path]?.[method]) problems.push(key);
  }
  return problems;
}

/** Review fails when the document contains a path the registry did not declare. */
export function assertOpenApiReview(document: OpenApiDocument, routes: readonly RouteContract[]): void {
  const problems = handWrittenPaths(document, routes);
  if (problems.length > 0) throw new Error(`hand-written path: ${problems.join(', ')}`);
}
