// SPDX-License-Identifier: Apache-2.0
// Manifest format v0 (plan §3.1). The field set is closed. Unknown fields fail.
// Edge-type names are parsed from grants. This module does not insert them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginPackageError } from './errors.ts';
import { assertGrantName, edgeTypeNames } from './grants.ts';
import { PLUGIN_ID } from './ident.ts';

const FIELDS = [
  'id',
  'version',
  'license',
  'sdk',
  'provides',
  'requires',
  'optionalRequires',
  'permissions',
  'routes',
  'events',
  'jobs',
  'migrations',
  'ui',
  'grants',
  'classification',
] as const;

const VERSION = /^\d+\.\d+\.\d+$/;
const SDK = /^(?:\*|(\^|~|>=|<=|>|<)?\d+\.\d+\.\d+)$/;
const LICENSE = /^[A-Za-z0-9.+-]+$/;
const MIGRATION = /^sql\/[0-9]{4}_[a-z0-9_]+\.sql$/;
const TOKEN = /^[a-z][a-z0-9_]{0,40}$/;

export interface PluginPermission {
  namespace: string;
  resource: string;
  action: string;
}

export interface PluginManifest {
  id: string;
  version: string;
  license: string;
  sdk: string;
  grants: readonly string[];
  /** Derived from `directory.write_edge:<type>`. Not a manifest field. */
  edgeTypes: readonly string[];
  migrations: readonly string[];
  permissions: readonly PluginPermission[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PluginPackageError(`${label} has unknown field ${key}`);
  }
}

function stringArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PluginPackageError(`${label} is not an array`);
  return value;
}

function objects(value: unknown, label: string): Record<string, unknown>[] {
  return stringArray(value, label).map((item, index) => record(item, `${label}[${index}]`));
}

/**
 * Names a manifest registers with `directory.register_edge_type`.
 * An empty list registers nothing. K17's fixture is empty. The directory
 * insert is a later task; this function does not write.
 */
export function registeredEdgeTypes(manifest: PluginManifest): readonly string[] {
  return manifest.edgeTypes;
}

export function parseManifest(value: unknown): PluginManifest {
  const body = record(value, 'manifest');
  closed(body, FIELDS, 'manifest');
  for (const field of FIELDS) {
    if (!(field in body)) throw new PluginPackageError(`manifest is missing ${field}`);
  }
  const id = body.id;
  const version = body.version;
  const license = body.license;
  const sdk = body.sdk;
  if (typeof id !== 'string' || !PLUGIN_ID.test(id)) {
    throw new PluginPackageError('manifest id is outside the grammar');
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new PluginPackageError('manifest version is not semver');
  }
  if (typeof license !== 'string' || !LICENSE.test(license)) {
    throw new PluginPackageError('manifest license is empty');
  }
  if (typeof sdk !== 'string' || !SDK.test(sdk)) {
    throw new PluginPackageError('manifest sdk is not a semver range');
  }
  for (const item of objects(body.provides, 'provides')) {
    closed(item, ['name', 'version'], 'provides');
    if (typeof item.name !== 'string' || typeof item.version !== 'string') {
      throw new PluginPackageError('provides entry is incomplete');
    }
  }
  for (const field of ['requires', 'optionalRequires'] as const) {
    for (const item of objects(body[field], field)) {
      closed(item, ['plugin', 'contract', 'range'], field);
      if (typeof item.plugin !== 'string' || typeof item.contract !== 'string' || typeof item.range !== 'string') {
        throw new PluginPackageError(`${field} entry is incomplete`);
      }
    }
  }
  const permissions: PluginPermission[] = [];
  for (const item of objects(body.permissions, 'permissions')) {
    closed(item, ['namespace', 'resource', 'action', 'suggestedRoleMappings'], 'permissions');
    if (item.namespace !== id || typeof item.resource !== 'string' || !TOKEN.test(item.resource)) {
      throw new PluginPackageError('permission namespace or resource is invalid');
    }
    if (typeof item.action !== 'string' || !TOKEN.test(item.action)) {
      throw new PluginPackageError('permission action is invalid');
    }
    if (!Array.isArray(item.suggestedRoleMappings)) {
      throw new PluginPackageError('permission suggestedRoleMappings is not an array');
    }
    permissions.push({ namespace: id, resource: item.resource, action: item.action });
  }
  for (const field of ['routes', 'events', 'jobs', 'ui', 'classification'] as const) {
    objects(body[field], field);
  }
  const migrations = stringArray(body.migrations, 'migrations').map((item, index) => {
    if (typeof item !== 'string' || !MIGRATION.test(item)) {
      throw new PluginPackageError(`migrations[${index}] is not a package sql path`);
    }
    return item;
  });
  const grants = stringArray(body.grants, 'grants').map((item, index) => {
    if (typeof item !== 'string') throw new PluginPackageError(`grants[${index}] is not a string`);
    assertGrantName(item);
    return item;
  });
  if (migrations.length > 0 && !grants.includes('db.own_schema')) {
    throw new PluginPackageError('a migrations list implies db.own_schema');
  }
  return {
    id,
    version,
    license,
    sdk,
    grants,
    edgeTypes: edgeTypeNames(grants),
    migrations,
    permissions,
  };
}

export function readManifest(packageDir: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable';
    throw new PluginPackageError(`manifest.json cannot be parsed: ${message}`);
  }
  return parseManifest(parsed);
}
