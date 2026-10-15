// SPDX-License-Identifier: Apache-2.0
// interleave.ts — battery §3.2.2: interleaved tenants on a pool of size 1.
// Visibility tracks the transaction-local context. Positive controls run both ways (A then B).
// One backend serves the whole sequence: a fresh server connection would make the oracle vacuous.
import { sql } from 'kysely';
import { pooled, terminateBackendByPid } from '../client.ts';
import { withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from '../cases/a2-oracle.ts';
import { blankEv, drainAppBackends, onlyTenant, rawInterleave, readRows, recordProbe } from '../cases/a3-pgbouncer.ts';

const ORDER = [TENANT_A, TENANT_B, TENANT_A, TENANT_B] as const;

export async function interleave(): Promise<void> {
  await drainAppBackends();
  const db = pooled(1);
  try {
    await recordProbe(
      { case: 'battery interleave', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        const seen: { want: string; tenant: string; pid: number; ok: boolean }[] = [];
        for (const want of ORDER) {
          const got = await withTenant(db, want, ev, terminateBackendByPid, async (trx) => {
            const pid = Number((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid);
            const rows = await readRows(trx);
            return { pid, tenant: rows[0]?.tenant_id ?? '', ok: onlyTenant(rows, want) };
          });
          seen.push({ want, tenant: got.tenant, pid: got.pid, ok: got.ok });
        }
        const aOk = seen.filter((s) => s.want === TENANT_A).every((s) => s.ok);
        const bOk = seen.filter((s) => s.want === TENANT_B).every((s) => s.ok);
        const sameBackend = seen.length === ORDER.length && new Set(seen.map((s) => s.pid)).size === 1;
        return {
          pass: aOk && bOk && sameBackend && ev.terminatedBackendPids.length === 0,
          detail: {
            seen, positiveControlA: aOk, positiveControlB: bOk, sameBackend,
            terminations: ev.terminatedBackendPids.length,
          },
        };
      },
      rawInterleave,
    );
  } finally {
    await db.destroy();
  }
}
