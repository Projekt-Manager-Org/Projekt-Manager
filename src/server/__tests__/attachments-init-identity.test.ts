/**
 * Attachment init — identity fields come from the server (#565).
 *
 * data-model.md §5.13 Ownership: `createdBy` is set from the session at
 * init; a client-supplied value is ignored. The only carve-out is the
 * server-side import job — there is no client-facing override of `id`,
 * `createdBy` or `createdAt`.
 *
 * Regression: init used to accept a `restore: { id, createdBy, createdAt }`
 * block from any caller holding `data:restore` + `attachment:write`, and
 * persisted the supplied values verbatim.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startApp, stopApp, login, authGet, authPost } from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';

const year = new Date().getFullYear();

async function projectIdByNumber(token: string, number: string): Promise<string> {
  const res = await authGet(token, '/api/projects?limit=200');
  const p = (res.json().data as { id: string; number: string }[]).find((r) => r.number === number);
  if (!p) throw new Error(`seed missing ${number}`);
  return p.id;
}

async function rowById(
  id: string,
): Promise<{ createdBy: string | null; createdAt: Date } | undefined> {
  const { db, pool } = createDatabase();
  try {
    const res = await db.execute(
      sql`SELECT created_by, created_at FROM attachments WHERE id = ${id} LIMIT 1`,
    );
    const row = res.rows[0] as { created_by: string | null; created_at: Date } | undefined;
    return row && { createdBy: row.created_by, createdAt: new Date(row.created_at) };
  } finally {
    await pool.end();
  }
}

describe('Attachment init — client-supplied identity is never persisted', () => {
  let ownerToken: string;
  let ownerId: string;
  let officeId: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    const officeToken = await login(SEED_USERS.office.username, SEED_DEFAULT_PASSWORD);
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    ownerId = (await authGet(ownerToken, '/api/auth/me')).json().user.id as string;
    officeId = (await authGet(officeToken, '/api/auth/me')).json().user.id as string;
    projectId = await projectIdByNumber(ownerToken, `${year}-007`);
  });

  afterAll(async () => {
    await stopApp();
  });

  it('a restore block from an owner (data:restore + attachment:write) sets no identity field', async () => {
    const forged = {
      id: '11111111-2222-4333-8444-555555555555',
      createdBy: officeId,
      createdAt: '2024-03-14T15:09:26.535Z',
    };
    const before = Date.now();
    const res = await authPost(ownerToken, `/api/projects/${projectId}/attachments/init`, {
      ...binaryInitBody({ fileName: 'forged.pdf', sizeBytes: 200, label: 'sonstiges' }),
      restore: forged,
    });

    // §5.13: the supplied values are ignored — the upload proceeds with
    // server-minted identity.
    expect(res.statusCode).toBe(201);
    expect(await rowById(forged.id)).toBeUndefined();
    const row = await rowById(res.json().attachment.id as string);
    expect(row?.createdBy).toBe(ownerId);
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });
});
