// SPDX-License-Identifier: Apache-2.0
// AST lint for the typecheck corpus (plan §3.1 A5, escape-hatch ban).
// A textual ban on "as" would reject Kysely's .as('alias') call. This walks
// the TypeScript AST instead: type assertions, explicit any, explicit type
// arguments on calls, $castTo / $narrowType / $assertType, and sql fragments.
// The only allowed sql form is select set_config('plerni.<guc>', …, true).

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

function isSql(expr) {
  if (ts.isIdentifier(expr) && expr.text === 'sql') return true;
  return ts.isPropertyAccessExpression(expr)
    && ts.isIdentifier(expr.expression)
    && expr.expression.text === 'sql';
}

function templateText(tpl) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  if (!ts.isTemplateExpression(tpl)) return null;
  let raw = tpl.head.text;
  for (const span of tpl.templateSpans) raw += '${}' + span.literal.text;
  return raw;
}

function isAllowedSetConfig(node) {
  if (!ts.isTaggedTemplateExpression(node) || !ts.isIdentifier(node.tag) || node.tag.text !== 'sql') {
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
    if (ts.isCallExpression(node) && isSql(node.expression)) {
      add(node, 'sql-fragment', 'sql call is an escape hatch');
    }
    if (ts.isTaggedTemplateExpression(node) && isSql(node.tag) && !isAllowedSetConfig(node)) {
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
