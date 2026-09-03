/**
 * Integration test — pruneBucketOrphans (the scheduled sweep, the
 * `scripts/prune-bucket-orphans.ts` entrypoint, and the SEED=force
 * bucket reset all share this function).
 *
 * Pins the contract:
 *   - keys present in the bucket but NOT in `attachments.original_key` /
 *     `thumb_key` (across every status) are passed to `storage.hide()`
 *     when `apply` is true;
 *   - keys still referenced by an attachment row — including `hidden`
 *     rows whose original/thumb keys back the un-hide flow — are
 *     preserved;
 *   - `RESERVED_KEY_PREFIXES` (the deploy-preflight `__probe/`
 *     sentinels) are outside the diff entirely, in every count;
 *   - an unreferenced object younger than `minAgeMinutes`, or carrying
 *     no `lastModified`, is skipped — that window is where the invoice
 *     renderer and the takeout import runner hold a PUT object whose
 *     row has not committed yet;
 *   - `requireReferencedRows` refuses, before the first hide, when
 *     nothing in a non-empty bucket is referenced — the bucket/database
 *     mismatch fingerprint — and `SEED=force` can opt out;
 *   - `apply: false` reports the identical diff and hides nothing.
 *
 * The bucket lister is injected (`listBucketObjects`) so the test never
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
  type BucketObject,
  type PruneBucketOrphansLogger,
} from '../storage/pruneBucketOrphans.js';
import type { AttachmentStorageClient } from '../storage/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');

/** Fixed clock so age arithmetic in the assertions is exact. */
const NOW = new Date('2026-01-15T12:00:00.000Z');
const MIN_AGE_MINUTES = 60;
/** Comfortably past the cutoff. */
const OLD = new Date('2026-01-15T09:00:00.000Z');
/** Inside the grace window — a write that may not have committed yet. */
const RECENT = new Date('2026-01-15T11:59:00.000Z');

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

/** Lister stub — every object old enough to prune unless stated. */
function makeLister(objects: (BucketObject | string)[]) {
  const normalised = objects.map((o) =>
    typeof o === 'string' ? { key: o, lastModified: OLD } : o,
  );
  return vi.fn<() => Promise<BucketObject[]>>().mockResolvedValue(normalised);
}

describe('pruneBucketOrphans', () => {
  let db: Database;
  let pool: pg.Pool;
  let projectId: string;

  /** Defaults every case shares; each test overrides what it is about. */
  function baseOpts(storage: AttachmentStorageClient, logger: PruneBucketOrphansLogger) {
    return {
      db,
      storage,
      logger,
      bucketLabel: 'test-bucket',
      minAgeMinutes: MIN_AGE_MINUTES,
      requireReferencedRows: true,
      now: NOW,
    };
  }

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
    const orphanKey2 = `invoices/${projectId}/${crypto.randomUUID()}.orig`;

    await seedAttachment(db, projectId, 'ready', refOrigKey, refThumbKey);

    const storage = makeStorageStub();
    const lister = makeLister([refOrigKey, refThumbKey, orphanKey1, orphanKey2]);
    const logger = makeLogger();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: lister,
      apply: true,
    });

    expect(result).toEqual({
      bucketObjectCount: 4,
      preservedCount: 2,
      skippedRecentCount: 0,
      orphanCount: 2,
      orphanKeys: [orphanKey1, orphanKey2],
      applied: true,
    });

    const hide = storage.hide as ReturnType<typeof vi.fn>;
    const hidden = hide.mock.calls.map((c) => c[0] as string).sort();
    expect(hidden).toEqual([orphanKey1, orphanKey2].sort());

    // One warn summary, plus one info line per key hidden — a fault
    // mid-loop must still leave a record of what already went.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/2 orphan object\(s\)/);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls.map((c) => c[0]).join('\n')).toContain(orphanKey1);
  });

  it('leaves reserved __probe/ keys out of the diff and the counts', async () => {
    const refKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    await seedAttachment(db, projectId, 'ready', refKey, null);

    const storage = makeStorageStub();
    const logger = makeLogger();
    // The deploy preflight rewrites both of these on every deploy and
    // neither will ever have a row. Treating them as orphans would make
    // every sweep on a real deployment report a non-empty diff.
    const lister = makeLister([refKey, '__probe/upload', '__probe/copyobj']);

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: lister,
      apply: true,
    });

    expect(result.bucketObjectCount).toBe(1);
    expect(result.orphanCount).toBe(0);
    expect(result.preservedCount).toBe(1);
    expect(storage.hide).not.toHaveBeenCalled();
  });

  it('skips unreferenced objects younger than the min age', async () => {
    // The shape the invoice renderer holds between its PUT and the
    // commit of the issuance transaction: object present, row not yet
    // visible. Hiding it would 404 a freshly issued invoice PDF.
    const inFlightKey = `invoices/${projectId}/${crypto.randomUUID()}.orig`;
    const settledOrphan = `attachments/${projectId}/${crypto.randomUUID()}.orig`;

    const storage = makeStorageStub();
    const logger = makeLogger();
    const lister = makeLister([
      { key: inFlightKey, lastModified: RECENT },
      { key: settledOrphan, lastModified: OLD },
    ]);

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: lister,
      apply: true,
      requireReferencedRows: false,
    });

    expect(result.orphanKeys).toEqual([settledOrphan]);
    expect(result.skippedRecentCount).toBe(1);
    expect(storage.hide).toHaveBeenCalledTimes(1);
    expect(storage.hide).toHaveBeenCalledWith(settledOrphan);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/1 too recent to judge/);
  });

  it('skips an unreferenced object whose age the provider did not report', async () => {
    // No LastModified means no basis to claim the write has settled.
    const unknownAgeKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;

    const storage = makeStorageStub();
    const result = await pruneBucketOrphans({
      ...baseOpts(storage, makeLogger()),
      listBucketObjects: vi
        .fn<() => Promise<BucketObject[]>>()
        .mockResolvedValue([{ key: unknownAgeKey }]),
      apply: true,
      requireReferencedRows: false,
    });

    expect(result.orphanCount).toBe(0);
    expect(result.skippedRecentCount).toBe(1);
    expect(storage.hide).not.toHaveBeenCalled();
  });

  it('applies the min age only when it is set — SEED=force passes 0', async () => {
    const freshKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;

    const storage = makeStorageStub();
    const result = await pruneBucketOrphans({
      ...baseOpts(storage, makeLogger()),
      listBucketObjects: makeLister([{ key: freshKey, lastModified: RECENT }]),
      apply: true,
      minAgeMinutes: 0,
      requireReferencedRows: false,
    });

    expect(result.orphanKeys).toEqual([freshKey]);
    expect(storage.hide).toHaveBeenCalledWith(freshKey);
  });

  it('refuses to apply when nothing in a non-empty bucket is referenced', async () => {
    // What a checkout pointed at one deployment's bucket and another's
    // database looks like. Every object is "unreferenced" and the sweep
    // would delete-marker the whole bucket.
    const storage = makeStorageStub();
    const lister = makeLister([
      `attachments/${projectId}/${crypto.randomUUID()}.orig`,
      `invoices/${projectId}/${crypto.randomUUID()}.orig`,
    ]);

    await expect(
      pruneBucketOrphans({
        ...baseOpts(storage, makeLogger()),
        listBucketObjects: lister,
        apply: true,
      }),
    ).rejects.toThrow(/bucket\/database mismatch/);

    // Refusal lands before the first hide, not partway through.
    expect(storage.hide).not.toHaveBeenCalled();
  });

  it('does not refuse a report-only run against an unreferenced bucket', async () => {
    // Nothing is written, so there is nothing to protect against — and
    // the report is exactly how an operator diagnoses the mismatch.
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const storage = makeStorageStub();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, makeLogger()),
      listBucketObjects: makeLister([orphanKey]),
      apply: false,
    });

    expect(result.orphanKeys).toEqual([orphanKey]);
    expect(storage.hide).not.toHaveBeenCalled();
  });

  it('lets SEED=force apply against a bucket with no referenced rows', async () => {
    // The seed just truncated `attachments`; "nothing referenced" is the
    // expected state there, not a mismatch.
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const storage = makeStorageStub();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, makeLogger()),
      listBucketObjects: makeLister([orphanKey]),
      apply: true,
      minAgeMinutes: 0,
      requireReferencedRows: false,
    });

    expect(result.orphanCount).toBe(1);
    expect(storage.hide).toHaveBeenCalledWith(orphanKey);
  });

  it('preserves keys referenced by hidden rows (un-hide flow needs them)', async () => {
    const hiddenOrigKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;

    await seedAttachment(db, projectId, 'hidden', hiddenOrigKey, null);

    const storage = makeStorageStub();
    const result = await pruneBucketOrphans({
      ...baseOpts(storage, makeLogger()),
      listBucketObjects: makeLister([hiddenOrigKey, orphanKey]),
      apply: true,
    });

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
    const logger = makeLogger();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: makeLister([refKey]),
      apply: true,
    });

    expect(result).toEqual({
      bucketObjectCount: 1,
      preservedCount: 1,
      skippedRecentCount: 0,
      orphanCount: 0,
      orphanKeys: [],
      applied: false,
    });
    expect(storage.hide).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('handles an empty bucket as a no-op', async () => {
    const storage = makeStorageStub();
    const logger = makeLogger();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: makeLister([]),
      apply: true,
    });

    expect(result).toEqual({
      bucketObjectCount: 0,
      preservedCount: 0,
      skippedRecentCount: 0,
      orphanCount: 0,
      orphanKeys: [],
      applied: false,
    });
    expect(storage.hide).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('reports the identical diff without hiding anything when apply is false', async () => {
    const refKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    const orphanKey = `attachments/${projectId}/${crypto.randomUUID()}.orig`;
    await seedAttachment(db, projectId, 'ready', refKey, null);

    const storage = makeStorageStub();
    const logger = makeLogger();

    const result = await pruneBucketOrphans({
      ...baseOpts(storage, logger),
      listBucketObjects: makeLister([refKey, orphanKey]),
      apply: false,
    });

    // Same diff an apply run would act on — this is what the operator
    // reads before authorising the destructive pass.
    expect(result).toEqual({
      bucketObjectCount: 2,
      preservedCount: 1,
      skippedRecentCount: 0,
      orphanCount: 1,
      orphanKeys: [orphanKey],
      applied: false,
    });
    // The whole point: a report is a pure read.
    expect(storage.hide).not.toHaveBeenCalled();
    // Warn (not info) — orphans exist — and the line must say so loudly
    // enough that nobody mistakes a report for a completed cleanup.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/REPORT ONLY/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('rejects a negative min age rather than treating it as disabled', async () => {
    const storage = makeStorageStub();
    await expect(
      pruneBucketOrphans({
        ...baseOpts(storage, makeLogger()),
        listBucketObjects: makeLister([]),
        apply: false,
        minAgeMinutes: -1,
      }),
    ).rejects.toThrow(/minAgeMinutes/);
  });
});
