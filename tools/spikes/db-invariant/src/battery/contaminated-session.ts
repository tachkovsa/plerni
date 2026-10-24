// SPDX-License-Identifier: Apache-2.0
// contaminated-session.ts — battery §3.2.3. Every class that survives transaction-mode reuse:
// tenant GUC, SET ROLE (T2 membership fixture), search_path, a first-use connection, and
// ALTER ROLE … SET via the superuser credential. Cleanup cost is measured.
// terminations == injected contaminations, including a warm tail that must add zero.
// Injection counts are fixed at the injection site: 1 for a single session SET, and
// MAX_RETRY+1 for a class that contaminates every new login. They are not copied
// from the termination list. A warm client afterwards adds none.
// A probe whose outcome is environmental noise is not folded in as zero. It marks
// the aggregate invalid, and the equality case records that instead of a stable failure.
import { sql } from 'kysely';
import { adminShow, direct, pooled, rawApp, terminateBackendByPid } from '../client.ts';
import { MAX_RETRY, withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from '../cases/a2-oracle.ts';
import {
  blankEv, drainAppBackends, rawRoleDefault, rawSearchPath, rawSessionGuc, rawSetRole,
  readRows, recordProbe, recoverInjected, resetAppTenantDefault, setAppTenantDefault, type Probe, type Recovery,
} from '../cases/a3-pgbouncer.ts';

async function freshPool() {
  await drainAppBackends();
  return pooled(1);
}

function detailOf(rec: Recovery, injectedLogins: number): Record<string, unknown> {
  return {
    terminations: rec.terminations,
    injectedLogins,
    retries: rec.retries,
    cleanupMs: rec.cleanupMs,
    deadPid: rec.deadPid,
    deadGone: rec.deadGone,
    backendGoneMs: rec.backendGoneMs,
    detectedBeforeAccess: rec.detectedBeforeAccess,
    positiveControl: rec.positive,
    absenceOnReplacement: rec.replacementAbsent,
    rivalPid: rec.rivalPid,
    rivalGuc: rec.rivalGuc,
    rivalWaiting: rec.rivalWaiting,
    rivalHeldOff: rec.rivalHeldOff,
    rivalTimedOut: rec.rivalTimedOut,
    thrown: rec.thrown,
  };
}

function asCount(detail: Record<string, unknown>): number {
  const n = detail.terminations;
  // An established failure that threw has already been recorded. Keep later cases running.
  return typeof n === 'number' ? n : 0;
}

/** Fold a probe into the totals. A noisy probe invalidates the aggregate instead of adding zero. */
function absorb(
  observed: Probe,
  budget: number,
  totals: { injected: number; terminated: number; invalid: boolean },
): void {
  if (observed.detail.outcome === 'environmental-noise') {
    totals.invalid = true;
    return;
  }
  totals.injected += budget;
  totals.terminated += asCount(observed.detail);
}

async function searchPathConfig(): Promise<Record<string, unknown>> {
  const config = await adminShow('CONFIG') as Record<string, unknown>[];
  const value = (key: string) => config.find((row) => row.key === key)?.value ?? null;
  const pgbouncerVersion = await adminShow('VERSION');
  const app = rawApp();
  await app.connect();
  try {
    const pg = await app.query(`SELECT current_setting('server_version') AS version`);
    const raw = String(pg.rows[0]?.version ?? '');
    const match = /^[0-9]+(?:\.[0-9]+)*/.exec(raw);
    return {
      track_extra_parameters: value('track_extra_parameters'),
      server_reset_query: value('server_reset_query'),
      server_reset_query_always: value('server_reset_query_always'),
      pgbouncerVersion,
      postgresVersion: match?.[0] ?? null,
    };
  } finally {
    await app.end();
  }
}

export async function contaminatedSession(): Promise<void> {
  const totals = { injected: 0, terminated: 0, invalid: false };

  // Reuse path: a clean protocol use, then a session GUC on that same backend.
  const warm = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated tenant GUC', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await withTenant(warm, TENANT_B, ev, terminateBackendByPid, readRows);
        const before = ev.terminatedBackendPids.length;
        await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(warm);
        const rec = await recoverInjected(warm, ev, before);
        return { pass: before === 0 && rec.pass, detail: { ...detailOf(rec, 1), warmTerminations: before } };
      },
      rawSessionGuc,
    );
    absorb(observed, 1, totals);
  } finally {
    await warm.destroy();
  }

  const role = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated SET ROLE', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET ROLE plerni_plugin_a`.execute(role);
        const rec = await recoverInjected(role, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec, 1) };
      },
      rawSetRole,
    );
    absorb(observed, 1, totals);
  } finally {
    await role.destroy();
  }

  // Direct: killing the backend yields a fresh login, so the protocol recovers.
  const directPath = direct(1);
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'direct(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(directPath);
        const rec = await recoverInjected(directPath, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec, 1) };
      },
      rawSearchPath,
    );
    absorb(observed, 1, totals);
  } finally {
    await directPath.destroy();
  }

  // Pooled: search_path is in PgBouncer's built-in variable cache on PostgreSQL 18, so an
  // empty track_extra_parameters does not stop replay onto a surviving client. The protocol
  // discards that client session after the backend kill. Killing while the server is still
  // linked also closes the client on this pooler; the discard covers a socket that stays up.
  const path = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated search_path', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SET search_path TO pg_catalog`.execute(path);
        const rec = await recoverInjected(path, ev, 0);
        const searchAlerts = ev.alerts.filter((a) => a.includes('search_path')).length;
        return {
          pass: rec.pass && searchAlerts === 1,
          detail: {
            ...detailOf(rec, 1),
            searchAlerts,
            discardedPoolerSessions: ev.discardedPoolerSessions,
            config: await searchPathConfig(),
            mechanism: 'Discard the pooler client session after the backend kill. A surviving client replays search_path; an empty track_extra_parameters does not disable that cache.',
          },
        };
      },
      rawSearchPath,
    );
    absorb(observed, 1, totals);
  } finally {
    await path.destroy();
  }

  // First protocol use on a connection that has never been clean.
  const first = await freshPool();
  try {
    const observed = await recordProbe(
      { case: 'battery contaminated first-use', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        await sql`SELECT set_config('plerni.tenant_id', ${TENANT_A}, false)`.execute(first);
        const rec = await recoverInjected(first, ev, 0);
        return { pass: rec.pass, detail: detailOf(rec, 1) };
      },
      rawSessionGuc,
    );
    absorb(observed, 1, totals);
  } finally {
    await first.destroy();
  }

  // Role default re-applies on every login, so killing the backend cannot clear it.
  // The protocol must fail loud inside the retry budget — one termination per contaminated login.
  let defDb: ReturnType<typeof pooled> | undefined;
  try {
    await setAppTenantDefault(TENANT_A);
    await drainAppBackends();
    const db = pooled(1);
    defDb = db;
    const observed = await recordProbe(
      { case: 'battery contaminated ALTER ROLE default', datasource: 'pooled(1)' },
      async () => {
        const ev = blankEv();
        const t0 = performance.now();
        let loud: string | null = null;
        try {
          await withTenant(db, TENANT_B, ev, terminateBackendByPid, readRows);
        } catch (e) {
          loud = e instanceof Error ? e.message : String(e);
        }
        const cleanupMs = Math.round(performance.now() - t0);
        const expected = MAX_RETRY + 1;
        return {
          pass: loud !== null && loud.includes('loud failure') && ev.terminatedBackendPids.length === expected,
          detail: {
            loud, terminations: ev.terminatedBackendPids.length, injectedLogins: expected,
            expected, cleanupMs, alerts: ev.alerts,
          },
        };
      },
      rawRoleDefault,
    );
    absorb(observed, MAX_RETRY + 1, totals);
  } finally {
    await defDb?.destroy();
    await resetAppTenantDefault();
    await drainAppBackends();
  }

  const tail = await freshPool();
  try {
    await recordProbe(
      { case: 'battery terminations == injected', datasource: 'pooled(1)' },
      async () => {
        if (totals.invalid) {
          return {
            pass: false,
            detail: {
              outcome: 'environmental-noise',
              injected: totals.injected,
              terminated: totals.terminated,
              reason: 'an upstream contamination probe was environmental noise, so the aggregate has no verdict',
            },
          };
        }
        const tailEv = blankEv();
        await withTenant(tail, TENANT_A, tailEv, terminateBackendByPid, readRows);
        await withTenant(tail, TENANT_B, tailEv, terminateBackendByPid, readRows);
        return {
          pass: tailEv.terminatedBackendPids.length === 0 && totals.terminated === totals.injected,
          detail: {
            injected: totals.injected,
            terminated: totals.terminated,
            warmTailTerminations: tailEv.terminatedBackendPids.length,
            counting: 'injected is the sum of per-class login budgets; terminated is the measured count',
          },
        };
      },
      rawSessionGuc,
    );
  } finally {
    await tail.destroy();
  }
}
