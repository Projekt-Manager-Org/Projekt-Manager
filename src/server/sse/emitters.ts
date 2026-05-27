/**
 * Typed emit helpers for the SSE invalidation bus. One helper per
 * event name in the catalog (`src/config/sseEvents.ts`) so call sites
 * cannot misspell the wire string and cannot accidentally swap
 * payloads between event classes. Per architecture.md §11.13 emission
 * is post-commit only — every helper assumes the surrounding
 * transaction has already resolved.
 */

import {
  ATTACHMENT_CHANGED,
  AUDIT_CHANGED,
  DATA_EXCHANGE_JOB_CHANGED,
  INVOICE_CHANGED,
  PROJECT_CHANGED,
  STORAGE_USAGE_CHANGED,
} from '../../config/sseEvents.js';
import { broadcast } from './bus.js';

/**
 * Broadcast `storage_usage_changed` (api.md §14.2.13). Emit AFTER the
 * surrounding transaction commits so a tx abort emits nothing
 * (verification.md AC-270, architecture.md §11.13).
 */
export function emitStorageUsageChanged(): void {
  broadcast(STORAGE_USAGE_CHANGED);
}

/**
 * Broadcast `attachment_changed` (api.md §14.2.13, ADR-0025). Emitted
 * post-commit from every attachment mutation that changes a project's
 * attachment list (completeUpload / hide / restore / hidden-reaper
 * purge) so the cross-session `attachmentStore` caches invalidate —
 * the gallery gap #237 closed. Emit AFTER the surrounding `mutate()`
 * resolves so a tx abort emits nothing (verification.md AC-336,
 * architecture.md §11.13). Co-emitted with `emitStorageUsageChanged`
 * at each site; the two events' consumers are independent.
 */
export function emitAttachmentChanged(): void {
  broadcast(ATTACHMENT_CHANGED);
}

/**
 * Broadcast `project_changed` (api.md §14.2.13). Emit AFTER the
 * surrounding transaction commits so a tx abort emits nothing
 * (verification.md AC-276, architecture.md §11.13).
 */
export function emitProjectChanged(): void {
  broadcast(PROJECT_CHANGED);
}

/**
 * Broadcast `invoice_changed` (ADR-0026, api.md §14.2.13). Emit AFTER
 * the issuance / cancellation transaction commits — a rollback must
 * leak no event. Mirrors `emitProjectChanged` (architecture.md §11.13).
 */
export function emitInvoiceChanged(): void {
  broadcast(INVOICE_CHANGED);
}

/**
 * Broadcast `audit_changed` (api.md §14.2.13). Fired post-commit per
 * audit-log row (ADR-0021 / architecture.md §11.13 — the audit
 * publisher dispatches once per committed row, after the originating
 * tx commits, so a rollback leaks no event). One frame per row is
 * deliberate: the ActivityFeed's client-side `fetchSeq` guard
 * collapses concurrent refetches, so a transaction that writes N
 * rows lands N invalidation hints and exactly one refetch.
 */
export function emitAuditChanged(): void {
  broadcast(AUDIT_CHANGED);
}

/**
 * Broadcast `data_exchange_job_changed` (ADR-0018 § Two surfaces,
 * ADR-0024 § Full-account takeout). Emit AFTER the job-row write resolves
 * so a failed write leaks no event. Lifecycle transitions (created /
 * running / ready / failed) always emit; the job runner throttles
 * high-frequency progress emissions (architecture.md §11.13).
 */
export function emitDataExchangeJobChanged(): void {
  broadcast(DATA_EXCHANGE_JOB_CHANGED);
}
