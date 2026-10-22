/**
 * Service-level test — `AttachmentService.restoreAttachment` returns
 * `410 GONE` when the source object version is no longer recoverable
 * from object storage (AC-424; the race
 * window between the bucket lifecycle reaper and the row reaper).
 *
 * Why a stand-alone file. The integration sibling
 * `attachments-routes.test.ts` cannot reach this surface because the
 * dev/test storage credentials inherit the same restricted capability
 * profile as production (`writeFiles, readFiles, listFiles` only —
 * ADR-0022). A versioned `DeleteObject` against the test bucket fails
 * `AccessDenied` by design, so we cannot simulate the lifecycle reap
 * by destroying the version. Stubbing `copyFromVersion` at the service
 * boundary gets the same coverage with no architectural compromise:
 * the AppError shape (`statusCode = 410`, `code = 'GONE'`) is what the
 * global `setErrorHandler` maps to the HTTP response, and the
 * AppError-to-response mapping is already verified elsewhere.
 *
 * Raw-SQL attachment seeding mirrors the pattern in
 * `attachments-hidden-reaper.test.ts` — we need control over fields the
 * service surface won't let us set (status='hidden' without going
 * through init/complete/hide round-trip).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';
import type { Readable } from 'node:stream';

import { createDatabase, type Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { validateEnvRuntime, getEnv } from '../config/env.js';
import { AttachmentService } from '../services/AttachmentService.js';
import { StorageObjectNotFoundError, type AttachmentStorageClient } from '../storage/client.js';
import { AppError } from '../errors.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from '../services/Logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

const SILENT_LOGGER: ServiceLogger = {
  info: () => {},
  error: () => {},
};

/**
 * Seed an attachment at status='hidden' with a versionId set, ready
 * for restore. Mirrors `seedHiddenAt` in `attachments-hidden-reaper.test.ts`.
 */
async function seedHiddenForRestore(db: Database, projectId: string): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const filename = `restore-fixture-${id.slice(0, 6)}.pdf`;
  const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail, version_id, hidden_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'hidden', 'binary', 'sonstiges',
            ${filename}, 'application/pdf', 2048,
            2064,
            ${`attachments/${projectId}/${id}.orig`}, NULL,
            FALSE, ${'v-' + id.slice(0, 8)}, now(),
            ${wrappedDek}, NULL, 1)
  `);
  return { id };
}

/**
 * Storage stub whose only job is to throw `StorageObjectNotFoundError`
 * on `copyFromVersion`. Every other method throws — restoreAttachment
 * must not touch them, and an unexpected hit fails the test loudly.
 */
function stubStorageBytesGone(): AttachmentStorageClient {
  const fail = (name: string) => () => {
    throw new Error(`stubStorageBytesGone: ${name} unexpectedly called`);
  };
  return {
    copyFromVersion: async (key: string) => {
      throw new StorageObjectNotFoundError(key);
    },
    upload: fail('upload'),
    delete: fail('delete'),
    presignGet: fail('presignGet'),
    createPresignedPut: fail('createPresignedPut'),
    createPresignedGet: fail('createPresignedGet'),
    headObject: fail('headObject'),
    hide: fail('hide'),
    getObject: (() => fail('getObject')()) as unknown as (key: string) => Promise<Readable>,
    putObject: fail('putObject'),
    listObjects: fail('listObjects'),
    getBucketSafetyConfig: fail('getBucketSafetyConfig'),
    probeDeleteVersionCapability: fail('probeDeleteVersionCapability'),
  } as unknown as AttachmentStorageClient;
}

describe('AttachmentService.restoreAttachment — bytes-gone race (AC-424)', () => {
  let db: Database;
  let pool: pg.Pool;
  let projectId: string;
  let owner: AuthUser;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const projectRow = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    projectId = (projectRow.rows[0] as { id: string }).id;

    // Pull the seeded inhaber as the caller — owner role passes the
    // isProjectInScope predicate trivially.
    const userRow = await db.execute(sql`
      SELECT id, username, display_name, email, roles
        FROM users
       WHERE username = 'inhaber'
       LIMIT 1
    `);
    const r = userRow.rows[0] as {
      id: string;
      username: string;
      display_name: string;
      email: string | null;
      roles: string[];
    };
    owner = {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      roles: r.roles,
      email: r.email,
      themePreference: 'system',
      pushMuted: false,
    };
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Tests below seed their own row; clear so audit-log assertions
    // would be deterministic if added in the future.
    await db.execute(sql`DELETE FROM audit_log`);
    await db.execute(sql`DELETE FROM attachments`);
  });

  it('throws AppError(410, GONE) when copyFromVersion reports the source version missing', async () => {
    const env = getEnv();
    const { id } = await seedHiddenForRestore(db, projectId);
    const service = new AttachmentService({
      db,
      storage: stubStorageBytesGone(),
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? 'age1stub',
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
    });

    await expect(
      service.restoreAttachment(owner, projectId, id, SILENT_LOGGER, null),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: 'GONE',
    });
  });

  it('rolls back the Phase 1 CAS on bytes-gone — row stays at status=hidden', async () => {
    const env = getEnv();
    const { id } = await seedHiddenForRestore(db, projectId);
    const service = new AttachmentService({
      db,
      storage: stubStorageBytesGone(),
      binaryAgeRecipient: env.BINARY_AGE_RECIPIENT ?? 'age1stub',
      binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
    });

    await expect(
      service.restoreAttachment(owner, projectId, id, SILENT_LOGGER, null),
    ).rejects.toBeInstanceOf(AppError);

    // mutate() rolls back on throw — status must NOT have leaked from
    // Phase 1 (markRestored flipped it to 'ready' inside the tx). The
    // row must still be visible to the next sweep / Papierkorb listing.
    const after = await db.execute(sql`SELECT status FROM attachments WHERE id = ${id}`);
    expect((after.rows[0] as { status: string }).status).toBe('hidden');

    // No audit row is committed — the rolled-back tx took the
    // attachment:restore audit row with it.
    const auditCount = await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM audit_log WHERE entity_id = ${id}`,
    );
    expect((auditCount.rows[0] as { c: number }).c).toBe(0);
  });
});
