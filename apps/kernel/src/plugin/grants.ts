// SPDX-License-Identifier: Apache-2.0
// Closed P1 grant vocabulary (ADR-0008 decision 1). A new name is an ADR.
// `clock` is ambient. `ai.complete` is reserved for the P3 gateway and is not issued.
import { PluginPackageError } from './errors.ts';

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const EVENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

const EXACT = new Set([
  'db.own_schema',
  'directory.read',
  'directory.register_edge_type',
  'storage.prefix',
  'notify.send',
  'secrets.sign',
  'secrets.verify',
  'config.own',
  'audit.append',
]);

const PREFIXES: readonly { prefix: string; rest: RegExp }[] = [
  { prefix: 'events.publish:', rest: EVENT },
  { prefix: 'events.subscribe:', rest: EVENT },
  { prefix: 'jobs.handle:', rest: NAME },
  { prefix: 'directory.write_edge:', rest: NAME },
  { prefix: 'secrets.use:', rest: NAME },
  { prefix: 'http.egress:', rest: HOST },
];

export function assertGrantName(grant: string): void {
  if (typeof grant !== 'string') throw new PluginPackageError('grant name is missing');
  if (EXACT.has(grant)) return;
  for (const item of PREFIXES) {
    if (!grant.startsWith(item.prefix)) continue;
    const rest = grant.slice(item.prefix.length);
    if (rest.length > 0 && item.rest.test(rest)) return;
  }
  throw new PluginPackageError(`grant is outside the vocabulary: ${grant}`);
}

/** Edge-type names the manifest lists. They are the suffixes of `directory.write_edge:<type>`. */
export function edgeTypeNames(grants: readonly string[]): readonly string[] {
  const names = new Set<string>();
  for (const grant of grants) {
    const prefix = 'directory.write_edge:';
    if (!grant.startsWith(prefix)) continue;
    const name = grant.slice(prefix.length);
    if (!NAME.test(name)) throw new PluginPackageError(`edge type is outside the grammar: ${grant}`);
    names.add(name);
  }
  return [...names].sort();
}
