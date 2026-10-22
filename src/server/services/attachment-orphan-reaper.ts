/**
 * Attachment orphan reaper — AC-408.
 *
 * Removes `attachment` rows stuck at `status = 'pending'` past the
 * configured TTL together with the backing `originalKey` / `thumbKey`
 * objects. Allowlisted in `scripts/check-audit-mutations.sh`: pending
 * rows never entered the domain, so no `audit_log` row is produced.
 *
 * Operational-log contract: exactly one info
 * line per run with fields `event`, `ttl_minutes`, `removed_count`
 * (non-negative; 0 on no-op), `ran_at` (ISO 8601).
 *
 * Failure semantics: a storage delete that fails (missing key,
 * transient provider error) is logged with `error_hint` and the row
 * is still removed. The metadata-table cleanliness goal trumps a
 * missing backing object.
 */

import type { Database } from '../db/connection.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';
import { deleteOrphans } from '../repositories/attachment.js';

const MS_PER_MINUTE = 60 * 1000;

export interface RunAttachmentOrphanReaperDeps {
  db: Database;
  storage: AttachmentStorageClient;
  logger: ServiceLogger;
  ttlMinutes: number;
  /**
   * Injectable wall clock. Production callers omit; tests supply so
   * backdated fixture rows behave deterministically regardless of
   * clock skew.
   */
  now?: Date;
}

export const EVENT_ATTACHMENT_ORPHAN_REAPER = 'attachment-orphan-reaper';

export async function runAttachmentOrphanReaper(
  deps: RunAttachmentOrphanReaperDeps,
): Promise<void> {
  if (!Number.isInteger(deps.ttlMinutes) || deps.ttlMinutes <= 0) {
    throw new Error(
      `runAttachmentOrphanReaper: ttlMinutes must be a positive integer, got ${deps.ttlMinutes}`,
    );
  }

  const runAt = deps.now ?? new Date();
  const cutoff = new Date(runAt.getTime() - deps.ttlMinutes * MS_PER_MINUTE);

  // Delete orphan rows first, capturing their storage keys. The DELETE
  // is the authoritative "row gone" signal; storage cleanup follows
  // best-effort so a transient storage error cannot revive a row.
  const removedRows = await deleteOrphans(deps.db, cutoff);

  for (const row of removedRows) {
    await bestEffortDelete(deps.storage, row.originalKey, deps.logger);
    if (row.thumbKey) {
      await bestEffortDelete(deps.storage, row.thumbKey, deps.logger);
    }
  }

  const ranAt = runAt.toISOString();
  deps.logger.info(
    {
      event: EVENT_ATTACHMENT_ORPHAN_REAPER,
      ttl_minutes: deps.ttlMinutes,
      removed_count: removedRows.length,
      ran_at: ranAt,
    },
    EVENT_ATTACHMENT_ORPHAN_REAPER,
  );
}

async function bestEffortDelete(
  storage: AttachmentStorageClient,
  key: string,
  logger: ServiceLogger,
): Promise<void> {
  try {
    await storage.hide(key);
  } catch (err) {
    // The metadata-table cleanliness goal trumps a missing
    // backing object. Log with `error_hint` (error channel so the single
    // info line-per-run contract stays intact) and continue. S3's
    // DeleteObject is idempotent, so reaching this branch means a
    // genuine provider fault — an error-channel log is the right signal.
    logger.error(
      {
        event: EVENT_ATTACHMENT_ORPHAN_REAPER,
        error_hint: err instanceof Error ? err.message : String(err),
        key,
      },
      EVENT_ATTACHMENT_ORPHAN_REAPER,
    );
  }
}
