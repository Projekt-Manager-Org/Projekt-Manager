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
 * Progress is deliberately NOT audited: it is high-frequency and not a
 * business-entity mutation, so it does not route through `mutate()`. The
 * SINGLE terminal audit row (entity_type `data_import`), however, is written
 * by THIS service ATOMICALLY with the terminal status flip (`markReady` /
 * `markFailed` — see `TerminalAuditRow`). Folding the row into the same
 * transaction as the status update is what guarantees AC-332's "exactly one
 * row at the terminal transition": the status flip is the commit point a
 * poller waits on, so no observer can ever see a terminal job without its
 * audit row. (The prior split-write — flip status, then insert the row in a
 * second statement — let a poller observe the terminal status and query
 * `audit_log` in the window before the insert committed: a flaky 0-rows.)
 *
 * The export/import runners drive this service. They own throttling of
 * `updateProgress` so a thousand-file job does not emit a thousand SSE
 * frames, and they supply the job-kind-specific terminal audit content.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { auditLog, dataExchangeJob } from '../db/schema.js';
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

/** The four `data_import`-typed terminal actions the takeout jobs emit. */
export type TerminalAuditAction =
  | 'export_built'
  | 'export_failed'
  | 'import_restored'
  | 'import_failed';

/**
 * The single terminal `audit_log` row, written ATOMICALLY with the terminal
 * status flip (AC-332). The runner supplies the job-kind-specific content
 * (action / German label / payload); the service fills the constant `system`
 * / `data_import` envelope and owns the atomicity, so "exactly one row at the
 * terminal transition" is structural rather than a caller convention.
 */
export interface TerminalAuditRow {
  action: TerminalAuditAction;
  entityLabel: string;
  payload: Record<string, unknown>;
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

  /**
   * Terminal `ready`: record the staged archive location (VPS-local) and the
   * single terminal audit row, atomically. See {@link TerminalAuditRow}.
   */
  async markReady(
    id: string,
    archiveRef: string | null,
    audit: TerminalAuditRow,
  ): Promise<DataExchangeJob> {
    return this.terminalAndEmit(id, { status: 'ready', archiveRef, finishedAt: new Date() }, audit);
  }

  /**
   * Terminal `failed`: record the operator-facing reason and the single
   * terminal audit row, atomically. See {@link TerminalAuditRow}.
   */
  async markFailed(
    id: string,
    errorDetail: string,
    audit: TerminalAuditRow,
  ): Promise<DataExchangeJob> {
    return this.terminalAndEmit(
      id,
      { status: 'failed', errorDetail, finishedAt: new Date() },
      audit,
    );
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

  /**
   * Apply a TERMINAL status patch and write the single `data_import` audit
   * row in ONE transaction, then emit post-commit. The two writes commit
   * together so a poller that observes the terminal status is guaranteed to
   * also see the audit row (AC-332). Throws (rolling back both) if `id`
   * matched no row.
   */
  private async terminalAndEmit(
    id: string,
    patch: Partial<typeof dataExchangeJob.$inferInsert>,
    audit: TerminalAuditRow,
  ): Promise<DataExchangeJob> {
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(dataExchangeJob)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(dataExchangeJob.id, id))
        .returning();
      if (!updated) throw new Error(`DataExchangeJobService: job ${id} not found`);
      // Constant envelope: a takeout terminal is a deployment-level event with
      // a `system` actor (actor_id NULL ⇒ actor_reason non-empty, the schema's
      // compound CHECK). `data_import` backs no physical table, so it sits
      // outside the single-write-path scan; `entity_id` is the (synthetic) job
      // id. Progress updates write none of this — only this terminal flip does.
      await tx.insert(auditLog).values({
        actorKind: 'system',
        actorId: null,
        actorReason: 'data_import',
        entityType: 'data_import',
        entityId: id,
        entityLabel: audit.entityLabel,
        action: audit.action,
        payload: audit.payload,
        ancestorEntityType: null,
        ancestorEntityId: null,
        correlationId: null,
      });
      return updated;
    });
    emitDataExchangeJobChanged();
    return row;
  }
}
