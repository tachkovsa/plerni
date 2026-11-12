// SPDX-License-Identifier: Apache-2.0
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import { IdentityValidationError } from './errors.ts';
import { absentLease, type FreshnessLease } from './lease.ts';
import type { IdentityLog } from './log.ts';

export const FRESHNESS_MINUTES = 5;
export const ADMIN_SESSION_HOURS = 1;
export const MEMBER_IDLE_HOURS = 12;
export const MEMBER_ABSOLUTE_DAYS = 7;
export const RESET_MINUTES = 60;
export const THROTTLE_LIMIT = 5;
export const THROTTLE_WINDOW_MINUTES = 15;

export type RouteClass = 'read' | 'routine' | 'sensitive' | 'destructive';
export type AccountKind = 'admin' | 'member';
export type ValidationMode = 'lease' | 'per_request';

export interface IdentityContext {
  evidence: HygieneEvidence;
  terminate: (pid: number) => Promise<void>;
  log: IdentityLog;
  lease?: FreshnessLease;
}

export function leaseOf(ctx: IdentityContext): FreshnessLease {
  return ctx.lease ?? absentLease;
}

export function demandsPerRequest(routeClass: RouteClass, sessionKind: AccountKind, strictDisable: boolean): boolean {
  return strictDisable || sessionKind === 'admin' || routeClass === 'sensitive' || routeClass === 'destructive';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function canonicalUuid(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new IdentityValidationError('uuid rejected');
  }
  return value.toLowerCase();
}

export function canonicalEmail(email: string): string {
  if (typeof email !== 'string') throw new IdentityValidationError('email rejected');
  const value = email.trim().toLowerCase();
  if (value.length < 3 || value.length > 200 || !EMAIL.test(value)) {
    throw new IdentityValidationError('email rejected');
  }
  return value;
}
