// SPDX-License-Identifier: Apache-2.0
import type { ZodType } from 'zod';
import type { ErrorCode } from '../error/codes.ts';

export interface DeprecationWindow {
  since: string;
  until: string;
}

export interface RouteSchema {
  schemaName: string;
  schema: ZodType;
}

export interface RouteContract {
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  visibility: 'public' | 'plugin-private';
  action?: 'routine' | 'sensitive' | 'destructive';
  scope?: 'platform' | 'tenant';
  deprecation?: DeprecationWindow;
  request?: RouteSchema;
  success: {
    status: number;
    description: string;
    schemaName: string;
    schema: ZodType;
  };
  errors: readonly ErrorCode[];
}

export interface SchemaObject {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  enum?: string[];
  items?: SchemaObject;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  description?: string;
  'x-plerni-deprecation'?: DeprecationWindow;
}

export interface ResponseObject {
  description?: string;
  content?: { 'application/json'?: { schema?: SchemaObject } };
  'x-plerni-error-code'?: ErrorCode;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
  requestBody?: {
    required?: boolean;
    content?: { 'application/json'?: { schema?: SchemaObject } };
  };
  responses?: Record<string, ResponseObject>;
  'x-plerni-action'?: 'routine' | 'sensitive' | 'destructive';
  'x-plerni-scope'?: 'platform' | 'tenant';
  'x-plerni-deprecation'?: DeprecationWindow;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Partial<Record<RouteContract['method'], OperationObject>>>;
  components: { schemas: Record<string, SchemaObject> };
  'x-plerni-error-statuses': Record<string, number>;
}
