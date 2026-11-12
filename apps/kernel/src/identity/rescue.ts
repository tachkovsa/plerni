// SPDX-License-Identifier: Apache-2.0
// Single-use rescue codes. The plaintext is returned once. The row stores argon2id.
import { randomBytes } from 'node:crypto';
import { hashArgon2id, verifyArgon2id } from './password.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RESCUE_CODE_COUNT = 8;

export function newRescueCode(): string {
  const bytes = randomBytes(16);
  let raw = '';
  for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function canonicalRescueCode(code: string): Uint8Array | null {
  if (typeof code !== 'string') return null;
  const compact = code.replace(/-/g, '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(compact)) return null;
  return new TextEncoder().encode(compact);
}

export async function generateRescueSet(): Promise<{ plaintext: string[]; hashes: string[] }> {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < RESCUE_CODE_COUNT; i += 1) {
    const code = newRescueCode();
    const bytes = canonicalRescueCode(code);
    if (!bytes) throw new Error('rescue code generator produced an unusable code');
    plaintext.push(code);
    hashes.push(await hashArgon2id(bytes));
  }
  return { plaintext, hashes };
}

export async function rescueCodeMatches(encoded: string, code: string): Promise<boolean> {
  const bytes = canonicalRescueCode(code);
  if (!bytes) return false;
  return verifyArgon2id(encoded, bytes);
}
