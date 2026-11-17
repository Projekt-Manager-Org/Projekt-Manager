/**
 * Typed emit helpers for the SSE invalidation bus. One helper per
 * event name in the catalog (`src/config/sseEvents.ts`) so call sites
 * cannot misspell the wire string and cannot accidentally swap
 * payloads between event classes. Per ADR-0025 emission
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
 * Broadcast `storage_usage_changed`. Emit AFTER the surrounding
 * transaction commits so a tx abort emits nothing.
 */
export function emitStorageUsageChanged(): void {
  broadcast(STORAGE_USAGE_CHANGED);
}

/**
 * Broadcast `attachment_changed`. Emitted post-commit from every
 * attachment mutation that changes a project's attachment list so the
 * cross-session `attachmentStore` caches invalidate — the gallery gap
 * #237 closed. Emit only after the write commits, so a tx abort emits
 * nothing. Co-emitted with `emitStorageUsageChanged`; the two events'
 * consumers are independent.
 */
export function emitAttachmentChanged(): void {
  broadcast(ATTACHMENT_CHANGED);
}

/**
 * Broadcast `project_changed`. Emit AFTER the surrounding transaction
 * commits so a tx abort emits nothing.
 */
export function emitProjectChanged(): void {
  broadcast(PROJECT_CHANGED);
}

/**
 * Broadcast `invoice_changed` (ADR-0026). Emit AFTER the mutating
 * transaction commits — a rollback must leak no event. Mirrors
 * `emitProjectChanged`.
 */
export function emitInvoiceChanged(): void {
  broadcast(INVOICE_CHANGED);
}

/**
 * Broadcast `audit_changed`. Fired post-commit per audit-log row
 * (ADR-0021 — the audit publisher dispatches once per committed row,
 * after the originating tx commits, so a rollback leaks no event).
 * One frame per row is deliberate: the ActivityFeed's client-side
 * `fetchSeq` guard collapses concurrent refetches, so a transaction
 * that writes N rows lands N invalidation hints and exactly one
 * refetch.
 */
export function emitAuditChanged(): void {
  broadcast(AUDIT_CHANGED);
}

/**
 * Broadcast `data_exchange_job_changed` (ADR-0018 § Two surfaces,
 * ADR-0024 § Full-account takeout). Emit AFTER the job-row write resolves
 * so a failed write leaks no event. Lifecycle transitions (created /
 * running / ready / failed) always emit; the job runner throttles
 * high-frequency progress emissions.
 */
export function emitDataExchangeJobChanged(): void {
  broadcast(DATA_EXCHANGE_JOB_CHANGED);
}
