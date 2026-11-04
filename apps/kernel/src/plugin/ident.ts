// SPDX-License-Identifier: Apache-2.0
// Manifest ids and the names derived from them (ADR-0008 decision 2).
import { PluginPackageError } from './errors.ts';

/** Plan §3.1 id grammar. Schema and role names are derived; authors do not choose them. */
export const PLUGIN_ID = /^[a-z][a-z0-9_]{0,40}$/;

const IDENT = /^[a-z_][a-z0-9_]*$/;

export function assertPluginId(id: string): void {
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
    throw new PluginPackageError('plugin id is outside the manifest grammar');
  }
}

export function pluginRoleName(id: string): string {
  assertPluginId(id);
  return `plerni_plugin_${id}`;
}

export function pluginSchemaName(id: string): string {
  assertPluginId(id);
  return `plugin_${id}`;
}

/** Quote an identifier that already matched the allowlist. */
export function quoteIdent(id: string): string {
  if (!IDENT.test(id)) throw new PluginPackageError(`refusing unexpected identifier: ${id}`);
  return `"${id}"`;
}
