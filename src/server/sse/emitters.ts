/**
 * Typed emit helpers for the SSE invalidation bus. One helper per
 * event name in the catalog (`src/config/sseEvents.ts`) so call sites
 * cannot misspell the wire string and cannot accidentally swap
 * payloads between event classes. Per architecture.md §11.13 emission
 * is post-commit only — every helper assumes the surrounding
 * transaction has already resolved.
 */

import {
  AUDIT_CHANGED,
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
