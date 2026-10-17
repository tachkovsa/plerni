// SPDX-License-Identifier: Apache-2.0
// AST lint for the typecheck corpus (plan §3.1 A5, escape-hatch ban).
// A textual ban on "as" would reject Kysely's .as('alias') call. This walks
// the TypeScript AST instead: type assertions, explicit any, explicit type
// arguments on calls, $castTo / $narrowType / $assertType, and sql fragments.
// A fragment is any tagged template or call whose tag the checker resolves,
// through getSymbolAtLocation and getAliasedSymbol, to Kysely's exported sql.
// That follows imports, namespace members, destructuring, assignments, and
// re-exports. An identifier named sql that is not some other export is still
// a fragment (ambient declare). The only allowed form is
// select set_config('plerni.<guc>', …, true).

import { readFileSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const HATCHES = new Set(['$castTo', '$narrowType', '$assertType']);
const benchDir = dirname(fileURLToPath(import.meta.url));

function lineOf(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function checkerFor(fileName, sourceText) {
  const abs = isAbsolute(fileName) ? fileName : resolve(benchDir, fileName);
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: false,
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const source = ts.createSourceFile(abs, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (file) => file === abs || fileExists(file);
  host.readFile = (file) => (file === abs ? sourceText : readFile(file));
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    file === abs ? source : getSourceFile(file, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([abs], options, host);
  const sf = program.getSourceFile(abs) ?? source;
  return { sf, checker: program.getTypeChecker() };
}

function unwrap(expr) {
  let node = expr;
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

function isKyselySqlValue(symbol) {
  if (!symbol || symbol.name !== 'sql') return false;
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!decl) return false;
  return decl.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/kysely/');
}

function declaredHere(symbol, sf) {
  return (symbol.declarations ?? []).some((decl) => decl.getSourceFile() === sf);
}

function aliasesOtherExport(symbol, checker) {
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return false;
  const seen = new Set();
  let current = symbol;
  while (current && current.flags & ts.SymbolFlags.Alias && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return !isKyselySqlValue(current);
}

function bindingPropertyName(decl) {
  if (decl.propertyName) {
    if (ts.isIdentifier(decl.propertyName) || ts.isStringLiteral(decl.propertyName)) return decl.propertyName.text;
    return null;
  }
  return ts.isIdentifier(decl.name) ? decl.name.text : null;
}

// want is 'denotes' (the sql function itself) or 'uses' (the function or a member).
function symbolReaches(symbol, checker, sf, seen, want) {
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    if (symbolReaches(checker.getAliasedSymbol(symbol), checker, sf, seen, want)) return true;
  }
  if (isKyselySqlValue(symbol)) return true;
  if (!declaredHere(symbol, sf)) return false;
  for (const decl of symbol.declarations ?? []) {
    if (decl.getSourceFile() !== sf) continue;
    if (ts.isVariableDeclaration(decl) && decl.initializer && exprReaches(decl.initializer, checker, sf, seen, want)) {
      return true;
    }
    if (ts.isBindingElement(decl) && bindingReaches(decl, checker, sf, seen, want)) return true;
  }
  return assignmentReaches(symbol, checker, sf, seen, want);
}

function bindingReaches(decl, checker, sf, seen, want) {
  const propName = bindingPropertyName(decl);
  const variable = decl.parent?.parent;
  if (!propName || !variable || (!ts.isVariableDeclaration(variable) && !ts.isParameter(variable))) return false;
  if (!variable.initializer) return false;
  const prop = checker.getTypeAtLocation(variable.initializer).getProperty(propName);
  return symbolReaches(prop, checker, sf, seen, want);
}

function assignmentReaches(symbol, checker, sf, seen, want) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      checker.getSymbolAtLocation(node.left) === symbol &&
      exprReaches(node.right, checker, sf, seen, want)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function exportReaches(sf, checker, name, seen, want) {
  if (!sf.symbol) return false;
  const exported = checker.getExportsOfModule(sf.symbol).find((symbol) => symbol.name === name);
  return exported ? symbolReaches(exported, checker, sf, seen, want) : false;
}

function exprReaches(expr, checker, sf, seen, want) {
  const node = unwrap(expr);
  if (!node) return false;
  const access = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  if (access && !(ts.isPropertyAccessExpression(node) && node.name.text === 'sql')) {
    if (want === 'denotes') return false;
    return exprReaches(node.expression, checker, sf, seen, 'denotes') || exprReaches(node.expression, checker, sf, seen, 'uses');
  }
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbolReaches(symbol, checker, sf, seen, want)) return true;
  if (ts.isIdentifier(node) && !symbol && exportReaches(sf, checker, node.text, seen, want)) return true;
  if (ts.isIdentifier(node) && node.text === 'sql' && !aliasesOtherExport(symbol, checker)) return true;
  return false;
}

function templateText(tpl) {
  if (ts.isNoSubstitutionTemplateLiteral(tpl)) return tpl.text;
  if (!ts.isTemplateExpression(tpl)) return null;
  let raw = tpl.head.text;
  for (const span of tpl.templateSpans) raw += '${}' + span.literal.text;
  return raw;
}

function isAllowedSetConfig(node, checker, sf) {
  if (!ts.isTaggedTemplateExpression(node) || !exprReaches(node.tag, checker, sf, new Set(), 'denotes')) return false;
  if (node.typeArguments && node.typeArguments.length > 0) return false;
  const raw = templateText(node.template);
  if (raw === null) return false;
  const norm = raw.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^select set_config\('plerni\.[a-z0-9_]+', ?\$\{\}, ?true\)$/.test(norm);
}

export function lintSource(fileName, sourceText) {
  const { sf, checker } = checkerFor(fileName, sourceText);
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
    if (ts.isCallExpression(node) && exprReaches(node.expression, checker, sf, new Set(), 'uses')) {
      add(node, 'sql-fragment', 'sql call is an escape hatch');
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      exprReaches(node.tag, checker, sf, new Set(), 'uses') &&
      !isAllowedSetConfig(node, checker, sf)
    ) {
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
