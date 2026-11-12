// SPDX-License-Identifier: Apache-2.0
// Identity logs carry ids and fixed outcome words. Field values that are not
// on this list are dropped, so a password, token, rescue code, or credential
// cannot ride along in a field.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ID_FIELDS = new Set([
  'operatorTenantId',
  'customerTenantId',
  'tenantId',
  'userId',
  'principalId',
]);

const WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  action: new Set([
    'login', 'login_rejected', 'refresh', 'logout', 'disable', 'rescue', 'reset', 'create', 'bootstrap',
    'provision', 'rotate', 'revoke',
  ]),
  outcome: new Set(['rejected', 'closed', 'accepted', 'disabled', 'throttled']),
  validation: new Set(['lease', 'per_request']),
};

export interface IdentityLog {
  event(name: string, fields?: Readonly<Record<string, string | number>>): void;
}

export function createIdentityLog(write: (line: string) => void): IdentityLog {
  return {
    event(name, fields = {}) {
      const safe: Record<string, string | number> = {};
      if (!/^[a-z][a-z.]{0,40}$/.test(name)) return;
      for (const [key, value] of Object.entries(fields)) {
        if (ID_FIELDS.has(key)) {
          if (typeof value === 'string' && UUID.test(value)) safe[key] = value;
          continue;
        }
        if (key === 'epoch' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          safe[key] = value;
          continue;
        }
        const allowed = WORDS[key];
        if (allowed && typeof value === 'string' && allowed.has(value)) safe[key] = value;
      }
      write(JSON.stringify({ event: name, ...safe }));
    },
  };
}
