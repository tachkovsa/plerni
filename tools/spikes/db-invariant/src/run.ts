// run.ts — Spike A first part: A1 pinning + A2 oracle, both datasources, JSONL evidence.
// Vacuity control (mandatory): a context variant skipping the install step must FAIL A2 —
// both outcomes recorded. Exit non-zero if any required case fails.
import { sql } from 'kysely';
import { direct } from './client.ts';
import { record, evidenceFile, failedCount } from './evidence.ts';
import { withTenant, type HygieneEvidence } from './context.ts';
import { a1Pinning } from './cases/a1-pinning.ts';
import { a2Oracle, TENANT_B } from './cases/a2-oracle.ts';

async function vacuityControl(): Promise<void> {
  // Deliberately broken: no install step at all. RLS must deny AND the "protocol" never proves
  // anything — the run proves the tests CAN fail (spec §5 vacuity guard).
  const db = direct();
  const ev: HygieneEvidence = { terminatedBackendPids: [], attempts: 0, alerts: [] };
  const rows = await db.transaction().execute(async (trx) => {
    const r = await sql<{ label: string }>`SELECT label FROM plerni_tenant`.execute(trx);
    return r.rows.length;
  });
  record({
    case: 'vacuity: no-context read sees zero rows (test can fail)', datasource: 'direct',
    pass: rows === 0,
    detail: { rows, note: 'if this passes with rows>0, RLS is broken and every A2 result is void' },
  });
  // And the inverse shape: a run that skips only the readback verification still passes reads —
  // proving the readback step is the only thing standing between us and silent wrong-value install.
  const skipVerify = await withTenant(db, TENANT_B, ev, async (trx) => {
    const r = await sql<{ label: string }>`SELECT label FROM plerni_tenant ORDER BY label`.execute(trx);
    return r.rows.map((x) => x.label);
  });
  record({
    case: 'vacuity inverse: protocol-installed context reads B', datasource: 'direct',
    pass: JSON.stringify(skipVerify) === JSON.stringify(['assignment', 'goal', 'review']),
    detail: { read: skipVerify },
  });
  await db.destroy();
}

const startedAt = Date.now();
try {
  await a1Pinning();
  await a2Oracle();
  await vacuityControl();
} finally {
  const failed = failedCount();
  console.log(`evidence: ${evidenceFile} (${Date.now() - startedAt}ms) — ${failed} failing case(s)`);
  if (failed > 0) process.exitCode = 1; // FAIL verdicts are meaningful data; CI must see them
}
