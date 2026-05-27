/**
 * Catalog of realtime invalidation event names — the wire vocabulary
 * shared between the server bus (`src/server/sse/`) and the browser
 * subscriber (`src/sse/`). Each constant is the literal string that
 * lands on the SSE `event:` line; tests pin the wire format against
 * the same constants so a typo at any emit or subscribe site fails
 * compilation rather than silently dropping invalidation.
 *
 * Spec contract: api.md §14.2.13, architecture.md §11.13, ADR-0025.
 */

export const STORAGE_USAGE_CHANGED = 'storage_usage_changed' as const;

/**
 * Fired post-commit from every attachment mutation that changes a
 * project's attachment list — completeUpload (pending→ready), hide,
 * restore, and the hidden-reaper purge (ADR-0025, AC-336). Invalidates
 * the per-project `attachmentStore` caches (the gallery / binary list
 * and the Papierkorb) so the always-open observer's view refreshes
 * cross-session. Invalidation-only like the rest of the catalog.
 */
export const ATTACHMENT_CHANGED = 'attachment_changed' as const;

export const PROJECT_CHANGED = 'project_changed' as const;

export const INVOICE_CHANGED = 'invoice_changed' as const;

export const AUDIT_CHANGED = 'audit_changed' as const;

/**
 * Fired when a data-exchange job (the full-account export/import) changes
 * state or advances progress (ADR-0018 § Two surfaces, ADR-0024 §
 * Full-account takeout). Invalidation-only like the rest of the catalog:
 * the client refetches the job status from its REST endpoint on receipt.
 */
export const DATA_EXCHANGE_JOB_CHANGED = 'data_exchange_job_changed' as const;

/**
 * The runtime list of every event name in the catalog — the single
 * source of truth for both the `SseEventName` union (derived below) and
 * the subscribe-side coverage guard (AC-338), which asserts every
 * member has ≥1 client subscriber so a new event cannot ship emit-only
 * (the gallery-gap failure mode, #237). Adding a constant above without
 * adding it here is a compile error at every `SseEventName` use site.
 */
export const SSE_EVENT_NAMES = [
  STORAGE_USAGE_CHANGED,
  ATTACHMENT_CHANGED,
  PROJECT_CHANGED,
  INVOICE_CHANGED,
  AUDIT_CHANGED,
  DATA_EXCHANGE_JOB_CHANGED,
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];
