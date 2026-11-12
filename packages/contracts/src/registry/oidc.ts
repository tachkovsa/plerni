// SPDX-License-Identifier: Apache-2.0
// Configure-OIDC and the authorization-code login (plan §5.2, K4).
// The callback returns a local session token. An IdP token is not that token.
import { z } from 'zod';
import type { RouteContract } from './types.ts';

const ISSUER = z.string().min(12).max(300);
const CLIENT_ID = z.string().regex(/^[A-Za-z0-9._~-]{1,200}$/);
const REDIRECT = z.string().min(12).max(300);

export const oidcConfigureRequestSchema = z.strictObject({
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: z.string().min(16).max(200),
  redirectUri: REDIRECT,
});

export const oidcConfigureResponseSchema = z.strictObject({
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT,
});

export const oidcAuthorizeRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  redirectUri: REDIRECT,
});

export const oidcAuthorizeResponseSchema = z.strictObject({
  authorizationUrl: z.string().min(12).max(4000),
});

export const oidcCallbackResponseSchema = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  userId: z.uuid(),
  sessionKind: z.enum(['admin', 'member']),
});

export const kernelOidcConfigure: RouteContract = {
  operationId: 'kernel.oidc.configure',
  method: 'post',
  path: '/kernel/oidc',
  summary: 'Configure the tenant OIDC issuer. The response does not include the client secret.',
  visibility: 'public',
  action: 'sensitive',
  scope: 'tenant',
  request: {
    schemaName: 'OidcConfigureRequest',
    schema: oidcConfigureRequestSchema,
  },
  success: {
    status: 200,
    description: 'The stored issuer, client id, and exact redirect URI.',
    schemaName: 'OidcConfigureResponse',
    schema: oidcConfigureResponseSchema,
  },
  errors: ['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'INTERNAL'],
};

export const kernelOidcAuthorize: RouteContract = {
  operationId: 'kernel.oidc.authorize',
  method: 'post',
  path: '/kernel/oidc/authorizations',
  summary: 'Start an authorization-code login. The redirect URI must match the configured value exactly.',
  visibility: 'public',
  authentication: 'none',
  request: {
    schemaName: 'OidcAuthorizeRequest',
    schema: oidcAuthorizeRequestSchema,
  },
  success: {
    status: 200,
    description: 'The identity-provider authorization URL for this exact redirect URI.',
    schemaName: 'OidcAuthorizeResponse',
    schema: oidcAuthorizeResponseSchema,
  },
  errors: ['VALIDATION', 'NOT_FOUND', 'UNAVAILABLE', 'INTERNAL'],
};

export const kernelOidcCallback: RouteContract = {
  operationId: 'kernel.oidc.callback',
  method: 'get',
  path: '/kernel/oidc/callback',
  summary: 'Finish the authorization code login and return a local session token.',
  visibility: 'public',
  authentication: 'none',
  success: {
    status: 200,
    description: 'A local session token. An identity-provider token is not accepted as this token.',
    schemaName: 'OidcCallbackResponse',
    schema: oidcCallbackResponseSchema,
  },
  errors: ['UNAUTHENTICATED', 'UNAVAILABLE', 'INTERNAL'],
};
