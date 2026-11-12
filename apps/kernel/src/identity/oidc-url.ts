// SPDX-License-Identifier: Apache-2.0
// Exact issuer and redirect strings. A parsed URL that differs from the
// input is rejected, so a prefix or a rewritten host cannot pass.
import { IdentityValidationError } from './errors.ts';

function parsed(value: string): URL {
  if (typeof value !== 'string' || value.length < 12 || value.length > 300) {
    throw new IdentityValidationError('url rejected');
  }
  try {
    return new URL(value);
  } catch {
    throw new IdentityValidationError('url rejected');
  }
}

function allowed(url: URL): void {
  if (url.username || url.password || url.search || url.hash) {
    throw new IdentityValidationError('url rejected');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return;
  throw new IdentityValidationError('url rejected');
}

/** Issuer identifier with no path. The stored value is the URL origin. */
export function exactIssuer(value: string): string {
  const url = parsed(value);
  allowed(url);
  if (url.pathname !== '/' || value !== url.origin) throw new IdentityValidationError('issuer rejected');
  return value;
}

/** Redirect URI with a path. The stored value is origin plus pathname, unchanged. */
export function exactRedirect(value: string): string {
  const url = parsed(value);
  allowed(url);
  if (url.pathname === '/') throw new IdentityValidationError('redirect rejected');
  if (value !== `${url.origin}${url.pathname}`) throw new IdentityValidationError('redirect rejected');
  return value;
}

export function callbackMatches(redirectUri: string, current: URL): boolean {
  return `${current.origin}${current.pathname}` === redirectUri;
}

const CLIENT_ID = /^[A-Za-z0-9._~-]{1,200}$/;

export function exactClientId(value: string): string {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) throw new IdentityValidationError('client rejected');
  return value;
}

export function exactSecret(value: string): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 200 || /\s/.test(value)) {
    throw new IdentityValidationError('secret rejected');
  }
  return value;
}
