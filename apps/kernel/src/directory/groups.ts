// SPDX-License-Identifier: Apache-2.0
// Directory groups and memberships. Both endpoints of a membership are users
// and groups in the authorized tenant. The foreign key includes tenant_id.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/database.ts';
import type { HygieneEvidence } from '../tenancy/hygiene.ts';
import { inDirectory } from './access.ts';
import {
  DIRECTORY_PAGE_MAX,
  assertDirectoryId,
  assertLabel,
  directoryConflict,
  directoryNotFound,
  postgresCode,
} from './errors.ts';
import type { DirectoryPage } from './users.ts';

export interface DirectoryGroup {
  id: string;
  name: string;
}

export interface DirectoryMembership {
  id: string;
  groupId: string;
  userId: string;
}

interface GroupRow {
  id: string;
  name: string;
}

interface MembershipRow {
  id: string;
  group_id: string;
  user_id: string;
}

function toGroup(row: GroupRow): DirectoryGroup {
  return { id: row.id, name: row.name };
}

function toMembership(row: MembershipRow): DirectoryMembership {
  return { id: row.id, groupId: row.group_id, userId: row.user_id };
}

async function requireGroup(trx: Transaction<Database>, id: string): Promise<void> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id FROM kernel.directory_group WHERE id = ${id}::uuid`.execute(trx);
  if (!result.rows[0]) throw directoryNotFound('Use the id of a group in this tenant.');
}

async function requireUser(trx: Transaction<Database>, id: string): Promise<void> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id FROM kernel.directory_user WHERE id = ${id}::uuid`.execute(trx);
  if (!result.rows[0]) throw directoryNotFound('Use the id of a user in this tenant.');
}

export async function createDirectoryGroup(
  db: Kysely<Database>,
  tenantId: string,
  input: { id?: string; name: string },
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryGroup> {
  const name = assertLabel(input.name);
  const id = input.id === undefined ? randomUUID() : assertDirectoryId(input.id);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx, tenant) => {
    try {
      const stored = await sql<GroupRow>`
        INSERT INTO kernel.directory_group (tenant_id, id, name)
        VALUES (${tenant}::uuid, ${id}::uuid, ${name})
        RETURNING id::text AS id, name`.execute(trx);
      const row = stored.rows[0];
      if (!row) throw new Error('directory group was not stored');
      return toGroup(row);
    } catch (error) {
      if (postgresCode(error) === '23505') throw directoryConflict();
      throw error;
    }
  });
}

export async function listDirectoryGroups(
  db: Kysely<Database>,
  tenantId: string,
  page: DirectoryPage,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryGroup[]> {
  const after = page.afterId === undefined ? null : assertDirectoryId(page.afterId);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const result = after === null
      ? await sql<GroupRow>`
          SELECT id::text AS id, name
          FROM kernel.directory_group
          ORDER BY kernel.directory_group.id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx)
      : await sql<GroupRow>`
          SELECT id::text AS id, name
          FROM kernel.directory_group
          WHERE id > ${after}::uuid
          ORDER BY kernel.directory_group.id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx);
    return result.rows.map(toGroup);
  });
}

export async function updateDirectoryGroup(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  name: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryGroup> {
  const groupId = assertDirectoryId(id);
  const label = assertLabel(name);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    try {
      const stored = await sql<GroupRow>`
        UPDATE kernel.directory_group
        SET name = ${label}
        WHERE id = ${groupId}::uuid
        RETURNING id::text AS id, name`.execute(trx);
      const row = stored.rows[0];
      if (!row) throw directoryNotFound('Use the id of a group in this tenant.');
      return toGroup(row);
    } catch (error) {
      if (postgresCode(error) === '23505') throw directoryConflict();
      throw error;
    }
  });
}

export async function deleteDirectoryGroup(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
  afterLock?: () => Promise<void>,
): Promise<void> {
  const groupId = assertDirectoryId(id);
  await inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const locked = await sql<{ id: string }>`
      SELECT id::text AS id
      FROM kernel.directory_group
      WHERE id = ${groupId}::uuid
      FOR UPDATE`.execute(trx);
    if (!locked.rows[0]) throw directoryNotFound('Use the id of a group in this tenant.');
    if (afterLock) await afterLock();
    try {
      await sql`DELETE FROM kernel.directory_membership WHERE group_id = ${groupId}::uuid`.execute(trx);
      const deleted = await sql<{ id: string }>`
        DELETE FROM kernel.directory_group
        WHERE id = ${groupId}::uuid
        RETURNING id::text AS id`.execute(trx);
      if (!deleted.rows[0]) throw directoryNotFound('Use the id of a group in this tenant.');
    } catch (error) {
      if (postgresCode(error) === '23503') throw directoryNotFound('Use the id of a group in this tenant.');
      throw error;
    }
  });
}

export async function addDirectoryMember(
  db: Kysely<Database>,
  tenantId: string,
  input: { id?: string; groupId: string; userId: string },
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryMembership> {
  const groupId = assertDirectoryId(input.groupId);
  const userId = assertDirectoryId(input.userId);
  const id = input.id === undefined ? randomUUID() : assertDirectoryId(input.id);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx, tenant) => {
    await requireGroup(trx, groupId);
    await requireUser(trx, userId);
    const existing = await sql<MembershipRow>`
      SELECT id::text AS id, group_id::text AS group_id, user_id::text AS user_id
      FROM kernel.directory_membership
      WHERE group_id = ${groupId}::uuid AND user_id = ${userId}::uuid`.execute(trx);
    const already = existing.rows[0];
    if (already) return toMembership(already);
    try {
      const stored = await sql<MembershipRow>`
        INSERT INTO kernel.directory_membership (tenant_id, id, group_id, user_id)
        VALUES (${tenant}::uuid, ${id}::uuid, ${groupId}::uuid, ${userId}::uuid)
        RETURNING id::text AS id, group_id::text AS group_id, user_id::text AS user_id`.execute(trx);
      const row = stored.rows[0];
      if (!row) throw new Error('directory membership was not stored');
      return toMembership(row);
    } catch (error) {
      if (postgresCode(error) === '23505') throw directoryConflict();
      if (postgresCode(error) === '23503') throw directoryNotFound('Choose a user and a group in this tenant.');
      throw error;
    }
  });
}

export async function listDirectoryMembers(
  db: Kysely<Database>,
  tenantId: string,
  groupId: string,
  page: DirectoryPage,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryMembership[]> {
  const group = assertDirectoryId(groupId);
  const after = page.afterId === undefined ? null : assertDirectoryId(page.afterId);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    await requireGroup(trx, group);
    const result = after === null
      ? await sql<MembershipRow>`
          SELECT id::text AS id, group_id::text AS group_id, user_id::text AS user_id
          FROM kernel.directory_membership
          WHERE group_id = ${group}::uuid
          ORDER BY kernel.directory_membership.id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx)
      : await sql<MembershipRow>`
          SELECT id::text AS id, group_id::text AS group_id, user_id::text AS user_id
          FROM kernel.directory_membership
          WHERE group_id = ${group}::uuid AND id > ${after}::uuid
          ORDER BY kernel.directory_membership.id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx);
    return result.rows.map(toMembership);
  });
}

export async function removeDirectoryMember(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  const membershipId = assertDirectoryId(id);
  await inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const deleted = await sql<{ id: string }>`
      DELETE FROM kernel.directory_membership
      WHERE id = ${membershipId}::uuid
      RETURNING id::text AS id`.execute(trx);
    if (!deleted.rows[0]) throw directoryNotFound('Use the id of a membership in this tenant.');
  });
}
