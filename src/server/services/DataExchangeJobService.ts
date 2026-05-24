/**
 * Lifecycle service for full-account data-exchange jobs (ADR-0018 § Two
 * surfaces, ADR-0024 § Full-account takeout).
 *
 * Owns the `data_exchange_job` row's state machine
 * (`pending → running → ready | failed`) and the progress counters that
 * back the live readout. Every mutation emits `data_exchange_job_changed`
 * AFTER the write resolves (architecture.md §11.13 post-commit
 * discipline) so the UI refetches the row over its REST endpoint — the
 * SSE frame is an invalidation hint, never a data carrier.
 *
 * Deliberately NOT an audited entity: progress is high-frequency and is
 * not a business-entity mutation, so the row does not route through
 * `mutate()`. The start/terminal audit row (entity_type `data_import`)
 * is the job endpoint's concern (later commit), where the request/actor
 * context lives.
 *
 * The export builder and import processor (later commits) drive this
 * service. They own throttling of `updateProgress` so a thousand-file
 * job does not emit a thousand SSE frames.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { dataExchangeJob } from '../db/schema.js';
import { emitDataExchangeJobChanged } from '../sse/emitters.js';

export type DataExchangeJobKind = 'export' | 'import';
export type DataExchangeJobStatus = 'pending' | 'running' | 'ready' | 'failed';

/** Row shape as selected from the DB (counters are plain numbers). */
export type DataExchangeJob = typeof dataExchangeJob.$inferSelect;

/** Totals known at the point the job starts running. */
export interface RunningInit {
  filesTotal?: number;
  bytesTotal?: number;
  /**
   * Staged archive path. The import job stamps this at `markRunning` (when
   * the upload completes) so the staging reaper ([data-model.md §6.15]) can
   * locate the file for a terminal job — ready OR failed. The export job
   * leaves it unset here and stamps it at `markReady` instead.
   */
  archiveRef?: string;
}

/** Incremental progress; `currentItem` is the file/label being processed. */
export interface ProgressUpdate {
  /**
   * Total work units known once the build has enumerated its input.
   * `markRunning` seeds them when the totals are known up front; the
   * export builder enumerates the `ready` attachment set lazily, so it
   * carries `filesTotal`/`bytesTotal` on its first progress tick instead
   * (data-model.md §5.18). `bytesTotal` is the byte readout's denominator
   * (ui/daten.md §8.11).
   */
  filesTotal?: number;
  bytesTotal?: number;
  filesDone?: number;
  bytesDone?: number;
  currentItem?: string | null;
}

export class DataExchangeJobService {
  constructor(private readonly db: Database) {}

  /** Create a fresh `pending` job and emit one invalidation frame. */
  async create(kind: DataExchangeJobKind, createdBy: string | null): Promise<DataExchangeJob> {
    const [row] = await this.db.insert(dataExchangeJob).values({ kind, createdBy }).returning();
    emitDataExchangeJobChanged();
    return row!;
  }

  /** `pending → running`: stamp `startedAt` and any known totals. */
  async markRunning(id: string, init: RunningInit = {}): Promise<DataExchangeJob> {
    return this.updateAndEmit(id, {
      status: 'running',
      startedAt: new Date(),
      ...(init.filesTotal !== undefined ? { filesTotal: init.filesTotal } : {}),
      ...(init.bytesTotal !== undefined ? { bytesTotal: init.bytesTotal } : {}),
      ...(init.archiveRef !== undefined ? { archiveRef: init.archiveRef } : {}),
    });
  }

  /** Advance the progress counters / current-item readout. Caller throttles. */
  async updateProgress(id: string, p: ProgressUpdate): Promise<DataExchangeJob> {
    return this.updateAndEmit(id, {
      ...(p.filesTotal !== undefined ? { filesTotal: p.filesTotal } : {}),
      ...(p.bytesTotal !== undefined ? { bytesTotal: p.bytesTotal } : {}),
      ...(p.filesDone !== undefined ? { filesDone: p.filesDone } : {}),
      ...(p.bytesDone !== undefined ? { bytesDone: p.bytesDone } : {}),
      ...(p.currentItem !== undefined ? { currentItem: p.currentItem } : {}),
    });
  }

  /** Terminal `ready`: record the staged archive location (VPS-local). */
  async markReady(id: string, archiveRef: string | null): Promise<DataExchangeJob> {
    return this.updateAndEmit(id, { status: 'ready', archiveRef, finishedAt: new Date() });
  }

  /** Terminal `failed`: record the operator-facing reason. */
  async markFailed(id: string, errorDetail: string): Promise<DataExchangeJob> {
    return this.updateAndEmit(id, { status: 'failed', errorDetail, finishedAt: new Date() });
  }

  /** Fetch a single job, or `null` if absent. */
  async get(id: string): Promise<DataExchangeJob | null> {
    const [row] = await this.db
      .select()
      .from(dataExchangeJob)
      .where(eq(dataExchangeJob.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The currently-active (`pending` or `running`) job of a kind, or
   * `null` — backs the one-active-per-kind gate on create (api.md
   * §14.2.4). In-process single-operator execution means at most one
   * such row exists; `desc(createdAt)` is a defensive tiebreaker.
   */
  async activeOfKind(kind: DataExchangeJobKind): Promise<DataExchangeJob | null> {
    const [row] = await this.db
      .select()
      .from(dataExchangeJob)
      .where(
        and(
          eq(dataExchangeJob.kind, kind),
          inArray(dataExchangeJob.status, ['pending', 'running']),
        ),
      )
      .orderBy(desc(dataExchangeJob.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Most recently created job of a kind — the UI's "active job" probe. */
  async latest(kind: DataExchangeJobKind): Promise<DataExchangeJob | null> {
    const [row] = await this.db
      .select()
      .from(dataExchangeJob)
      .where(eq(dataExchangeJob.kind, kind))
      .orderBy(desc(dataExchangeJob.createdAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * Apply a partial update, bump `updatedAt`, emit post-write, and return
   * the fresh row. Throws if `id` matched no row — a caller holding a job
   * id that has vanished is a bug, not a silent no-op.
   */
  private async updateAndEmit(
    id: string,
    patch: Partial<typeof dataExchangeJob.$inferInsert>,
  ): Promise<DataExchangeJob> {
    const [row] = await this.db
      .update(dataExchangeJob)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(dataExchangeJob.id, id))
      .returning();
    if (!row) throw new Error(`DataExchangeJobService: job ${id} not found`);
    emitDataExchangeJobChanged();
    return row;
  }
}
