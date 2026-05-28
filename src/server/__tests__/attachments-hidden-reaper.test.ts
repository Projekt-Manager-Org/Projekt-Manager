/**
 * API integration tests — attachment hidden reaper (AC-246).
 *
 * Pins the reaper contract from data-model.md §6.12:
 *
 *   - Rows at `status='hidden'` with `now() - hiddenAt > ttlMinutes`
 *     are hard-DELETEd. Rows at `status='ready'` or `'pending'` of any
 *     age are untouched — the hidden reaper's lane is `'hidden'` only.
 *   - Each removed row produces exactly one `audit_log` entry written
 *     through `mutate()` (single-write-path, AC-177): `actorKind='system'`,
 *     `action='attachment:purge'`, `actorReason='hidden-reaper'`,
 *     `entityType='attachment'`, `payload.before` carries the pre-purge
 *     row state per §5.10's payload-shape rules, `payload.after = {}`
 *     per the delete/purge convention.
 *   - Each run emits exactly one structured info log line with
 *     `event = 'attachment-hidden-reaper'`, `ttl_minutes`,
 *     `removed_count` (non-negative; 0 on no-op), `ran_at` (ISO 8601).
 *   - No object-storage delete is issued — bytes are the bucket
 *     lifecycle's concern. The reaper is DB-only.
 *   - A per-row `mutate()` failure is logged with `error_hint` and the
 *     sweep continues; partial progress is acceptable.
 *
 * Test-module contract: the reaper is invoked directly (no scheduler
 * plumbing). The import path `../services/attachment-hidden-reaper.js`
 * and the `runAttachmentHiddenReaper({...})` signature follow the
 * parallel conventions from the orphan reaper. The skeleton lacks this
 * module today — the per-test red state is a missing-module failure
 * inside each `it`, NOT a file-level import crash (mirror lines 50-84
 * of `attachments-reaper.test.ts`).
 *
 * Raw-SQL attachment-row seeding is permitted under `__tests__/` per
 * the AC-179 architecture-check allowlist. We need raw SQL to backdate
 * `hidden_at` — the service surface won't let us.
 *
 * NOTE for the implementer: `'attachment:purge'` is not yet a member of
 * `AUDIT_ACTION_KEYS` in `src/config/auditActionLabels.ts`. The
 * `MutateSpec.action` type is closed over that array, so calling
 * `mutate({ action: 'attachment:purge', ... })` will fail at compile
 * time until the key (and a German activity-feed label) is added.
 * This test reads `audit_log.action` via raw SQL so it does not catch
 * the gap; the impl PR must extend `AUDIT_ACTION_KEYS` alongside the
 * reaper service.
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
import { validateEnvRuntime } from '../config/env.js';
import type { ServiceLogger } from '../services/Logger.js';

/**
 * Contract surface — resolved lazily via dynamic import so the test
 * file loads even before the reaper module exists. Each test awaits
 * this resolver; missing-module errors surface as per-test failures
 * (rather than a file-level import crash that vitest reports as
 * "no tests"), matching the project's "every test runs; red-state is
 * per-test" convention. Mirror of attachments-reaper.test.ts L50-84.
 *
 * Expected module shape (from the reaper-spec round of issue #156):
 *
 *   interface RunAttachmentHiddenReaperDeps {
 *     db: Database;
 *     logger: ServiceLogger;
 *     ttlMinutes: number;
 *     now?: Date; // injectable wall clock for deterministic testing
 *   }
 *   const EVENT_ATTACHMENT_HIDDEN_REAPER = 'attachment-hidden-reaper';
 *   async function runAttachmentHiddenReaper(deps): Promise<void>;
 *
 * No `storage` dependency — the reaper is DB-only (data-model.md §6.12).
 */
interface RunAttachmentHiddenReaperDeps {
  db: Database;
  logger: ServiceLogger;
  ttlMinutes: number;
  now?: Date;
}

async function runAttachmentHiddenReaper(deps: RunAttachmentHiddenReaperDeps): Promise<void> {
  const mod = (await import('../services/attachment-hidden-reaper.js')) as {
    runAttachmentHiddenReaper: (deps: RunAttachmentHiddenReaperDeps) => Promise<void>;
  };
  return mod.runAttachmentHiddenReaper(deps);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../db/migrations');
const MINUTE_MS = 60 * 1000;

interface SeededHiddenRow {
  id: string;
  projectId: string;
  label: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Insert a hidden attachment row with an explicit `hiddenAt`. Raw SQL
 * (no service route) — we need precise control of `hidden_at` to
 * backdate past the TTL, and the service surface won't let us.
 */
async function seedHiddenAt(
  db: Database,
  projectId: string,
  hiddenAt: Date,
): Promise<SeededHiddenRow> {
  const id = crypto.randomUUID();
  const filename = `seed-hidden-${id.slice(0, 6)}.pdf`;
  const label = 'sonstiges';
  const mimeType = 'application/pdf';
  const sizeBytes = 2048;
  const originalKey = `attachments/${projectId}/${id}.orig`;
  // Synthetic envelope (ADR-0024 / #155). The reaper does not unwrap;
  // any well-formed base64 satisfies the schema-level NOT NULL on
  // wrapped_dek_version and the CHECK that ties wrapped_dek to ready/
  // hidden rows. Mirrors the pattern in attachments-permissions.test.ts.
  const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail, version_id, hidden_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'hidden', 'binary', ${label},
            ${filename}, ${mimeType}, ${sizeBytes},
            ${sizeBytes + 16},
            ${originalKey}, NULL,
            FALSE, ${'v-' + id.slice(0, 8)}, ${hiddenAt.toISOString()},
            ${wrappedDek}, NULL, 1)
  `);
  return { id, projectId, label, filename, mimeType, sizeBytes };
}

async function seedReadyAt(db: Database, projectId: string, createdAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  const wrappedDek = Buffer.alloc(192, 0x77).toString('base64');
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       ciphertext_size_bytes,
       original_key, thumb_key, has_thumbnail, created_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'ready', 'binary', 'sonstiges',
            ${'ready-' + id.slice(0, 6)}, 'application/pdf', 1024,
            1040,
            ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
            ${createdAt.toISOString()},
            ${wrappedDek}, NULL, 1)
  `);
  return id;
}

async function seedPendingAt(db: Database, projectId: string, createdAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO attachments
      (id, project_id, status, kind, label, filename, mime_type, size_bytes,
       original_key, thumb_key, has_thumbnail, created_at,
       wrapped_dek, wrapped_thumb_dek, wrapped_dek_version)
    VALUES (${id}, ${projectId}, 'pending', 'binary', 'sonstiges',
            ${'pending-' + id.slice(0, 6)}, 'application/pdf', 1024,
            ${`attachments/${projectId}/${id}.orig`}, NULL, FALSE,
            ${createdAt.toISOString()},
            NULL, NULL, 1)
  `);
  return id;
}

async function rowExists(db: Database, id: string): Promise<boolean> {
  const res = await db.execute(sql`SELECT 1 AS x FROM attachments WHERE id = ${id} LIMIT 1`);
  return res.rows.length > 0;
}

async function fetchStatus(db: Database, id: string): Promise<string | null> {
  const res = await db.execute(sql`SELECT status FROM attachments WHERE id = ${id} LIMIT 1`);
  return (res.rows[0] as { status: string } | undefined)?.status ?? null;
}

async function countAuditRows(db: Database): Promise<number> {
  const res = await db.execute(sql`SELECT COUNT(*)::int AS c FROM audit_log`);
  return (res.rows[0] as { c: number }).c;
}

async function fetchPurgeAuditRow(
  db: Database,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const res = await db.execute(sql`
    SELECT id, entity_type, entity_id, entity_label, action, actor_id, actor_kind,
           actor_reason, ancestor_entity_type, ancestor_entity_id, ancestor_entity_label,
           payload, correlation_id
    FROM audit_log
    WHERE entity_id = ${entityId} AND action = 'attachment:purge'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return (res.rows[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Resolve a project row's `<number> <title>` so a test can assert the
 * `ancestor_entity_label` snapshot equals the canonical
 * `projectAuditLabel(...)` output without re-importing the domain helper.
 */
async function projectAuditLabelById(db: Database, projectId: string): Promise<string> {
  const res = await db.execute(sql`
    SELECT number, title FROM projects WHERE id = ${projectId} LIMIT 1
  `);
  const row = res.rows[0] as { number: string; title: string } | undefined;
  if (!row) throw new Error(`projectAuditLabelById: project ${projectId} not found`);
  return `${row.number} ${row.title}`;
}

describe('Attachment hidden reaper (AC-246)', () => {
  let db: Database;
  let pool: pg.Pool;
  let seededProjectId: string;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    await seed(db, { force: true });

    // Pick any seeded project — the reaper sweeps globally; project id
    // is incidental to the assertion, just needed as a FK target.
    const r = await db.execute(sql`SELECT id FROM projects LIMIT 1`);
    seededProjectId = (r.rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean both tables: each test seeds attachments and asserts the
    // resulting audit_log delta deterministically. Audit rows produced
    // by `seed()` would otherwise pollute counts. Order respects the
    // FK direction: audit_log has no FK on attachments (entity_id is
    // an unconstrained UUID per §5.10), so order is incidental.
    await db.execute(sql`DELETE FROM audit_log`);
    await db.execute(sql`DELETE FROM attachments`);
  });

  // -------------------------------------------------------------------
  // (1) Hidden rows past TTL are hard-deleted; fresh hidden row stays.
  // -------------------------------------------------------------------
  it('hard-deletes hidden rows whose age past hiddenAt exceeds the TTL', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880; // 2 days

    const expired = await seedHiddenAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 3 * 24 * 60 * MINUTE_MS), // 3 days ago
    );
    const fresh = await seedHiddenAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 60 * MINUTE_MS), // 1 hour ago
    );

    await runAttachmentHiddenReaper({
      db,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(await rowExists(db, expired.id)).toBe(false);
    expect(await rowExists(db, fresh.id)).toBe(true);
  });

  // -------------------------------------------------------------------
  // (2) `ready` rows of any age are untouched — wrong lane.
  // -------------------------------------------------------------------
  it('leaves status=ready rows untouched regardless of age', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;

    // A ready row backdated well past the TTL must NOT be touched —
    // the hidden reaper scopes on `status='hidden'` only.
    const ancientReadyId = await seedReadyAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 30 * 24 * 60 * MINUTE_MS),
    );
    const freshReadyId = await seedReadyAt(db, seededProjectId, now);

    await runAttachmentHiddenReaper({
      db,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(await fetchStatus(db, ancientReadyId)).toBe('ready');
    expect(await fetchStatus(db, freshReadyId)).toBe('ready');
  });

  // -------------------------------------------------------------------
  // (3) `pending` rows of any age are untouched — orphan reaper's lane.
  // -------------------------------------------------------------------
  it('leaves status=pending rows untouched regardless of age', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;

    // Pending rows are the orphan reaper's territory (§6.11). The
    // hidden reaper must not poach them even when they exceed its TTL.
    const ancientPendingId = await seedPendingAt(
      db,
      seededProjectId,
      new Date(now.getTime() - 30 * 24 * 60 * MINUTE_MS),
    );
    const freshPendingId = await seedPendingAt(db, seededProjectId, now);

    await runAttachmentHiddenReaper({
      db,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    expect(await fetchStatus(db, ancientPendingId)).toBe('pending');
    expect(await fetchStatus(db, freshPendingId)).toBe('pending');
  });

  // -------------------------------------------------------------------
  // (4) Audit-row shape — exactly one row per purge with the pinned
  // shape from data-model.md §6.12 + §5.10.
  // -------------------------------------------------------------------
  it('writes exactly one attachment:purge audit row per purged row with the pinned shape', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;
    const expiredAt = new Date(now.getTime() - 3 * 24 * 60 * MINUTE_MS);

    const r1 = await seedHiddenAt(db, seededProjectId, expiredAt);
    const r2 = await seedHiddenAt(db, seededProjectId, expiredAt);
    const r3 = await seedHiddenAt(db, seededProjectId, expiredAt);

    const auditBefore = await countAuditRows(db);

    await runAttachmentHiddenReaper({
      db,
      logger: { info: vi.fn(), error: vi.fn() },
      ttlMinutes,
      now,
    });

    const auditAfter = await countAuditRows(db);
    expect(auditAfter - auditBefore).toBe(3);

    for (const seeded of [r1, r2, r3]) {
      const row = await fetchPurgeAuditRow(db, seeded.id);
      expect(row).not.toBeNull();
      expect(row!.entity_type).toBe('attachment');
      expect(row!.entity_id).toBe(seeded.id);
      expect(row!.action).toBe('attachment:purge');
      expect(row!.actor_kind).toBe('system');
      expect(row!.actor_id).toBeNull();
      expect(row!.actor_reason).toBe('hidden-reaper');
      // Ancestor link (architecture.md §11.12) — attachment rows carry
      // (project, projectId) so the per-project activity feed picks them
      // up alongside project + project_worker rows in one indexed query.
      expect(row!.ancestor_entity_type).toBe('project');
      expect(row!.ancestor_entity_id).toBe(seeded.projectId);
      // AC-339 / AC-342: the reaper also snapshots the owning project's
      // canonical `<number> <title>` label so the dock + audit table can
      // render the Projekt slot without a runtime JOIN even for
      // system-actor `attachment:purge` rows.
      const expectedLabel = await projectAuditLabelById(db, seeded.projectId);
      expect(row!.ancestor_entity_label).toBe(expectedLabel);
      // The reaper is unattended — no request id to thread.
      expect(row!.correlation_id).toBeNull();
      // entityLabel may be null or the filename — both acceptable per
      // §5.10. Pin the type, leave the value flexible.
      const entityLabel = row!.entity_label;
      expect(entityLabel === null || typeof entityLabel === 'string').toBe(true);

      const payload = row!.payload as { before?: Record<string, unknown>; after?: unknown };
      // payload.after is the empty-object literal per the delete/purge
      // convention in §5.10.
      expect(payload.after).toEqual({});
      // payload.before carries the pre-purge row state. We pin the
      // presence of key columns rather than the exact field set —
      // §5.10 governs the precise shape ("changed fields only" with
      // server-managed timestamps deliberately loose).
      expect(payload.before).toBeDefined();
      const before = payload.before as Record<string, unknown>;
      expect(before.projectId).toBe(seeded.projectId);
      expect(before.label).toBe(seeded.label);
      expect(before.mimeType).toBe(seeded.mimeType);
      expect(before.sizeBytes).toBe(seeded.sizeBytes);
    }
  });

  // -------------------------------------------------------------------
  // (5) No-op run — no eligible rows, zero rows deleted, zero audit
  // rows added, exactly one info line with removed_count=0.
  // -------------------------------------------------------------------
  it('emits removed_count=0 and writes no audit row on a no-op run', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;

    // Only ready + pending rows. Nothing eligible to reap.
    await seedReadyAt(db, seededProjectId, now);
    await seedPendingAt(db, seededProjectId, new Date(now.getTime() - MINUTE_MS));

    const auditBefore = await countAuditRows(db);
    const info = vi.fn();
    const error = vi.fn();

    await runAttachmentHiddenReaper({
      db,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    const [context] = info.mock.calls[0]!;
    expect((context as { removed_count: number }).removed_count).toBe(0);
    expect(await countAuditRows(db)).toBe(auditBefore);
  });

  // -------------------------------------------------------------------
  // (6) Operational-log shape — exactly one info line per run with the
  // full field set: event, ttl_minutes, removed_count, ran_at.
  // -------------------------------------------------------------------
  it('emits exactly one info line with event, ttl_minutes, removed_count, ran_at', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;

    await seedHiddenAt(db, seededProjectId, new Date(now.getTime() - 3 * 24 * 60 * MINUTE_MS));

    const info = vi.fn();
    const error = vi.fn();
    await runAttachmentHiddenReaper({
      db,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();

    const [context, eventName] = info.mock.calls[0]!;
    expect(eventName).toBe('attachment-hidden-reaper');
    const ctx = context as Record<string, unknown>;
    expect(ctx.event).toBe('attachment-hidden-reaper');
    expect(ctx.ttl_minutes).toBe(ttlMinutes);
    expect(ctx.removed_count).toBe(1);
    // ISO 8601 round-trip — catches `toLocaleString` typos without
    // pinning a specific substring.
    expect(typeof ctx.ran_at).toBe('string');
    expect(Number.isNaN(Date.parse(ctx.ran_at as string))).toBe(false);
    // `ran_at` round-trips to the injected wall clock.
    expect(Date.parse(ctx.ran_at as string)).toBe(now.getTime());
  });

  // -------------------------------------------------------------------
  // (7) Per-row mutate() failure does not abort the sweep. The other
  // expired rows are still purged with audit rows; the failing row
  // remains; one error-channel log line carries `error_hint` and the
  // failing row's id; the run still emits its info log line.
  //
  // We force a mid-loop failure by wrapping deps.db with a Proxy that
  // throws inside the second `transaction()` call. Pure delegation —
  // the impl is not modified; the surface (db.transaction) is the
  // single thing `mutate()` touches.
  // -------------------------------------------------------------------
  it('continues sweeping when one row mutate() throws; logs error_hint and finishes', async () => {
    const now = new Date('2026-05-03T12:00:00.000Z');
    const ttlMinutes = 2880;
    const expiredAt = new Date(now.getTime() - 3 * 24 * 60 * MINUTE_MS);

    const r1 = await seedHiddenAt(db, seededProjectId, expiredAt);
    const r2 = await seedHiddenAt(db, seededProjectId, expiredAt);
    const r3 = await seedHiddenAt(db, seededProjectId, expiredAt);

    // Per-row mutate() failure — wrap db.transaction so the second
    // call throws. The first and third row purge through the real
    // path; the second row's transaction rolls back before any state
    // (DB delete or audit row) lands. `mutate()` is the single-write
    // path, so a transaction-level throw is the canonical "row failed"
    // signal — equivalent to a transient deadlock or a serialization
    // failure surfaced from Postgres.
    let txCallCount = 0;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: unknown[]) => {
            txCallCount += 1;
            if (txCallCount === 2) {
              return Promise.reject(new Error('simulated-mutate-flake'));
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any).transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;

    const info = vi.fn();
    const error = vi.fn();

    await runAttachmentHiddenReaper({
      db: flakyDb,
      logger: { info, error },
      ttlMinutes,
      now,
    });

    // Identify which row was the second-transaction victim. The reaper
    // iterates rows in some order; we pin the survivor by checking
    // existence after the run rather than assuming the order.
    const survivors = await Promise.all([
      rowExists(db, r1.id),
      rowExists(db, r2.id),
      rowExists(db, r3.id),
    ]);
    const surviving = [r1, r2, r3].filter((_, i) => survivors[i]);
    const purged = [r1, r2, r3].filter((_, i) => !survivors[i]);

    expect(surviving).toHaveLength(1);
    expect(purged).toHaveLength(2);

    // Audit rows for the two successful purges, none for the survivor.
    for (const p of purged) {
      const row = await fetchPurgeAuditRow(db, p.id);
      expect(row).not.toBeNull();
    }
    expect(await fetchPurgeAuditRow(db, surviving[0]!.id)).toBeNull();

    // One error line with `error_hint` populated. The spec pins
    // `error_hint` (data-model.md §6.12) but does not pin the field
    // name carrying the row id; we assert the survivor's id appears
    // somewhere in the serialized context so a reasonable field name
    // (`attachment_id`, `id`, `entity_id`, ...) all pass while a
    // missing-id log line fails.
    expect(error).toHaveBeenCalledTimes(1);
    const [errorCtx, errorEvent] = error.mock.calls[0]!;
    expect(errorEvent).toBe('attachment-hidden-reaper');
    const eCtx = errorCtx as Record<string, unknown>;
    expect(eCtx.event).toBe('attachment-hidden-reaper');
    expect(typeof eCtx.error_hint).toBe('string');
    expect(eCtx.error_hint).toContain('simulated-mutate-flake');
    expect(JSON.stringify(eCtx)).toContain(surviving[0]!.id);

    // Info line still emitted once. removed_count is the success count
    // (mirrors §6.11's orphan reaper convention — the field
    // pins observed deletions, not attempted ones).
    expect(info).toHaveBeenCalledTimes(1);
    const [infoCtx] = info.mock.calls[0]!;
    expect((infoCtx as { removed_count: number }).removed_count).toBe(2);
  });

  // -------------------------------------------------------------------
  // (9) Graceful shutdown drain and single-flight sweep are scheduler-
  // level invariants — they live in
  // `attachment-hidden-reaper-scheduler.test.ts`, not here. The reaper
  // service has no notion of timer ticks or overlapping calls; both
  // properties are enforced by the shared `createPeriodicSweeper`
  // factory (see `periodicSweeper.ts`).
  // -------------------------------------------------------------------

  // -------------------------------------------------------------------
  // (10) TTL guard — defensive throw on non-positive-integer ttlMinutes
  // (mirror attachment-orphan-reaper.ts L44-48). Non-integer values
  // would compute a non-integer `MS_PER_MINUTE * ttlMinutes` cutoff —
  // legal arithmetic but a programmer-error signal in the config wire-up.
  // -------------------------------------------------------------------
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1.5],
  ])('throws when ttlMinutes is %s', async (_label, ttl) => {
    // Pin the message substring so a missing-module ESM error in
    // pre-impl red state does not satisfy the assertion (would be
    // T-TAUT). The message must reference `ttlMinutes` — mirrors the
    // orphan reaper's defensive throw at L44-48 of
    // attachment-orphan-reaper.ts.
    await expect(
      runAttachmentHiddenReaper({
        db,
        logger: { info: vi.fn(), error: vi.fn() },
        ttlMinutes: ttl,
        now: new Date('2026-05-03T12:00:00.000Z'),
      }),
    ).rejects.toThrow(/ttlMinutes/);
  });
});
