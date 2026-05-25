/**
 * DataExchangeJobService — lifecycle + SSE emission (ADR-0018 § Two
 * surfaces, ADR-0024 § Full-account takeout).
 *
 * Integration: real Postgres (per-fork test DB created by
 * `integration-setup`, migrated here), real SSE bus with a subscribed
 * fake connection counting `data_exchange_job_changed` frames — the same
 * harness `project-changed-events.test.ts` uses to pin post-commit
 * emission against the catalog constant.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createDatabase, type Database } from '../db/connection.js';
import { validateEnvRuntime } from '../config/env.js';
import { DataExchangeJobService } from '../services/DataExchangeJobService.js';
import { DATA_EXCHANGE_JOB_CHANGED } from '../../config/sseEvents.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);

// --- SSE bus fake (mirror project-changed-events.test.ts) ------------
interface SseConnection {
  write(chunk: string): void;
}
interface SseBusModule {
  subscribe(c: SseConnection): void;
  unsubscribe(c: SseConnection): void;
}
interface SubscribedFake extends SseConnection {
  chunks: string[];
}

async function loadBus(): Promise<SseBusModule> {
  const p = '../sse/bus.js';
  return (await import(/* @vite-ignore */ p)) as unknown as SseBusModule;
}

function subscribeFake(bus: SseBusModule): SubscribedFake {
  const conn: SubscribedFake = {
    chunks: [],
    write(chunk: string): void {
      this.chunks.push(chunk);
    },
  };
  bus.subscribe(conn);
  return conn;
}

// Anchor on `event: <name>\n` so a sibling event name cannot collide.
function countJobChanged(conn: SubscribedFake): number {
  const matches = conn.chunks
    .join('')
    .match(new RegExp(`event: ${DATA_EXCHANGE_JOB_CHANGED}\\n`, 'g'));
  return matches ? matches.length : 0;
}

describe('DataExchangeJobService', () => {
  let db: Database;
  let pool: pg.Pool;
  let svc: DataExchangeJobService;
  let bus: SseBusModule;

  beforeAll(async () => {
    validateEnvRuntime();
    const conn = createDatabase();
    db = conn.db;
    pool = conn.pool;
    await pool.query('SELECT 1');
    await migrate(db, { migrationsFolder });
    svc = new DataExchangeJobService(db);
    bus = await loadBus();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM data_exchange_job`);
  });

  it('create() inserts a pending job with zeroed counters and emits once', async () => {
    const conn = subscribeFake(bus);
    try {
      const job = await svc.create('export', null);
      expect(job.kind).toBe('export');
      expect(job.status).toBe('pending');
      expect(job.filesTotal).toBe(0);
      expect(job.filesDone).toBe(0);
      expect(job.bytesDone).toBe(0);
      expect(job.startedAt).toBeNull();
      expect(job.finishedAt).toBeNull();
      expect(countJobChanged(conn)).toBe(1);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('drives the export lifecycle: pending → running → progress → ready', async () => {
    const job = await svc.create('export', null);

    const running = await svc.markRunning(job.id, { filesTotal: 3, bytesTotal: 300 });
    expect(running.status).toBe('running');
    expect(running.filesTotal).toBe(3);
    expect(running.bytesTotal).toBe(300);
    expect(running.startedAt).not.toBeNull();

    const progressed = await svc.updateProgress(job.id, {
      filesDone: 2,
      bytesDone: 200,
      currentItem: '0815-Dach/foto.jpg',
    });
    expect(progressed.filesDone).toBe(2);
    expect(progressed.bytesDone).toBe(200);
    expect(progressed.currentItem).toBe('0815-Dach/foto.jpg');
    expect(progressed.status).toBe('running');

    const ready = await svc.markReady(job.id, 'exchange/exports/abc123/data.zip', {
      action: 'export_built',
      entityLabel: 'Export erstellt',
      payload: { filesTotal: 3, filesDone: 3, bytesDone: 300 },
    });
    expect(ready.status).toBe('ready');
    expect(ready.archiveRef).toBe('exchange/exports/abc123/data.zip');
    expect(ready.finishedAt).not.toBeNull();

    // AC-332: the terminal flip wrote its single data_import audit row in the
    // SAME transaction — by the time markReady resolves, the row is visible.
    const auditRows = await db.execute(
      sql`SELECT action FROM audit_log WHERE entity_id = ${job.id} AND entity_type = 'data_import'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect((auditRows.rows[0] as { action: string }).action).toBe('export_built');
  });

  it('markFailed() records the reason, the terminal status, and the audit row', async () => {
    const job = await svc.create('import', null);
    await svc.markRunning(job.id);
    const failed = await svc.markFailed(job.id, 'unzip failed: corrupt central directory', {
      action: 'import_failed',
      entityLabel: 'Import fehlgeschlagen',
      payload: { error: 'unzip failed: corrupt central directory' },
    });
    expect(failed.status).toBe('failed');
    expect(failed.errorDetail).toContain('corrupt central directory');
    expect(failed.finishedAt).not.toBeNull();

    // The failed terminal also writes its single audit row atomically.
    const auditRows = await db.execute(
      sql`SELECT action FROM audit_log WHERE entity_id = ${job.id} AND entity_type = 'data_import'`,
    );
    expect(auditRows.rows.length).toBe(1);
    expect((auditRows.rows[0] as { action: string }).action).toBe('import_failed');
  });

  it('emits exactly one frame per lifecycle transition', async () => {
    const conn = subscribeFake(bus);
    try {
      const job = await svc.create('export', null); // 1
      await svc.markRunning(job.id); // 2
      await svc.updateProgress(job.id, { filesDone: 1 }); // 3
      await svc.markReady(job.id, null, {
        action: 'export_built',
        entityLabel: 'Export erstellt',
        payload: {},
      }); // 4 — the in-tx audit insert emits no SSE frame, so the count stays 4
      expect(countJobChanged(conn)).toBe(4);
    } finally {
      bus.unsubscribe(conn);
    }
  });

  it('updateProgress() on a vanished job id throws rather than no-opping', async () => {
    await expect(
      svc.updateProgress('00000000-0000-0000-0000-000000000000', { filesDone: 1 }),
    ).rejects.toThrow(/not found/);
  });

  it('latest() returns the most recently created job of a kind', async () => {
    await svc.create('export', null);
    const second = await svc.create('export', null);
    const latestExport = await svc.latest('export');
    expect(latestExport?.id).toBe(second.id);
    expect(await svc.latest('import')).toBeNull();
  });

  it('rejects an out-of-domain kind at the DB CHECK constraint', async () => {
    await expect(
      db.execute(sql`INSERT INTO data_exchange_job (kind) VALUES ('bogus')`),
    ).rejects.toThrow();
  });
});
