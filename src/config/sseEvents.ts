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

export type SseEventName =
  | typeof STORAGE_USAGE_CHANGED
  | typeof PROJECT_CHANGED
  | typeof INVOICE_CHANGED
  | typeof AUDIT_CHANGED
  | typeof DATA_EXCHANGE_JOB_CHANGED;
