// SPDX-License-Identifier: Apache-2.0
// Edge types are data. registerDirectoryEdgeType inserts a row and does not
// migrate the kernel. write is insertDirectoryEdge, and it inserts only a
// type registeredEdgeTypes lists (plan §5.3, §10.2 question 3). The plugin
// role has no SQL grant on these tables. The broker writes the row.
import { randomUUID } from 'node:crypto';
import type { ContractFailure } from '@plerni/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import { PluginPackageError } from '../plugin/errors.ts';
import { edgeTypeNames } from '../plugin/grants.ts';
import { registeredEdgeTypes, type PluginManifest } from '../plugin/manifest.ts';
import { assertPluginId } from '../plugin/ident.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import { brokerTenant, inDirectory } from './access.ts';
import {
  DIRECTORY_PAGE_MAX,
  assertDirectoryId,
  assertEdgeTypeName,
  directoryConflict,
  directoryNotFound,
  edgeTypeForbidden,
  postgresCode,
  registerForbidden,
  rejectedEdgeUsers,
  rejectedPlugin,
} from './errors.ts';

export interface DirectoryEdgeType {
  id: string;
  name: string;
  pluginId: string;
}

export interface DirectoryEdge {
  id: string;
  typeName: string;
  subjectUserId: string;
  objectUserId: string;
}

export interface DirectoryEdgeInput {
  typeName: string;
  subjectUserId: string;
  objectUserId: string;
}

export interface DirectoryEdgePage {
  afterId?: string;
  typeName?: string;
}

interface TypeRow {
  id: string;
  name: string;
  plugin_id: string;
}

interface EdgeRow {
  id: string;
  type_name: string;
  subject_user_id: string;
  object_user_id: string;
}

function toType(row: TypeRow): DirectoryEdgeType {
  return { id: row.id, name: row.name, pluginId: row.plugin_id };
}

function toEdge(row: EdgeRow): DirectoryEdge {
  return {
    id: row.id,
    typeName: row.type_name,
    subjectUserId: row.subject_user_id,
    objectUserId: row.object_user_id,
  };
}

function listedTypes(manifest: PluginManifest): readonly string[] {
  if (!Array.isArray(manifest.grants) || manifest.grants.some((grant) => typeof grant !== 'string')) {
    throw edgeTypeForbidden();
  }
  let parsed: readonly string[];
  try {
    parsed = edgeTypeNames(manifest.grants);
  } catch (error) {
    if (error instanceof PluginPackageError) throw edgeTypeForbidden();
    throw error;
  }
  const published = registeredEdgeTypes(manifest);
  if (!Array.isArray(published) || published.length !== parsed.length || published.some((name, index) => name !== parsed[index])) {
    throw edgeTypeForbidden();
  }
  return parsed;
}

function requireListed(manifest: PluginManifest, typeName: string): void {
  if (!listedTypes(manifest).includes(typeName)) throw edgeTypeForbidden();
}

/** Operator approval is a row, not the manifest the caller presents (ADR-0008 decision 1). */
async function requireInstalledGrant(
  trx: Transaction<Database>,
  pluginId: string,
  grantName: string,
  deny: () => ContractFailure,
): Promise<void> {
  const approved = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM kernel.plugin_grant
    WHERE plugin_id = ${pluginId} AND grant_name = ${grantName}`.execute(trx);
  if (!approved.rows[0]) throw deny();
}

function pluginIdOf(manifest: PluginManifest): string {
  try {
    assertPluginId(manifest.id);
  } catch (error) {
    if (error instanceof PluginPackageError) throw rejectedPlugin();
    throw error;
  }
  return manifest.id;
}

async function readType(trx: Transaction<Database>, name: string): Promise<DirectoryEdgeType | null> {
  const result = await sql<TypeRow>`
    SELECT id::text AS id, name, plugin_id
    FROM kernel.directory_edge_type
    WHERE name = ${name}`.execute(trx);
  const row = result.rows[0];
  return row ? toType(row) : null;
}

export async function registerDirectoryEdgeType(
  db: Kysely<Database>,
  tenantId: string,
  manifest: PluginManifest,
  typeName: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryEdgeType> {
  const name = assertEdgeTypeName(typeName);
  if (!Array.isArray(manifest.grants) || !manifest.grants.includes('directory.register_edge_type')) {
    throw registerForbidden();
  }
  requireListed(manifest, name);
  const pluginId = pluginIdOf(manifest);
  const writeGrant = `directory.write_edge:${name}`;
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx, tenant) => {
    await requireInstalledGrant(trx, pluginId, 'directory.register_edge_type', registerForbidden);
    await requireInstalledGrant(trx, pluginId, writeGrant, edgeTypeForbidden);
    const inserted = await sql<TypeRow>`
      INSERT INTO kernel.directory_edge_type (tenant_id, id, name, plugin_id)
      VALUES (${tenant}::uuid, ${randomUUID()}::uuid, ${name}, ${pluginId})
      ON CONFLICT ON CONSTRAINT directory_edge_type_name DO NOTHING
      RETURNING id::text AS id, name, plugin_id`.execute(trx);
    const created = inserted.rows[0];
    if (created) return toType(created);
    const existing = await readType(trx, name);
    if (!existing) throw new Error('edge type was not stored');
    if (existing.pluginId !== pluginId) throw directoryConflict();
    return existing;
  });
}

/**
 * Broker insert. Caller keeps this on the app role, in the same transaction
 * as any plugin statement. An unlisted type throws and does not insert.
 */
export async function insertDirectoryEdge(
  trx: Transaction<Database>,
  manifest: PluginManifest,
  input: DirectoryEdgeInput,
): Promise<DirectoryEdge> {
  const tenant = await brokerTenant(trx);
  const typeName = assertEdgeTypeName(input.typeName);
  requireListed(manifest, typeName);
  await requireInstalledGrant(trx, pluginIdOf(manifest), `directory.write_edge:${typeName}`, edgeTypeForbidden);
  const subjectUserId = assertDirectoryId(input.subjectUserId);
  const objectUserId = assertDirectoryId(input.objectUserId);
  if (subjectUserId === objectUserId) throw rejectedEdgeUsers();
  const edgeType = await readType(trx, typeName);
  if (!edgeType) throw directoryNotFound('Register that edge type before writing an edge.');
  const users = await sql<{ id: string }>`
    SELECT id::text AS id
    FROM kernel.directory_user
    WHERE id IN (${subjectUserId}::uuid, ${objectUserId}::uuid)`.execute(trx);
  if (users.rows.length !== 2) throw directoryNotFound('Choose two users in this tenant.');
  let inserted: { rows: { id: string }[] };
  try {
    inserted = await sql<{ id: string }>`
      INSERT INTO kernel.directory_edge (tenant_id, id, type_id, subject_user_id, object_user_id)
      VALUES (
        ${tenant}::uuid,
        ${randomUUID()}::uuid,
        ${edgeType.id}::uuid,
        ${subjectUserId}::uuid,
        ${objectUserId}::uuid
      )
      ON CONFLICT ON CONSTRAINT directory_edge_once DO NOTHING
      RETURNING id::text AS id`.execute(trx);
  } catch (error) {
    if (postgresCode(error) === '23503') throw directoryNotFound('Choose two users in this tenant.');
    throw error;
  }
  const created = inserted.rows[0];
  if (created) {
    return { id: created.id, typeName, subjectUserId, objectUserId };
  }
  const existing = await sql<EdgeRow>`
    SELECT e.id::text AS id, t.name AS type_name,
           e.subject_user_id::text AS subject_user_id,
           e.object_user_id::text AS object_user_id
    FROM kernel.directory_edge e
    JOIN kernel.directory_edge_type t
      ON t.tenant_id = e.tenant_id AND t.id = e.type_id
    WHERE e.type_id = ${edgeType.id}::uuid
      AND e.subject_user_id = ${subjectUserId}::uuid
      AND e.object_user_id = ${objectUserId}::uuid`.execute(trx);
  const row = existing.rows[0];
  if (!row) throw new Error('directory edge was not stored');
  return toEdge(row);
}

export async function listDirectoryEdges(
  db: Kysely<Database>,
  tenantId: string,
  page: DirectoryEdgePage,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryEdge[]> {
  const after = page.afterId === undefined ? null : assertDirectoryId(page.afterId);
  const typeName = page.typeName === undefined ? null : assertEdgeTypeName(page.typeName);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const result = await sql<EdgeRow>`
      SELECT e.id::text AS id, t.name AS type_name,
             e.subject_user_id::text AS subject_user_id,
             e.object_user_id::text AS object_user_id
      FROM kernel.directory_edge e
      JOIN kernel.directory_edge_type t
        ON t.tenant_id = e.tenant_id AND t.id = e.type_id
      WHERE (${after}::uuid IS NULL OR e.id > ${after}::uuid)
        AND (${typeName}::text IS NULL OR t.name = ${typeName})
      ORDER BY e.id
      LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx);
    return result.rows.map(toEdge);
  });
}

export async function deleteDirectoryEdge(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  const edgeId = assertDirectoryId(id);
  await inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const deleted = await sql<{ id: string }>`
      DELETE FROM kernel.directory_edge
      WHERE id = ${edgeId}::uuid
      RETURNING id::text AS id`.execute(trx);
    if (!deleted.rows[0]) throw directoryNotFound('Use the id of an edge in this tenant.');
  });
}
