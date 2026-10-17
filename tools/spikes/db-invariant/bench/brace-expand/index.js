// SPDX-License-Identifier: Apache-2.0
// Stand-in for the braces package. micromatch calls this while expanding
// a pattern. Patterns with no braces pass through. A nested pattern is
// rejected at a fixed depth instead of walking the AST recursively
// (GHSA-vfj7-8cjw-p6xm: braces through 3.0.3 has no patched release).
// The benchmark does not pass brace patterns. kysely-codegen's matcher
// uses picomatch and does not call this function.

'use strict';

const MAX_DEPTH = 8;

function braceExpand(pattern, options, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error('brace pattern exceeds the depth cap');
  }
  const open = pattern.indexOf('{');
  if (open === -1 || pattern.indexOf('}', open) === -1) return [pattern];
  let close = -1;
  let level = 0;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') level += 1;
    else if (pattern[i] === '}') {
      level -= 1;
      if (level === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];
  const body = pattern.slice(open + 1, close);
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const parts = splitTop(body);
  const expanded = options && options.expand === true;
  if (!expanded) {
    const inner = parts.map((part) => braceExpand(part, options, depth + 1).join('')).join('|');
    return braceExpand(`${prefix}(${inner})${suffix}`, options, depth + 1);
  }
  const out = [];
  for (const part of parts) {
    for (const choice of braceExpand(part, options, depth + 1)) {
      out.push(...braceExpand(`${prefix}${choice}${suffix}`, options, depth + 1));
    }
  }
  return out;
}

function splitTop(body) {
  const parts = [];
  let level = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') level += 1;
    else if (body[i] === '}') level -= 1;
    else if (body[i] === ',' && level === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function braces(pattern, options) {
  if (typeof pattern !== 'string') throw new TypeError('Expected a string');
  return braceExpand(pattern, options, 0);
}

module.exports = braces;
