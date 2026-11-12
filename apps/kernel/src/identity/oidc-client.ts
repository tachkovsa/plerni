// SPDX-License-Identifier: Apache-2.0
// Authorization code + PKCE S256 via openid-client 6.8.9.
// The token response stays in this function. Callers receive claims only.
import * as client from 'openid-client';
import { LoginRejectedError, OidcUnavailableError } from './errors.ts';

const OPAQUE = /^[A-Za-z0-9_-]{43,128}$/;

export interface OidcClaims {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

export function newPkce(): { verifier: string; challenge: Promise<string> } {
  const verifier = client.randomPKCECodeVerifier();
  return { verifier, challenge: client.calculatePKCECodeChallenge(verifier) };
}

export function newNonce(): string {
  return client.randomNonce();
}

export function assertOpaque(value: string): string {
  if (!OPAQUE.test(value)) throw new LoginRejectedError();
  return value;
}

async function discovered(issuer: string, clientId: string, clientSecret: string): Promise<client.Configuration> {
  // HTTP is accepted only for a loopback issuer. The library otherwise refuses it.
  const server = new URL(issuer);
  try {
    if (server.protocol === 'http:') {
      if (server.hostname !== '127.0.0.1') throw new OidcUnavailableError();
      return await client.discovery(server, clientId, clientSecret, undefined, {
        execute: [client.allowInsecureRequests],
      });
    }
    return await client.discovery(server, clientId, clientSecret);
  } catch {
    throw new OidcUnavailableError();
  }
}

export async function authorizationUrl(input: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): Promise<URL> {
  const config = await discovered(input.issuer, input.clientId, input.clientSecret);
  try {
    return client.buildAuthorizationUrl(config, {
      redirect_uri: input.redirectUri,
      scope: 'openid email',
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      state: input.state,
      nonce: input.nonce,
    });
  } catch {
    throw new OidcUnavailableError();
  }
}

export async function redeemCode(input: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  currentUrl: URL;
  codeVerifier: string;
  expectedState: string;
  expectedNonce: string;
  expectedIssuer: string;
}): Promise<OidcClaims> {
  if (input.currentUrl.searchParams.get('iss') !== input.expectedIssuer) throw new LoginRejectedError();
  if (!input.currentUrl.searchParams.get('code') || input.currentUrl.searchParams.has('error')) {
    throw new LoginRejectedError();
  }
  const config = await discovered(input.issuer, input.clientId, input.clientSecret);
  let claims: client.IDToken | undefined;
  let accessToken: string | undefined;
  try {
    const tokens = await client.authorizationCodeGrant(config, input.currentUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.expectedState,
      expectedNonce: input.expectedNonce,
    });
    claims = tokens.claims();
    if (typeof tokens.access_token === 'string') accessToken = tokens.access_token;
  } catch {
    throw new LoginRejectedError();
  }
  if (!claims || claims.iss !== input.expectedIssuer || typeof claims.sub !== 'string') {
    throw new LoginRejectedError();
  }
  if (claims.sub.length < 1 || claims.sub.length > 200 || /\s/.test(claims.sub)) throw new LoginRejectedError();
  let email = typeof claims.email === 'string' ? claims.email : null;
  let emailVerified = claims.email_verified === true;
  if ((!email || !emailVerified) && accessToken) {
    try {
      const info = await client.fetchUserInfo(config, accessToken, claims.sub);
      if (typeof info.email === 'string') email = info.email;
      emailVerified = info.email_verified === true;
    } catch {
      throw new LoginRejectedError();
    }
  }
  return {
    issuer: input.expectedIssuer,
    subject: claims.sub,
    email,
    emailVerified,
  };
}
