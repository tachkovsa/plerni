// SPDX-License-Identifier: Apache-2.0
// named-statements.ts — A4b client path (plan §3.1).
// node-postgres sends parameterized queries as unnamed extended-protocol statements
// (pg 8.23.1 Query.requiresPreparation). PgBouncer transaction mode only tracks
// protocol-level *named* statements, and only when max_prepared_statements > 0
// (PgBouncer 1.26.0 doc/config.md). Naming is installed for the A4b rerun and
// removed afterward: A4 still requires empty names on the default client.
// Transaction and session commands stay simple queries. PgBouncer detects
// transaction end from those simple commands, and the admin console accepts
// SHOW only as a simple query.
import { createHash } from 'node:crypto';
import pg from 'pg';

const SIMPLE_PROTOCOL = /^(?:begin|commit|rollback|start|end|savepoint|release|set|reset|discard|deallocate|show|listen|unlisten|notify)\b/i;

export interface QueryConfig {
  text: string;
  values?: unknown[];
  name?: string;
}

export function statementName(text: string): string {
  return `n${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/** Copy. An existing name is kept. Workload SQL gets a stable name and an array of values. */
export function namedQueryConfig(config: QueryConfig): QueryConfig {
  if (config.name) return { ...config };
  const text = config.text.trim();
  if (SIMPLE_PROTOCOL.test(text)) return { ...config };
  return { ...config, name: statementName(config.text), values: config.values ?? [] };
}

type QueryFn = (...args: unknown[]) => unknown;

function isConfig(value: unknown): value is QueryConfig & Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'text' in value
    && typeof (value as { text: unknown }).text === 'string'
    && typeof (value as { submit?: unknown }).submit !== 'function';
}

/**
 * Assign a stable protocol name to workload queries on every pg client.
 * Returns the restore function. Restore before the next unnamed-discipline probe.
 */
export function installNamedStatements(): () => void {
  const proto = pg.Client.prototype as unknown as { query: QueryFn };
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const config = args[0];
    const values = args[1];
    const callback = args[2];
    if (typeof config === 'string') {
      const cb = typeof values === 'function' ? values : callback;
      const input: QueryConfig = { text: config };
      if (Array.isArray(values)) input.values = values;
      const named = namedQueryConfig(input);
      if (named.name) {
        if (typeof cb === 'function') return original.call(this, named, cb);
        return original.call(this, named);
      }
      return original.call(this, ...args);
    }
    if (isConfig(config)) {
      const input: QueryConfig = { text: config.text };
      if (Array.isArray(config.values)) input.values = config.values;
      else if (Array.isArray(values)) input.values = values;
      if (typeof config.name === 'string' && config.name !== '') input.name = config.name;
      const named = namedQueryConfig(input);
      if (named.name) {
        const next = { ...config, ...named };
        const cb = typeof values === 'function' ? values : callback;
        if (typeof cb === 'function') return original.call(this, next, cb);
        return original.call(this, next);
      }
    }
    return original.call(this, ...args);
  };
  return () => {
    proto.query = original;
  };
}
