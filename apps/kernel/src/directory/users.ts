// SPDX-License-Identifier: Apache-2.0
// Directory users inside one tenant. The session tenant is the only tenant
// these statements can see. A missing row is NOT_FOUND.
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

export interface DirectoryUser {
  id: string;
  displayName: string;
}

export interface DirectoryPage {
  afterId?: string;
}

interface UserRow {
  id: string;
  display_name: string;
}

const USER_COLUMNS = sql`id::text AS id, display_name`;

function toUser(row: UserRow): DirectoryUser {
  return { id: row.id, displayName: row.display_name };
}

async function readUser(trx: Transaction<Database>, id: string): Promise<DirectoryUser | null> {
  const result = await sql<UserRow>`
    SELECT ${USER_COLUMNS}
    FROM kernel.directory_user
    WHERE id = ${id}::uuid`.execute(trx);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

export async function createDirectoryUser(
  db: Kysely<Database>,
  tenantId: string,
  input: { id?: string; displayName: string },
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryUser> {
  const displayName = assertLabel(input.displayName);
  const id = input.id === undefined ? randomUUID() : assertDirectoryId(input.id);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx, tenant) => {
    try {
      const stored = await sql<UserRow>`
        INSERT INTO kernel.directory_user (tenant_id, id, display_name)
        VALUES (${tenant}::uuid, ${id}::uuid, ${displayName})
        RETURNING ${USER_COLUMNS}`.execute(trx);
      const row = stored.rows[0];
      if (!row) throw new Error('directory user was not stored');
      return toUser(row);
    } catch (error) {
      if (postgresCode(error) === '23505') throw directoryConflict();
      throw error;
    }
  });
}

export async function getDirectoryUser(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryUser> {
  const userId = assertDirectoryId(id);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const row = await readUser(trx, userId);
    if (!row) throw directoryNotFound('Use the id of a user in this tenant.');
    return row;
  });
}

export async function listDirectoryUsers(
  db: Kysely<Database>,
  tenantId: string,
  page: DirectoryPage,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryUser[]> {
  const after = page.afterId === undefined ? null : assertDirectoryId(page.afterId);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const result = after === null
      ? await sql<UserRow>`
          SELECT ${USER_COLUMNS}
          FROM kernel.directory_user
          ORDER BY id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx)
      : await sql<UserRow>`
          SELECT ${USER_COLUMNS}
          FROM kernel.directory_user
          WHERE id > ${after}::uuid
          ORDER BY id
          LIMIT ${DIRECTORY_PAGE_MAX}`.execute(trx);
    return result.rows.map(toUser);
  });
}

export async function updateDirectoryUser(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  displayName: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<DirectoryUser> {
  const userId = assertDirectoryId(id);
  const label = assertLabel(displayName);
  return inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    const stored = await sql<UserRow>`
      UPDATE kernel.directory_user
      SET display_name = ${label}
      WHERE id = ${userId}::uuid
      RETURNING ${USER_COLUMNS}`.execute(trx);
    const row = stored.rows[0];
    if (!row) throw directoryNotFound('Use the id of a user in this tenant.');
    return toUser(row);
  });
}

export async function deleteDirectoryUser(
  db: Kysely<Database>,
  tenantId: string,
  id: string,
  evidence: HygieneEvidence,
  terminateBackend: (pid: number) => Promise<void>,
): Promise<void> {
  const userId = assertDirectoryId(id);
  await inDirectory(db, tenantId, evidence, terminateBackend, async (trx) => {
    await sql`
      DELETE FROM kernel.directory_edge
      WHERE subject_user_id = ${userId}::uuid OR object_user_id = ${userId}::uuid`.execute(trx);
    await sql`
      DELETE FROM kernel.directory_membership
      WHERE user_id = ${userId}::uuid`.execute(trx);
    const deleted = await sql<{ id: string }>`
      DELETE FROM kernel.directory_user
      WHERE id = ${userId}::uuid
      RETURNING id::text AS id`.execute(trx);
    if (!deleted.rows[0]) throw directoryNotFound('Use the id of a user in this tenant.');
  });
}
