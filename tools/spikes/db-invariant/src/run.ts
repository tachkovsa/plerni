// run.ts — Spike A first part: A1 pinning + A2 oracle, both datasources, JSONL evidence.
// Vacuity control (mandatory): a context variant skipping the install step must FAIL A2 —
// both outcomes recorded. Exit non-zero if any required case fails.
import { sql } from 'kysely';
import { direct } from './client.ts';
import { record, evidenceFile, failedCount } from './evidence.ts';
import { assertTenantContext, MissingTenantContextError } from './context.ts';
import { a1Pinning } from './cases/a1-pinning.ts';
import { a2Oracle } from './cases/a2-oracle.ts';

async function vacuityControl(): Promise<void> {
  // The designed FAIL (T3a step 5): a protocol variant that skips the context install must FAIL
  // A2 — zero rows via RLS AND the app guard raises MissingTenantContextError; both outcomes in
  // evidence. If either fails to fire, every A2 pass above is void (spec §5 vacuity guard).
  const db = direct();
  let rows = -1;
  let guardRaised = false;
  await db.transaction().execute(async (trx) => {
    rows = (await sql<{ label: string }>`SELECT label FROM plerni_tenant`.execute(trx)).rows.length;
    try {
      await assertTenantContext(trx);
    } catch (e) {
      guardRaised = e instanceof MissingTenantContextError;
    }
  });
  record({
    case: 'vacuity: install-skipped variant FAILS A2 as designed', datasource: 'direct',
    pass: rows === 0 && guardRaised,
    detail: { rows, guardRaised, proves: 'RLS denies + guard trips; without both, A2 cannot fail' },
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
