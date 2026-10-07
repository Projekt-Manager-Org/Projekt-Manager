/**
 * API integration tests — attachment orphan reaper (AC-213).
 *
 * Pins the reaper contract from data-model.md §6.11:
 *
 *   - Pending rows older than the configured TTL are removed.
 *   - For each removed row, both `originalKey` and `thumbKey` (when
 *     present) are deleted from object storage.
 *   - Ready rows are untouched, regardless of age — the reaper only
 *     sweeps the orphan class.
 *   - Each run emits exactly one structured info log line with
 *     `event = 'attachment-orphan-reaper'`, `ttl_minutes`,
 *     `removed_count` (non-negative; 0 on no-op), `ran_at` (ISO 8601).
 *   - No `audit_log` row is produced — orphans never entered the
 *     domain, so their removal is housekeeping, not a domain event
 *     (AC-179 allowlist clause).
 *   - A storage delete that fails (object already gone, transient
 *     provider error) is logged with `error_hint` and the row is still
 *     removed — the metadata-table cleanliness goal trumps a missing
 *     object (§6.11).
 *
 * Test-module contract: the reaper is invoked directly (no scheduler
 * plumbing). The import path `../services/attachment-orphan-reaper.js`
 * and the `runAttachmentOrphanReaper({...})` signature follow the
 * parallel conventions from the session reaper + audit-retention
 * service. The skeleton lacks this module today — the test fails at
 * import, which is the red state we expect until step 5 lands the
 * implementation (parallel to `backup.test.ts`'s contract-surface
 * import).
 *
 * Raw-SQL attachment-row seeding is permitted under `__tests__/` per
 * the AC-179 architecture-check allowlist.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import crypto from 'node:crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import type pg from 'pg';

import { createDatabase } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { seed } from '../seed.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import type { StorageClient } from '../storage/client.js';
import { getEnv, validateEnvRuntime } from '../config/env.js';

/**
 * Contract surface — resolved lazily via dynamic import so the test
 * file loads even before the reaper module exists. Each test awaits
 * this resolver; missing-module errors surface as per-test failures
 * (rather than a file-level import crash that vitest reports as
 * "no tests"), matching the project's "every test runs; red-state is
 * per-test" convention.
 *
 * The expected module shape:
 *
 *   interface ReaperOptions {
 *     db: Database;
 *     storage: StorageClient;
 *     logger: { info: LogFn; error: LogFn };
 *     ttlMinutes: number;
 *     now?: Date; // injectable for deterministic testing
 *   }
 *   async function runAttachmentOrphanReaper(opts: ReaperOptions): Promise<void>;
 */
type ReaperLogFn = (ctx: Record<string, unknown>, event: string) => void;

interface ReaperOptions {
  db: Database;
  storage: StorageClient;
  logger: { info: ReaperLogFn; error: ReaperLogFn };
  ttlMinutes: number;
  now?: Date;
}

async function runAttachmentOrphanReaper(opts: ReaperOptions): Promise<void> {
  const mod = (await import('../services/attachment-orphan-reaper.js')) as {
    runAttachmentOrphanReaper: (opts: ReaperOptions) => Promise<void>;
  };
  return mod.runAttachmentOrphanReaper(opts);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');
const MINUTE_MS = 60 * 1000;

/**
 * Insert a pending attachment row with an explicit `createdAt`. Returns
 * the row id + the pair of storage keys the reaper is expected to
 * delete. Raw SQL (no service route) — we need precise control of
 * `created_at` to backdate past the TTL.
 */
async function seedPendingAt(
  db: Database,
  projectId: string,
  createdAt: Date,
  withThumb: boolean,
): Promise<{ id: string; originalKey: string; thumbKey: string | null }> {
  const id = crypto.randomUUID();
  const originalKey = `attachments/${projectId}/${id}.orig`;
  const thumbKey = withThumb ? `attachments/${projectId}/${id}.thumb` : null;
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       original_key, thumb_key, has_thumbnail, wrapped_dek_version, created_at)
    VALUES (${id}, ${projectId}, 'pending',
            ${withThumb ? 'photo' : 'binary'},
            ${withThumb ? 'foto' : 'sonstiges'},
            ${'seed-' + id.slice(0, 6)},
            ${withThumb ? 'image/jpeg' : 'application/pdf'},
            1024, ${originalKey}, ${thumbKey}, ${withThumb}, 1,
            ${createdAt.toISOString()})
  `);
  return { id, originalKey, thumbKey };
}

async function seedReadyAt(db: Database, projectId: string, createdAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  // ADR-0024: ready rows must carry a wrapped DEK + ciphertext size.
  // This reaper test only checks that ready rows are NOT swept, so a
  // synthetic envelope satisfies the CHECK without exercising unwrap.
  const wrappedDek = Buffer.alloc(192, 0x33).toString('base64');
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version, created_at)
    VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
            ${'ready-' + id.slice(0, 6)}, 'application/pdf', 1024,
            1088,
            ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
            ${wrappedDek}, NULL, 1,
            ${createdAt.toISOString()})
  `);
  return id;
}

async function fetchStatus(db: Database, id: string): Promise<string | null> {
  const res = await db.execute(sql`SELECT status FROM attachments WHERE id = ${id} LIMIT 1`);
  return (res.rows[0] as { status: string } | undefined)?.status ?? null;
}

async function countAuditRows(db: Database): Promise<number> {
  const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

/** Direct-storage seed so the "storage object existed and was deleted" arm has a real target. */
async function seedStorageObject(storage: StorageClient, key: string): Promise<void> {
  await storage.upload(key, Buffer.from('pending-orphan-bytes'), 'application/octet-stream');
}

/** True when the backing object is absent — the download call surfaces a provider error. */
async function objectAbsent(storage: StorageClient, key: string): Promise<boolean> {
  try {
    await storage.download(key);
    return false;
  } catch {
    return true;
  }
}

describe('Attachment orphan reaper (AC-213)', () => {
  let db: Database;
  let pool: pg.Pool;
  let storage: StorageClient;
  let seededProjectId: string;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    const env = getEnv();
    storage = createStorageClientFromEnv(env);

    // Pick any seeded project — the reaper sweeps globally; project id
    // is incidental to the assertion, just needed as a FK target.
    const r = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    seededProjectId = (r.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clear attachment rows between tests so each seeds a deterministic
    // set. Preserves projects / users (FK targets).
    await db.execute(sql`DELETE FROM attachments`);
  });

  // -------------------------------------------------------------------
  // TTL-expiry sweep: pending rows past TTL are removed with their
  // backing objects; ready rows + fresh pending rows are retained.
  // -------------------------------------------------------------------
  it('removes pending rows older than the TTL and deletes their backing objects', async () => {
    const now = new Date();
    const ttlMinutes = 15;

    // Two expired pending rows, one with a thumb (photo), one without.
    const expiredWithThumb = await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 5) * MINUTE_MS),
      true,
    );
    const expiredNoThumb = await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 60) * MINUTE_MS),
      false,
    );
    // One fresh pending row — still inside the TTL window.
    const fresh = await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 1 * MINUTE_MS),
      false,
    );
    // One ready row backdated well past the TTL — must NOT be touched.
    const readyId = await seedReadyAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 30 * 24 * 60 * MINUTE_MS),
    );

    // Seed backing objects for the expired rows so we can observe the
    // storage-delete side effect after the reap.
    await seedStorageObject(storage, expiredWithThumb.originalKey);
    await seedStorageObject(storage, expiredWithThumb.thumbKey!);
    await seedStorageObject(storage, expiredNoThumb.originalKey);

    await runAttachmentOrphanReaper({
      db,
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    // Expired rows gone — both original + thumb objects removed.
    expect(await fetchStatus(db, expiredWithThumb.id)).toBeNull();
    expect(await objectAbsent(storage, expiredWithThumb.originalKey)).toBe(true);
    expect(await objectAbsent(storage, expiredWithThumb.thumbKey!)).toBe(true);

    expect(await fetchStatus(db, expiredNoThumb.id)).toBeNull();
    expect(await objectAbsent(storage, expiredNoThumb.originalKey)).toBe(true);

    // Fresh pending row survived — age-scoped sweep, not a blanket wipe.
    expect(await fetchStatus(db, fresh.id)).toBe('pending');

    // Ready row untouched regardless of age — the reaper scopes on
    // status = 'pending'.
    expect(await fetchStatus(db, readyId)).toBe('ready');
  });

  // -------------------------------------------------------------------
  // Operational-log contract — data-model.md §6.11.
  // -------------------------------------------------------------------
  it('emits exactly one info line with event, ttl_minutes, removed_count, ran_at', async () => {
    const now = new Date();
    const ttlMinutes = 15;

    await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 10) * MINUTE_MS),
      false,
    );

    const info = vi.fn();
    const error = vi.fn();
    await runAttachmentOrphanReaper({
      db,
      storage,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    const [context, eventName] = info.mock.calls[0]!;
    expect(eventName).toBe('attachment-orphan-reaper');
    const ctx = context as Record<string, unknown>;
    expect(ctx.event).toBe('attachment-orphan-reaper');
    expect(ctx.ttl_minutes).toBe(ttlMinutes);
    expect(ctx.removed_count).toBe(1);
    // ISO 8601 round-trip — catches `toLocaleString` typos without
    // pinning a specific substring.
    expect(typeof ctx.ran_at).toBe('string');
    expect(Number.isNaN(Date.parse(ctx.ran_at as string))).toBe(false);
  });

  // -------------------------------------------------------------------
  // No-op run — no expired rows; still exactly one log line, count=0.
  // -------------------------------------------------------------------
  it('emits removed_count=0 on a no-op run (no expired rows)', async () => {
    const now = new Date();
    const ttlMinutes = 15;

    // Only fresh rows + a ready row. Nothing eligible to reap.
    await seedPendingAt(db, seededProjectId, new Date(now.getTime() - 1 * MINUTE_MS), false);
    await seedReadyAt(db, seededProjectId, now);

    const info = vi.fn();
    await runAttachmentOrphanReaper({
      db,
      storage,
      logger: { info, error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const [context] = info.mock.calls[0]!;
    expect((context as { removed_count: number }).removed_count).toBe(0);
  });

  // -------------------------------------------------------------------
  // Audit invariant — reaper does NOT write an audit_log row.
  // AC-179 allowlists the reaper; data-model.md §6.11 documents why.
  // -------------------------------------------------------------------
  it('does not produce an audit_log row for reaped rows', async () => {
    const now = new Date();
    const ttlMinutes = 15;

    await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 30) * MINUTE_MS),
      true,
    );
    await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 30) * MINUTE_MS),
      false,
    );

    const auditBefore = await countAuditRows(db);

    await runAttachmentOrphanReaper({
      db,
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    const auditAfter = await countAuditRows(db);
    expect(auditAfter).toBe(auditBefore);
  });

  // -------------------------------------------------------------------
  // Idempotent storage-delete — the row removal completes even when
  // there is no backing object for storage.delete to remove. Per §6.11:
  // "an object delete that finds nothing is a no-op, not a failure";
  // the metadata-table cleanliness goal trumps a missing backing object.
  // -------------------------------------------------------------------
  it('still removes the row when the backing object is already absent (idempotent storage-delete)', async () => {
    const now = new Date();
    const ttlMinutes = 15;

    // Seed the row, but DO NOT upload the backing object — the reaper's
    // storage.delete will address a missing key. S3 DeleteObject is
    // idempotent on a missing key (no-op, no throw); the reaper must
    // therefore complete the row removal in this shape per §6.11.
    const expired = await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - (ttlMinutes + 5) * MINUTE_MS),
      false,
    );

    await runAttachmentOrphanReaper({
      db,
      storage,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(await fetchStatus(db, expired.id)).toBeNull();
  });
});
