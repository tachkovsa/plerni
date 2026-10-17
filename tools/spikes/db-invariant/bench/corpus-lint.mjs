// SPDX-License-Identifier: Apache-2.0
// AST lint for the typecheck corpus (plan §3.1 A5, escape-hatch ban).
// A textual ban on "as" would reject Kysely's .as('alias') call. This walks
// the TypeScript AST instead: type assertions, explicit any, explicit type
// arguments on calls, $castTo / $narrowType / $assertType, and sql fragments.
// A fragment is Kysely's sql export, including `sql as raw`, `kysely.sql`,
// `export { sql as raw } from 'kysely'`, and a local assigned from that
// binding (`const raw = sql`, including a chain and a later `=`). An unbound
// identifier named sql is still a fragment (ambient declare). A different
// Kysely export renamed to sql is not. The only allowed form is
// select set_config('plerni.<guc>', …, true).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const HATCHES = new Set(['$castTo', '$narrowType', '$assertType']);

function lineOf(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function kyselySqlBindings(sf) {
  const tags = new Set();
  const namespaces = new Set();
  const otherLocals = new Set();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const fromKysely = stmt.moduleSpecifier.text === 'kysely';
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) otherLocals.add(clause.name.text);
    const named = clause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      if (fromKysely) namespaces.add(named.name.text);
      else otherLocals.add(named.name.text);
      continue;
    }
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      const imported = el.propertyName ? el.propertyName.text : el.name.text;
      if (fromKysely && imported === 'sql') tags.add(el.name.text);
      else otherLocals.add(el.name.text);
    }
  }
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const fromKysely = stmt.moduleSpecifier.text === 'kysely';
    const clause = stmt.exportClause;
    if (!clause) continue;
    if (ts.isNamespaceExport(clause)) {
      if (fromKysely) namespaces.add(clause.name.text);
      else otherLocals.add(clause.name.text);
      continue;
    }
    for (const el of clause.elements) {
      if (el.isTypeOnly) continue;
      const imported = el.propertyName ? el.propertyName.text : el.name.text;
      if (fromKysely && imported === 'sql') tags.add(el.name.text);
      else otherLocals.add(el.name.text);
    }
  }
  return { tags, namespaces, otherLocals };
}

function unwrapValue(expr) {
  let node = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function aliasInitializers(sf) {
  const inits = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      inits.push([node.name.text, unwrapValue(node.initializer)]);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      inits.push([node.left.text, unwrapValue(node.right)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return inits;
}

// Import aliases are not the only way a local names Kysely's sql. A const
// copy, a later assignment, and a chain of those copies all keep the binding.
function followSqlAliases(sf, bindings) {
  const inits = aliasInitializers(sf);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, expr] of inits) {
      if (bindings.tags.has(name)) continue;
      if (!isSql(expr, bindings)) continue;
      bindings.tags.add(name);
      bindings.otherLocals.delete(name);
      grew = true;
    }
  }
}

function isSqlIdentifier(expr, bindings) {
  if (!ts.isIdentifier(expr)) return false;
  if (bindings.tags.has(expr.text)) return true;
  return expr.text === 'sql' && !bindings.otherLocals.has(expr.text);
}

function isSql(expr, bindings) {
  if (ts.isIdentifier(expr)) return isSqlIdentifier(expr, bindings);
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (ts.isIdentifier(expr.expression)) {
    if (bindings.namespaces.has(expr.expression.text) && expr.name.text === 'sql') return true;
    return isSqlIdentifier(expr.expression, bindings);
  }
  return isSql(expr.expression, bindings);
}

function templateText(tpl) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  if (!ts.isTemplateExpression(tpl)) return null;
  let raw = tpl.head.text;
  for (const span of tpl.templateSpans) raw += '${}' + span.literal.text;
  return raw;
}

function isAllowedSetConfig(node, bindings) {
  if (!ts.isTaggedTemplateExpression(node) || !isSqlIdentifier(node.tag, bindings)) {
    return false;
  }
  if (node.typeArguments && node.typeArguments.length > 0) return false;
  const raw = templateText(node.template);
  if (raw === null) return false;
  const norm = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^select set_config\('plerni\.[a-z0-9_]+', ?\$\{\}, ?true\)$/.test(norm);
}

export function lintSource(fileName, sourceText) {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = kyselySqlBindings(sf);
  followSqlAliases(sf, bindings);
  const findings = [];
  const seen = new Set();
  const add = (node, rule, message) => {
    const pos = lineOf(sf, node);
    const key = `${pos.line}:${pos.col}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: fileName, ...pos, rule, message });
  };
  const visit = (node) => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      add(node, 'as-assertion', 'type assertion is an escape hatch');
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      add(node, 'any', 'explicit any is an escape hatch');
    }
    if ((ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) && node.typeArguments?.length) {
      add(node, 'explicit-type-argument', 'explicit type argument hides inference');
    }
    if (ts.isCallExpression(node) && HATCHES.has(calleeName(node.expression))) {
      add(node, 'escape-hatch', `${calleeName(node.expression)} is an escape hatch`);
    }
    if (ts.isCallExpression(node) && isSql(node.expression, bindings)) {
      add(node, 'sql-fragment', 'sql call is an escape hatch');
    }
    if (ts.isTaggedTemplateExpression(node) && isSql(node.tag, bindings) && !isAllowedSetConfig(node, bindings)) {
      add(node, 'sql-fragment', 'sql fragment is an escape hatch (only set_config is allowed)');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function lintFile(fileName) {
  return lintSource(fileName, readFileSync(fileName, 'utf8'));
}

export function reportFindings(findings) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.col} ${finding.rule}: ${finding.message}`);
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: corpus-lint.mjs <file.ts> [more.ts]');
    process.exit(1);
  }
  const findings = files.flatMap((file) => lintFile(file));
  if (findings.length) {
    reportFindings(findings);
    console.error(`corpus-lint: FAIL (${findings.length})`);
    process.exit(1);
  }
  console.log(`corpus-lint: OK (${files.length} file${files.length === 1 ? '' : 's'})`);
}
