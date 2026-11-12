// SPDX-License-Identifier: Apache-2.0
// K16 replaces this with Valkey. A hit must not authorize: the session row
// and user_auth_state remain the revocation authority (spec §6).

export interface FreshnessLease {
  read(tokenHash: string): { epoch: string; freshUntilMs: number } | null;
}

export const absentLease: FreshnessLease = {
  read: () => null,
};
