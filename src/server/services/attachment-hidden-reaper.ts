/**
 * Attachment hidden reaper — data-model.md §6.12, AC-246.
 *
 * Hard-deletes `attachment` rows at `status = 'hidden'` whose age past
 * `hiddenAt` exceeds the configured TTL. Each removed row produces
 * exactly one `audit_log` row with `action = 'attachment:purge'`,
 * written through the single-write-path helper (`mutate()`, AC-177) so
 * the DELETE and the audit row commit atomically.
 *
 * Operational-log contract: exactly one info line per run with fields
 * `event = 'attachment-hidden-reaper'`, `ttl_minutes`, `removed_count`
 * (non-negative; 0 on no-op), `ran_at` (ISO 8601).
 *
 * Failure semantics: a per-row `mutate()` failure logs `error_hint`
 * and the failing row id under the same event on the error channel,
 * then the sweep continues with the next row. Partial progress is
 * acceptable. CAS-loss to a concurrent restore is silent (not a
 * failure) — `HiddenReaperRowRaced` is the sentinel that triggers a
 * transaction rollback without a log entry.
 *
 * No `storage` dependency. Bytes are the bucket lifecycle's concern
 * (ADR-0022) — the reaper is DB-only.
 */

import type { Database } from '../db/connection.js';
import type { ServiceLogger } from './Logger.js';
import { findHiddenForReap, deleteHiddenForReap } from '../repositories/attachment.js';
import { mutate } from './mutate.js';
import { emitAttachmentChanged, emitStorageUsageChanged } from '../sse/emitters.js';

const MS_PER_MINUTE = 60 * 1000;

export interface RunAttachmentHiddenReaperDeps {
  db: Database;
  logger: ServiceLogger;
  ttlMinutes: number;
  /**
   * Injectable wall clock. Production callers omit; tests supply so
   * backdated fixture rows behave deterministically regardless of
   * clock skew.
   */
  now?: Date;
}

export const EVENT_ATTACHMENT_HIDDEN_REAPER = 'attachment-hidden-reaper';

/**
 * Sentinel thrown from inside the per-row `mutate()` transaction when
 * the CAS DELETE finds the row no longer at `status = 'hidden'`. The
 * outer loop catches it and continues silently — a concurrent restore
 * is a successful business outcome, not a reaper fault.
 */
export class HiddenReaperRowRaced extends Error {
  constructor(id: string) {
    super(`Hidden reaper: row ${id} was no longer status='hidden' at delete time`);
    this.name = 'HiddenReaperRowRaced';
  }
}

export async function runAttachmentHiddenReaper(
  deps: RunAttachmentHiddenReaperDeps,
): Promise<void> {
  if (!Number.isInteger(deps.ttlMinutes) || deps.ttlMinutes <= 0) {
    throw new Error(
      `runAttachmentHiddenReaper: ttlMinutes must be a positive integer, got ${deps.ttlMinutes}`,
    );
  }

  const runAt = deps.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - deps.ttlMinutes * MS_PER_MINUTE);

  const candidates = await findHiddenForReap(deps.db, cutoff);

  let removedCount = 0;
  for (const row of candidates) {
    try {
      await mutate(
        deps.db,
        { actorKind: 'system', actorReason: 'hidden-reaper', correlationId: null },
        {
          entityType: 'attachment',
          action: 'attachment:purge',
          run: async (tx) => {
            const deleted = await deleteHiddenForReap(tx, row.id);
            if (!deleted) {
              // CAS-loss: a concurrent restore flipped the row to 'ready'
              // between findHiddenForReap and this DELETE. Throw the
              // sentinel so mutate() rolls back the audit insert that
              // would otherwise pair with a no-op DELETE.
              throw new HiddenReaperRowRaced(row.id);
            }
            return {
              entityId: row.id,
              value: undefined,
              entityLabel: row.filename,
              before: {
                attachmentId: row.id,
                projectId: row.projectId,
                label: row.label,
                mimeType: row.mimeType,
                sizeBytes: row.sizeBytes,
              },
              after: {},
              ancestorEntityType: 'project',
              ancestorEntityId: row.projectId,
            };
          },
        },
      );
      removedCount += 1;
      // Post-commit: a hidden row's bytes leave the hidden bucket
      // (data-model.md §5.14). Broadcast AFTER mutate() resolves so
      // CAS-loss (HiddenReaperRowRaced — caught below) and per-row
      // failures emit nothing (AC-270 emitter list).
      emitStorageUsageChanged();
      // The purged row leaves the project's Papierkorb, so the
      // cross-session attachment caches must invalidate too (AC-336).
      emitAttachmentChanged();
    } catch (err) {
      if (err instanceof HiddenReaperRowRaced) continue;
      // Real DB / dispatcher fault on this row — log on the error
      // channel with the row id and continue. The info line at the
      // end still fires; `removed_count` reflects observed deletions
      // only, parallel to the orphan reaper (data-model.md §6.11).
      deps.logger.error(
        {
          event: EVENT_ATTACHMENT_HIDDEN_REAPER,
          attachment_id: row.id,
          error_hint: err instanceof Error ? err.message : String(err),
        },
        EVENT_ATTACHMENT_HIDDEN_REAPER,
      );
    }
  }

  deps.logger.info(
    {
      event: EVENT_ATTACHMENT_HIDDEN_REAPER,
      ttl_minutes: deps.ttlMinutes,
      removed_count: removedCount,
      ran_at: runAt.toISOString(),
    },
    EVENT_ATTACHMENT_HIDDEN_REAPER,
  );
}
