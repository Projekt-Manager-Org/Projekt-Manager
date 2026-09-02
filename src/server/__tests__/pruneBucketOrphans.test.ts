/**
 * Integration test — pruneBucketOrphans (SEED=force bucket reset and the
 * `scripts/prune-bucket-orphans.ts` ops entrypoint).
 *
 * Pins the contract:
 *   - keys present in the bucket but NOT in `attachments.original_key` /
 *     `thumb_key` (across every status) are passed to `storage.hide()`
 *     when `apply` is true;
 *   - keys still referenced by an attachment row — including `hidden`
 *     rows whose original/thumb keys back the un-hide flow — are
 *     preserved;
 *   - the result counts (`bucketObjectCount`, `preservedCount`,
 *     `orphanCount`) and `orphanKeys` match what was hidden vs. preserved;
 *   - `apply: false` (the ops-entrypoint default) reports the identical
 *     diff and hides nothing — the dry run is a pure read.
 *
 * The bucket lister is injected (`listAllBucketKeys`) so the test never
 * issues a real ListObjectsV2 against the developer's working bucket —
 * pruneBucketOrphans is unbounded by design, and the integration suite
 * shares `STORAGE_BUCKET` with `npm run dev`. Storage `hide()` is also
 * stubbed so no delete-marker writes leave the test fork.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { validateEnvRuntime } from '../config/env.js';
import {
  pruneBucketOrphans,
  type PruneBucketOrphansLogger,
} from '../storage/pruneBucketOrphans.js';
import type { AttachmentStorageClient } from '../storage/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/**
 * Minimal pending-attachment insert: explicit `original_key` so the test
 * controls exactly which keys the prune treats as referenced. Mirrors the
 * raw-INSERT pattern used by `attachments-reaper.test.ts`.
 */
async function seedAttachment(
  db: Database,
  projectId: string,
  status: 'pending' | 'ready' | 'hidden',
  originalKey: string,
  thumbKey: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  // ready/hidden rows must satisfy attachments_wrapped_dek_required_when_ready
  // — synthetic 192-byte envelope is enough; this test never unwraps.
  const wrappedDek =
    status === 'ready' || status === 'hidden' ? Buffer.alloc(192, 0x33).toString('base64') : null;
  const ciphertextSize = status === 'ready' || status === 'hidden' ? 1088 : null;
  const hiddenAt = status === 'hidden' ? new Date().toISOString() : null;
  await db.execute(sql`
    INSERT INTO attachments (
      id, project_id, status, kind, label, filename, mime_type, size_bytes,
      original_key, thumb_key, has_thumbnail,
      wrapped_dek, ciphertext_size_bytes, wrapped_dek_version, hidden_at
    ) VALUES (
      ${id}, ${projectId}, ${status}, 'binary', 'sonstiges',
      ${'k-' + id.slice(0, 6)}, 'application/pdf', 1024,
      ${originalKey}, ${thumbKey}, ${thumbKey !== null},
      ${wrappedDek}, ${ciphertextSize}, 1, ${hiddenAt}
    )
  `);
  return id;
}

function makeStorageStub(): AttachmentStorageClient {
  // Only `hide()` is exercised by pruneBucketOrphans; the rest of the
  // surface is unused, so the stub leaves them undefined rather than
  // pretending to implement them.
  return {
    hide: vi.fn().mockResolvedValue(undefined),
  } as unknown as AttachmentStorageClient;
}

function makeLogger() {
  const info = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  return { info, warn } satisfies PruneBucketOrphansLogger;
}

describe('pruneBucketOrphans', () => {
  let db: Database;
  let pool: pg.Pool;
  let projectId: string;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const r = await db.execute<{ id: string }>(sql`SELECT id FROM projects LIMIT 1`);
    projectId = r.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Each test gets a clean attachments table — projects/users are
    // preserved (FK targets).
    await db.execute(sql`DELETE FROM attachments`);
  });

  it('hides orphan bucket keys and preserves DB-referenced keys', async () => {
    const refOrigKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const refThumbKey = `attachments/${projectId}/${crypto.randomUUID()}.thumb`;
    const orphanKey1 = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const orphanKey2 = `__probe/safety`;

    await seedAttachment(db, projectId, 'ready', refOrigKey, refThumbKey);

    const storage = makeStorageStub();
    const lister = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValue([refOrigKey, refThumbKey, orphanKey1, orphanKey2]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans(db, storage, lister, logger, 'test-bucket', true);

    expect(result).toEqual({
      bucketObjectCount: 4,
      preservedCount: 2,
      orphanCount: 2,
      orphanKeys: [orphanKey1, orphanKey2],
    });

    const hide = storage.hide as ReturnType<typeof vi.fn>;
    const hidden = hide.mock.calls.map((c) => c[0] as string).sort();
    expect(hidden).toEqual([orphanKey1, orphanKey2].sort());

    // Single warn line (orphans > 0); no error/info for a non-empty sweep.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/2 orphan object\(s\)/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('preserves keys referenced by hidden rows (un-hide flow needs them)', async () => {
    const hiddenOrigKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;

    await seedAttachment(db, projectId, 'hidden', hiddenOrigKey, null);

    const storage = makeStorageStub();
    const lister = vi.fn<() => Promise<string[]>>().mockResolvedValue([hiddenOrigKey, orphanKey]);

    const result = await pruneBucketOrphans(db, storage, lister, makeLogger(), 'test-bucket', true);

    expect(result.orphanCount).toBe(1);
    expect(result.preservedCount).toBe(1);
    const hide = storage.hide as ReturnType<typeof vi.fn>;
    expect(hide).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledWith(orphanKey);
  });

  it('emits info (not warn) and calls hide zero times when bucket has no orphans', async () => {
    const refKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    await seedAttachment(db, projectId, 'pending', refKey, null);

    const storage = makeStorageStub();
    const lister = vi.fn<() => Promise<string[]>>().mockResolvedValue([refKey]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans(db, storage, lister, logger, 'test-bucket', true);

    expect(result).toEqual({
      bucketObjectCount: 1,
      preservedCount: 1,
      orphanCount: 0,
      orphanKeys: [],
    });
    expect(storage.hide).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('handles an empty bucket as a no-op', async () => {
    const storage = makeStorageStub();
    const lister = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans(db, storage, lister, logger, 'test-bucket', true);

    expect(result).toEqual({
      bucketObjectCount: 0,
      preservedCount: 0,
      orphanCount: 0,
      orphanKeys: [],
    });
    expect(storage.hide).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('reports the identical diff without hiding anything when apply is false', async () => {
    const refKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    await seedAttachment(db, projectId, 'ready', refKey, null);

    const storage = makeStorageStub();
    const lister = vi.fn<() => Promise<string[]>>().mockResolvedValue([refKey, orphanKey]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans(db, storage, lister, logger, 'test-bucket', false);

    // Same diff an --apply run would act on — the dry run is what the
    // operator reads before authorising the destructive pass.
    expect(result).toEqual({
      bucketObjectCount: 2,
      preservedCount: 1,
      orphanCount: 1,
      orphanKeys: [orphanKey],
    });
    // The whole point: a dry run is a pure read.
    expect(storage.hide).not.toHaveBeenCalled();
    // Warn (not info) — orphans exist — and the line must say so loudly
    // enough that nobody mistakes a dry run for a completed cleanup.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/DRY RUN/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('treats a clean bucket identically in dry-run and apply mode', async () => {
    const refKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    await seedAttachment(db, projectId, 'ready', refKey, null);

    const storage = makeStorageStub();
    const lister = vi.fn<() => Promise<string[]>>().mockResolvedValue([refKey]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans(db, storage, lister, logger, 'test-bucket', false);

    expect(result.orphanCount).toBe(0);
    expect(storage.hide).not.toHaveBeenCalled();
    // No orphans → the info line, with no DRY RUN theatre to add.
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
