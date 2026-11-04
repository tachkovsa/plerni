// SPDX-License-Identifier: Apache-2.0
// Fixture-file check for in-repo package SQL (plan K17, ADR-0008 decision 4).
// Rejects unqualified table names, another schema, and functions (plus triggers
// and DO blocks, the indirect set_config path). This is not the P2 admission
// parser and does not classify arbitrary author SQL.
import { PluginPackageError } from './errors.ts';
import { pluginSchemaName } from './ident.ts';

export type FixtureSqlCode = 'unqualified_table' | 'foreign_schema' | 'function';

export interface FixtureSqlViolation {
  code: FixtureSqlCode;
  detail: string;
}

const IDENT = String.raw`[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?`;

function strip(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      out += "''";
      continue;
    }
    if (sql[i] === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
        out += "''";
        continue;
      }
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function isRoutine(statement: string): boolean {
  return /^(create\s+(or\s+replace\s+)?(function|procedure|trigger)|do)\b/i.test(statement);
}

function tableRefs(statement: string): string[] {
  const refs: string[] = [];
  const take = (pattern: RegExp): void => {
    for (const match of statement.matchAll(pattern)) {
      const name = match[1];
      if (name) refs.push(name);
    }
  };
  take(new RegExp(String.raw`\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\binsert\s+into\s+(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bupdate\s+(?:only\s+)?(${IDENT})\s+set\b`, 'gi'));
  take(new RegExp(String.raw`\breferences\s+(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bon\s+table\s+(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bpolicy\s+(?:if\s+(?:not\s+)?exists\s+)?[a-z_][a-z0-9_]*\s+on\s+(${IDENT})`, 'gi'));
  if (!/^(grant|revoke)\b/i.test(statement)) {
    take(new RegExp(String.raw`\b(?:from|join)\s+(${IDENT})`, 'gi'));
  }
  return refs;
}

function classify(ref: string, expected: string, violations: FixtureSqlViolation[]): void {
  const dot = ref.indexOf('.');
  if (dot === -1) {
    violations.push({ code: 'unqualified_table', detail: ref });
    return;
  }
  const schema = ref.slice(0, dot);
  if (schema !== expected) violations.push({ code: 'foreign_schema', detail: ref });
}

export function checkFixtureSql(pluginId: string, sqlText: string): FixtureSqlViolation[] {
  const expected = pluginSchemaName(pluginId);
  const violations: FixtureSqlViolation[] = [];
  const parts = strip(sqlText).split(';');
  for (const part of parts) {
    const statement = part.trim();
    if (statement === '') continue;
    if (isRoutine(statement)) {
      violations.push({ code: 'function', detail: statement.slice(0, 80) });
      continue;
    }
    const schema = /^create\s+schema\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/i.exec(statement);
    if (schema) {
      if (schema[1] !== expected) violations.push({ code: 'foreign_schema', detail: schema[1] ?? 'schema' });
      continue;
    }
    for (const ref of tableRefs(statement)) classify(ref, expected, violations);
  }
  return violations;
}

/** A broker read is one SELECT the fixture-file check has already accepted. */
export function assertFixtureRead(pluginId: string, statement: string): void {
  const violations = checkFixtureSql(pluginId, statement);
  if (violations.length > 0) {
    const summary = violations.map((item) => `${item.code}:${item.detail}`).join(', ');
    throw new PluginPackageError(`fixture sql rejected: ${summary}`);
  }
  const statements = strip(statement).split(';').map((item) => item.trim()).filter((item) => item !== '');
  if (statements.length !== 1 || !/^select\b/i.test(statements[0] ?? '')) {
    throw new PluginPackageError('plugin read must be one select');
  }
  if (/\binto\b/i.test(statements[0] ?? '')) throw new PluginPackageError('plugin read must not create a table');
}
