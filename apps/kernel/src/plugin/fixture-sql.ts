// SPDX-License-Identifier: Apache-2.0
// Fixture-file check for in-repo package SQL (plan K17, ADR-0008 decision 4).
// Rejects unqualified table names, another schema, and functions (plus triggers
// and DO blocks, the indirect set_config path). A statement or identifier form
// this checker does not recognize fails closed. This is not the P2 admission
// parser and does not classify arbitrary author SQL.
import { PluginPackageError } from './errors.ts';
import { pluginRoleName, pluginSchemaName } from './ident.ts';

export type FixtureSqlCode = 'unqualified_table' | 'foreign_schema' | 'function' | 'unsupported' | 'privilege' | 'context';

export interface FixtureSqlViolation {
  code: FixtureSqlCode;
  detail: string;
}

const IDENT = String.raw`[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?`;

function isEscapeString(sql: string, quote: number): boolean {
  const mark = sql[quote - 1] ?? '';
  if (mark !== 'E' && mark !== 'e') return false;
  // The letter E is a prefix only when it is not the tail of an identifier.
  return !/[A-Za-z0-9_]/.test(sql[quote - 2] ?? '');
}

function strip(sql: string): { text: string; escapeString: boolean } {
  let out = '';
  let i = 0;
  let escapeString = false;
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
      if (isEscapeString(sql, i)) escapeString = true;
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
  return { text: out, escapeString };
}

function isRoutine(statement: string): boolean {
  return /^(create\s+(or\s+replace\s+)?(function|procedure|trigger)|do)\b/i.test(statement);
}

/** Forms whose table names this checker actually validates. Anything else fails closed. */
const RECOGNIZED = [
  /^create\s+schema\b/i,
  /^create\s+table\b/i,
  /^alter\s+table\b/i,
  /^drop\s+table\b/i,
  /^truncate\b/i,
  /^insert\s+into\b/i,
  /^update\b/i,
  /^delete\s+from\b/i,
  /^create\s+policy\b/i,
  /^drop\s+policy\b/i,
  /^grant\b/i,
  /^revoke\b/i,
  /^select\b/i,
];

function recognized(statement: string): boolean {
  return RECOGNIZED.some((pattern) => pattern.test(statement));
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
  take(new RegExp(String.raw`\breferences\s+(${IDENT})`, 'gi'));
  take(new RegExp(String.raw`\bpolicy\s+(?:if\s+(?:not\s+)?exists\s+)?[a-z_][a-z0-9_]*\s+on\s+(${IDENT})`, 'gi'));
  return refs;
}

const TABLE_DML = new Set(['select', 'insert', 'update', 'delete']);
const SCHEMA_GRANT = new Set(['usage']);

/** Privileges named before ON. ALL and anything outside DML (or USAGE on a schema) are rejected. */
function grantPrivileges(statement: string, kind: 'schema' | 'table'): 'ok' | 'privilege' | 'unsupported' {
  const match = /^grant\s+([\s\S]+?)\s+on\b/i.exec(statement);
  const list = match?.[1]?.trim() ?? '';
  if (list === '' || list.includes('(')) return 'unsupported';
  if (/\ball\b/i.test(list)) return 'privilege';
  const names = list.split(',').map((part) => part.trim().toLowerCase());
  const allowed = kind === 'schema' ? SCHEMA_GRANT : TABLE_DML;
  if (names.some((name) => !allowed.has(name))) return 'privilege';
  return 'ok';
}

/**
 * `TABLE name` used as a query source, as in `INSERT INTO t TABLE other`.
 * DDL and `ON TABLE` uses of the keyword are not sources.
 */
function tableQuerySources(statement: string): string[] | 'unsupported' {
  const sources: string[] = [];
  const re = /\btable\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    const before = statement.slice(0, match.index).trimEnd();
    const prior = /([a-z_]+)$/i.exec(before)?.[1]?.toLowerCase();
    if (prior === 'create' || prior === 'alter' || prior === 'drop' || prior === 'truncate' || prior === 'on' || prior === 'into') {
      continue;
    }
    const rest = statement.slice(match.index + match[0].length);
    const named = /^\s+(?:only\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/i.exec(rest);
    if (!named?.[1]) return 'unsupported';
    sources.push(named[1]);
  }
  return sources;
}

/** `UPDATE name [AS alias] SET`. An alias is part of the target. Other shapes fail closed. */
function updateTarget(statement: string): string | 'unsupported' | null {
  if (!/^update\b/i.test(statement)) return null;
  const match = /^update\s+(?:only\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s+set\b/i.exec(
    statement,
  );
  if (!match?.[1]) return 'unsupported';
  return match[1];
}

/**
 * Every FROM list in the statement, including lists after UNION and inside
 * subqueries. A join or other shape this pattern cannot read fails closed.
 */
function sourceRelations(statement: string): string[] | 'unsupported' | null {
  const names: string[] = [];
  const fromRe = /\bfrom\b/gi;
  let saw = false;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(statement)) !== null) {
    saw = true;
    const parsed = relationsAfter(statement, match.index + match[0].length);
    if (parsed === 'unsupported') return 'unsupported';
    names.push(...parsed);
  }
  return saw ? names : null;
}

function relationsAfter(statement: string, start: number): string[] | 'unsupported' {
  let depth = 0;
  let end = statement.length;
  for (let i = start; i < statement.length; i += 1) {
    const ch = statement[i] ?? '';
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    } else if (depth === 0 && /\s/.test(ch)
      && /^\s+(where|group|order|limit|offset|having|window|union|except|intersect|fetch|for)\b/i.test(statement.slice(i))) {
      end = i;
      break;
    }
  }
  const clause = statement.slice(start, end).trim();
  if (clause === '' || clause.includes('(') || clause.includes(')')) return 'unsupported';
  const names: string[] = [];
  const item = /^(?:only\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?$/i;
  for (const part of clause.split(',')) {
    const found = item.exec(part.trim());
    if (!found?.[1]) return 'unsupported';
    names.push(found[1]);
  }
  return names;
}

/** GRANT recipients. Only the owning plugin role may receive a grant. */
function grantRecipients(statement: string, pluginId: string): 'ok' | 'privilege' | 'unsupported' {
  const role = pluginRoleName(pluginId).toLowerCase();
  const match = /\bto\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)\s*$/i.exec(statement.trim());
  if (!match?.[1]) return 'unsupported';
  const names = match[1].split(',').map((part) => part.trim().toLowerCase());
  if (names.length === 0 || names.some((name) => name !== role)) return 'privilege';
  return 'ok';
}

/**
 * GRANT/REVOKE targets. `ON name` and `ON TABLE name` are tables. Every name
 * in a comma list is checked. A target this pattern cannot read fails closed.
 */
function grantTargets(statement: string): { kind: 'schema' | 'table'; names: string[] } | 'unsupported' {
  const match = /\bon\s+(?:(schema|table)\s+)?([a-z_][a-z0-9_.]*(?:\s*,\s*[a-z_][a-z0-9_.]*)*)\s+(?:to|from)\b/i.exec(
    statement,
  );
  if (!match?.[2]) return 'unsupported';
  const names = match[2].split(',').map((part) => part.trim().toLowerCase());
  const ident = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/;
  if (names.length === 0 || names.some((name) => !ident.test(name))) return 'unsupported';
  const keyword = match[1]?.toLowerCase();
  if (keyword === 'schema') {
    if (names.some((name) => name.includes('.'))) return 'unsupported';
    return { kind: 'schema', names };
  }
  return { kind: 'table', names };
}

/**
 * Partition parent and child names. A form this pattern cannot read fails closed.
 * Same-schema names stay; another schema is rejected by the caller.
 */
function partitionRefs(statement: string): string[] | 'unsupported' | null {
  const re = /\b(?:attach\s+partition|detach\s+partition|partition\s+of)\s+/gi;
  const names: string[] = [];
  let saw = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(statement)) !== null) {
    saw = true;
    const rest = statement.slice(match.index + match[0].length);
    const named = /^(?:only\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\b/i.exec(rest);
    if (!named?.[1]) return 'unsupported';
    names.push(named[1]);
  }
  return saw ? names : null;
}

/** `ALTER TABLE ... SET SCHEMA`. The destination must be this plugin's schema. */
function setSchemaDestination(statement: string): string | 'unsupported' | null {
  if (!/^alter\s+table\b/i.test(statement) || !/\bset\s+schema\b/i.test(statement)) return null;
  const match = /\bset\s+schema\s+([a-z_][a-z0-9_]*)\s*$/i.exec(statement.trim());
  if (!match?.[1]) return 'unsupported';
  return match[1].toLowerCase();
}

/** Calls a fixture statement may make. Anything else can execute hidden SQL. */
const ALLOWED_CALLS = new Set(['current_setting', 'nullif']);
/** Parentheses that introduce syntax, not a function call. */
const SYNTAX_CALLS = new Set(['key', 'check', 'using', 'unique', 'list', 'range', 'hash', 'in', 'values', 'exists', 'array', 'row']);

function nameBeforeParen(statement: string, paren: number): { name: string; start: number } | null {
  let i = paren - 1;
  while (i >= 0 && /\s/.test(statement[i] ?? '')) i -= 1;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(statement[i] ?? '')) i -= 1;
  if (end <= i + 1) return null;
  let start = i + 1;
  let name = statement.slice(start, end);
  if ((statement[i] ?? '') === '.') {
    let j = i - 1;
    const qualEnd = j + 1;
    while (j >= 0 && /[A-Za-z0-9_]/.test(statement[j] ?? '')) j -= 1;
    if (qualEnd > j + 1) {
      start = j + 1;
      name = `${statement.slice(start, qualEnd)}.${name}`;
    }
  }
  return { name: name.toLowerCase(), start };
}

function isColumnList(statement: string, nameStart: number): boolean {
  return /\b(?:create|alter|drop)\s+table(?:\s+if\s+(?:not\s+)?exists)?\s+$/i.test(statement.slice(0, nameStart));
}

function isReferenceList(statement: string, nameStart: number): boolean {
  return /\breferences\s+$/i.test(statement.slice(0, nameStart));
}

/** Function calls outside the allowlist. Schema-qualified calls are rejected too. */
function disallowedCalls(statement: string): string[] {
  const bad: string[] = [];
  for (let i = 0; i < statement.length; i += 1) {
    if (statement[i] !== '(') continue;
    const found = nameBeforeParen(statement, i);
    if (!found) continue;
    if (isColumnList(statement, found.start) || isReferenceList(statement, found.start)) continue;
    const dot = found.name.lastIndexOf('.');
    const schema = dot === -1 ? '' : found.name.slice(0, dot);
    const simple = dot === -1 ? found.name : found.name.slice(dot + 1);
    const allowedSchema = schema === '' || schema === 'pg_catalog';
    const allowedName = ALLOWED_CALLS.has(simple) || (schema === '' && SYNTAX_CALLS.has(simple));
    if (allowedSchema && allowedName) continue;
    bad.push(found.name);
  }
  return bad;
}

/** set_config and SET of a plerni GUC replace the tenant context RLS trusts. */
function changesTenantContext(statement: string): boolean {
  return /\bset_config\s*\(/i.test(statement) || /\bset\s+(?:local\s+|session\s+)?plerni\./i.test(statement);
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
  const stripped = strip(sqlText);
  // E'...' follows backslash rules this scan does not tokenize. Reject it.
  if (stripped.escapeString) return [{ code: 'unsupported', detail: 'escape string' }];
  const parts = stripped.text.split(';');
  for (const part of parts) {
    const statement = part.trim();
    if (statement === '') continue;
    if (changesTenantContext(statement)) {
      violations.push({ code: 'context', detail: statement.slice(0, 80) });
      continue;
    }
    if (isRoutine(statement)) {
      violations.push({ code: 'function', detail: statement.slice(0, 80) });
      continue;
    }
    // Quoted identifiers and modifiers such as UNLOGGED hide names from the
    // patterns below. A comma-separated DROP or TRUNCATE list only yields the
    // first name to those patterns, so that form fails closed too.
    const multiTable = /^(?:drop\s+table|truncate)\b/i.test(statement) && statement.includes(',');
    if (statement.includes('"') || !recognized(statement) || multiTable) {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
      continue;
    }
    const calls = disallowedCalls(statement);
    if (calls.length > 0) {
      violations.push({ code: 'context', detail: calls[0] ?? statement.slice(0, 80) });
      continue;
    }
    if (/\binherits?\b/i.test(statement)) {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
      continue;
    }
    const partitions = partitionRefs(statement);
    if (partitions === 'unsupported') {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
      continue;
    }
    if (partitions) {
      for (const name of partitions) classify(name, expected, violations);
    }
    const schema = /^create\s+schema\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/i.exec(statement);
    if (schema) {
      if (schema[1] !== expected) violations.push({ code: 'foreign_schema', detail: schema[1] ?? 'schema' });
      continue;
    }
    if (/^(grant|revoke)\b/i.test(statement)) {
      const targets = grantTargets(statement);
      if (targets === 'unsupported') {
        violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
        continue;
      }
      if (/^grant\b/i.test(statement)) {
        const privileges = grantPrivileges(statement, targets.kind);
        if (privileges !== 'ok') violations.push({ code: privileges, detail: statement.slice(0, 80) });
        const recipients = grantRecipients(statement, pluginId);
        if (recipients !== 'ok') violations.push({ code: recipients, detail: statement.slice(0, 80) });
      }
      if (targets.kind === 'schema') {
        for (const name of targets.names) {
          if (name !== expected) violations.push({ code: 'foreign_schema', detail: name });
        }
        continue;
      }
      for (const name of targets.names) classify(name, expected, violations);
      continue;
    }
    const updated = updateTarget(statement);
    if (updated === 'unsupported') {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
    } else if (updated) {
      classify(updated, expected, violations);
    }
    const moved = setSchemaDestination(statement);
    if (moved === 'unsupported') {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
    } else if (moved && moved !== expected) {
      violations.push({ code: 'foreign_schema', detail: moved });
    }
    for (const ref of tableRefs(statement)) classify(ref, expected, violations);
    const tableSources = tableQuerySources(statement);
    if (tableSources === 'unsupported') {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
    } else {
      for (const name of tableSources) classify(name, expected, violations);
    }
    const sources = sourceRelations(statement);
    if (sources === 'unsupported') {
      violations.push({ code: 'unsupported', detail: statement.slice(0, 80) });
    } else if (sources) {
      for (const name of sources) classify(name, expected, violations);
    }
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
  const statements = strip(statement).text.split(';').map((item) => item.trim()).filter((item) => item !== '');
  if (statements.length !== 1 || !/^select\b/i.test(statements[0] ?? '')) {
    throw new PluginPackageError('plugin read must be one select');
  }
  if (/\binto\b/i.test(statements[0] ?? '')) throw new PluginPackageError('plugin read must not create a table');
}
