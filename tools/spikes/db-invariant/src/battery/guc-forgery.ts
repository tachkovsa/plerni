// guc-forgery.ts — battery §3.2.4. Prototype evidence, scope "classifier shape" only.
// Phase attribution (plan §3.2.4 / γ-N6): admission-parser machinery is P2 (spec §4.3);
// the tenancy-gate GUC-forgery suite is spec §12 / P1; the §16.13 acceptance test is P3.
// (a) a declared query that smuggles set_config is rejected by an allowlist, not a denylist.
// (b) plugin SQL is never executed raw — rejected input does not reach the driver.
// (c) a hostile session SET succeeds (PostgreSQL has no privilege to deny it) and is harmless
//     given the §2 protocol. Session-GUC denial is not a mechanism P1 may design for.
import { sql, type Kysely } from 'kysely';
import { pooled, terminateBackendByPid, type Db } from '../client.ts';
import { withTenant } from '../context.ts';
import { TENANT_A, TENANT_B } from '../cases/a2-oracle.ts';
import {
  blankEv, drainAppBackends, onlyTenant, rawSessionGuc, readRows, recordProbe,
} from '../cases/a3-pgbouncer.ts';

const PHASE = {
  scope: 'classifier shape',
  admissionParserMachinery: 'P2 (spec §4.3)',
  tenancyGateSuite: 'spec §12 / P1',
  acceptance: 'spec §16.13 / P3',
  sessionGucDenial: 'unavailable — no role privilege denies session-setting an ordinary custom GUC',
} as const;

const ALLOWED_STATEMENTS = new Set(['select', 'insert', 'update', 'delete']);
const ALLOWED_FUNCTIONS = new Set(['count', 'min', 'max', 'sum', 'avg', 'coalesce', 'nullif', 'lower', 'upper']);
// Call-shaped keywords (`AS (`) are not functions. The scanner is still not a SQL parser.
const NOT_FUNCTIONS = new Set(['as', 'and', 'or', 'not', 'in', 'on', 'from', 'where', 'select', 'with', 'join', 'case', 'when', 'then', 'else', 'end']);

export interface DeclaredQuery {
  statement: string;
  functions: string[];
  /** Classified, never sent to the server. */
  text: string;
}

export function classify(q: DeclaredQuery): { ok: true } | { ok: false; reason: string } {
  const statement = q.statement.toLowerCase();
  if (!ALLOWED_STATEMENTS.has(statement)) return { ok: false, reason: `statement '${q.statement}' is not allowlisted` };
  const calls = new Set(q.functions.map((fn) => fn.toLowerCase()));
  for (const match of q.text.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const name = match[1]!.toLowerCase();
    if (!NOT_FUNCTIONS.has(name)) calls.add(name);
  }
  for (const fn of calls) {
    if (!ALLOWED_FUNCTIONS.has(fn)) return { ok: false, reason: `function '${fn}' is not allowlisted` };
  }
  return { ok: true };
}

let brokerExecutions = 0;

/** Broker entry. Raw strings and failed classifications throw before any query. */
export async function submitPluginQuery(db: Kysely<Db>, payload: unknown): Promise<string[]> {
  if (typeof payload !== 'object' || payload === null || !('statement' in payload) || !('text' in payload)) {
    throw new Error('plugin SQL never executes raw');
  }
  const declared = payload as DeclaredQuery;
  const verdict = classify(declared);
  if (!verdict.ok) throw new Error(verdict.reason);
  brokerExecutions += 1;
  // Broker-owned statement. declared.text is intentionally unused.
  const rows = await withTenant(db, TENANT_A, blankEv(), terminateBackendByPid, readRows);
  return rows.map((r) => r.label);
}

const SMUGGLED: DeclaredQuery[] = [
  { statement: 'select', functions: ['set_config'], text: "SELECT set_config('plerni.tenant_id', $1, true)" },
  { statement: 'select', functions: [], text: "WITH s AS (SELECT set_config('plerni.tenant_id', $1, true) AS t) SELECT t FROM s" },
  { statement: 'select', functions: ['count'], text: "SELECT count(*), set_config('plerni.tenant_id', $1, true)" },
];

export async function gucForgery(): Promise<void> {
  await recordProbe(
    { case: 'battery guc-forgery classifier', datasource: 'prototype' },
    async () => {
      const rejected = SMUGGLED.map((q) => classify(q));
      const clean = classify({ statement: 'select', functions: ['count'], text: 'SELECT count(*) FROM plerni_tenant' });
      return {
        pass: rejected.every((v) => !v.ok && v.reason.includes('set_config')) && clean.ok === true,
        detail: { scope: PHASE.scope, phase: PHASE, rejected, cleanAccepted: clean.ok === true },
      };
    },
    rawSessionGuc,
  );

  await drainAppBackends();
  const db = pooled(1);
  try {
    await recordProbe(
      { case: 'battery plugin SQL never executes raw', datasource: 'pooled(1)' },
      async () => {
        const before = brokerExecutions;
        let rawRejected = false;
        try {
          await submitPluginQuery(db, "SELECT set_config('plerni.tenant_id', 'x', true)");
        } catch (e) {
          rawRejected = e instanceof Error && e.message === 'plugin SQL never executes raw';
        }
        let smuggleRejected = false;
        try {
          await submitPluginQuery(db, SMUGGLED[1]);
        } catch (e) {
          smuggleRejected = e instanceof Error && e.message.includes('not allowlisted');
        }
        // Text names a missing relation. Executing it would error; the broker runs its own read.
        const labels = await submitPluginQuery(db, {
          statement: 'select',
          functions: ['count'],
          text: 'SELECT count(*) FROM definitely_missing_relation',
        });
        return {
          pass: rawRejected && smuggleRejected && brokerExecutions === before + 1
            && JSON.stringify(labels) === JSON.stringify(['assignment', 'goal', 'review']),
          detail: { rawRejected, smuggleRejected, brokerExecutions, labels, phase: PHASE },
        };
      },
      rawSessionGuc,
    );

    await recordProbe(
      { case: 'battery hostile session SET contained by protocol', datasource: 'pooled(1)' },
      async () => {
        let denied = false;
        try {
          await sql`SELECT set_config('plerni.tenant_id', ${TENANT_B}, false)`.execute(db);
        } catch {
          denied = true;
        }
        const forged = await db.transaction().execute(readRows);
        const ev = blankEv();
        const recovered = await withTenant(db, TENANT_A, ev, terminateBackendByPid, readRows);
        return {
          pass: denied === false && onlyTenant(forged, TENANT_B) && onlyTenant(recovered, TENANT_A)
            && ev.terminatedBackendPids.length === 1,
          detail: {
            sessionGucDenial: PHASE.sessionGucDenial,
            denied,
            forgedTenant: forged[0]?.tenant_id ?? null,
            recoveredTenant: recovered[0]?.tenant_id ?? null,
            terminations: ev.terminatedBackendPids.length,
            phase: PHASE,
          },
        };
      },
      rawSessionGuc,
    );
  } finally {
    await db.destroy();
  }
}
