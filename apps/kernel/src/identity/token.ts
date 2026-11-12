// SPDX-License-Identifier: Apache-2.0
// Opaque session and reset tokens are 256-bit random values. The row stores
// sha256 so a lookup does not keep the secret. Low-entropy secrets use argon2id.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BOOTSTRAP_ENV = 'PLERNI_BOOTSTRAP_CREDENTIAL';

export function newSecretToken(): string {
  return randomBytes(32).toString('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function presentedToken(token: string): string | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  return sha256Hex(token);
}

/** Compare two secrets without putting either value into a thrown error. */
export function credentialMatches(presented: string): boolean {
  const expected = process.env[BOOTSTRAP_ENV];
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 512) return false;
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
