// SPDX-License-Identifier: Apache-2.0
// argon2id via @noble/hashes 2.4.0 (RFC 9106). Parameters are the OWASP
// Password Storage Cheat Sheet minimum: m=19456 KiB, t=2, p=1.
// The PHC string is the stored form. Verification accepts only these parameters.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { IdentityValidationError } from './errors.ts';

const PARAMS = { t: 2, m: 19_456, p: 1, dkLen: 32 } as const;
/** Bytes. The library compares this with the 1024-byte block allocation. */
const MAXMEM = 32 * 1024 * 1024;
const SALT_BYTES = 16;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/u, '');
}

function fromB64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function passwordBytes(password: string): Uint8Array | null {
  if (typeof password !== 'string') return null;
  const value = password.normalize('NFC');
  if (value.length < 12 || value.length > 128 || value.includes('\0')) return null;
  return new TextEncoder().encode(value);
}

async function derive(secret: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return argon2idAsync(secret, salt, { ...PARAMS, maxmem: MAXMEM, asyncTick: 10 });
}

/** Argon2id PHC string. Used for passwords and for rescue codes. */
export async function hashArgon2id(secret: Uint8Array): Promise<string> {
  if (secret.length < 12 || secret.length > 128) throw new IdentityValidationError();
  const salt = randomBytes(SALT_BYTES);
  const digest = await derive(secret, salt);
  return `$argon2id$v=19$m=${PARAMS.m},t=${PARAMS.t},p=${PARAMS.p}$${b64(salt)}$${b64(digest)}`;
}

export async function verifyArgon2id(encoded: string, secret: Uint8Array): Promise<boolean> {
  const match = PHC.exec(encoded);
  if (!match) return false;
  const m = Number(match[1]);
  const t = Number(match[2]);
  const p = Number(match[3]);
  if (m !== PARAMS.m || t !== PARAMS.t || p !== PARAMS.p) return false;
  const salt = fromB64(match[4] ?? '');
  const expected = fromB64(match[5] ?? '');
  if (salt.length !== SALT_BYTES || expected.length !== PARAMS.dkLen) return false;
  let actual: Uint8Array;
  try {
    actual = await derive(secret, salt);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export async function hashPassword(password: string): Promise<string> {
  const secret = passwordBytes(password);
  if (!secret) throw new IdentityValidationError('password rejected');
  return hashArgon2id(secret);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const secret = passwordBytes(password);
  if (!secret) return false;
  return verifyArgon2id(encoded, secret);
}
