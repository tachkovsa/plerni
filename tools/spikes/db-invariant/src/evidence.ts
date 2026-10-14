// evidence.ts — JSONL evidence writer: {case, datasource, pass, detail} per assertion.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface EvidenceRow {
  case: string;
  datasource: string;
  pass: boolean;
  detail: Record<string, unknown>;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'evidence');
mkdirSync(dir, { recursive: true });
export const evidenceFile = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

let failures = 0;
export function failedCount(): number {
  return failures;
}

export function record(row: EvidenceRow): void {
  appendFileSync(evidenceFile, JSON.stringify(row) + '\n');
  if (!row.pass) failures++;
  const mark = row.pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${row.case} @ ${row.datasource} — ${JSON.stringify(row.detail)}`);
}
