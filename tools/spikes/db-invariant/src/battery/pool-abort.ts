// pool-abort.ts — battery §3.2.1: pool reuse after abort.
// A transaction installs context and then aborts. The reused backend must show A2(c)
// (normalized absence) and the two-layer fail-closed pair: RLS returns zero rows, the app guard raises.
import { sql } from 'kysely';
import { direct, pooled, terminateBackendByPid } from '../client.ts';
import { installTenantContext } from '../context.ts';
import { TENANT_B } from '../cases/a2-oracle.ts';
import { absenceOn, blankEv, drainAppBackends, rawRollbackClearsContext, recordProbe } from '../cases/a3-pgbouncer.ts';

async function abortOn(label: 'pooled' | 'direct', make: () => ReturnType<typeof direct>): Promise<void> {
  const db = make();
  try {
    await recordProbe(
      { case: 'battery pool-abort', datasource: label },
      async () => {
        const ev = blankEv();
        let installedPid = 0;
        let aborted = false;
        try {
          await db.transaction().execute(async (trx) => {
            await installTenantContext(trx, TENANT_B, ev);
            installedPid = Number((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid);
            throw new Error('planned abort');
          });
        } catch (e) {
          aborted = e instanceof Error && e.message === 'planned abort';
        }
        const after = await absenceOn(db);
        return {
          pass: aborted && after.absent && after.rows === 0 && after.guard
            && after.pid === installedPid && ev.terminatedBackendPids.length === 0,
          detail: { aborted, installedPid, after, terminations: ev.terminatedBackendPids.length },
        };
      },
      () => rawRollbackClearsContext(TENANT_B),
    );
  } finally {
    await db.destroy();
  }
}

export async function poolAbort(): Promise<void> {
  await drainAppBackends();
  await abortOn('pooled', () => pooled(1));
  await abortOn('direct', () => direct());
}
