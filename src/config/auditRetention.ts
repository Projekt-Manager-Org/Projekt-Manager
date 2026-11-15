/**
 * Audit-log retention window.
 *
 * Rolling age (days) at which `audit_log` rows are removed by the
 * scheduled cleanup job (AC-632). The cleanup
 * is the table's only delete path — every other application path is
 * append-only.
 *
 * The default (90 days) aligns with the Layer 2 backup window
 * (ADR-0020) and the cross-surface retention choice recorded in
 * ADR-0021. A deployment overrides it via `AUDIT_RETENTION_WINDOW_DAYS`
 * (see `src/server/config/env.ts`); this module exports only the
 * build-time default.
 *
 * [C] customer-configurable per architecture.md §12.2.
 *
 * Layer note: mirrors `backupThresholds.ts` — config layer owns the
 * default, the server's env loader owns the override, and the service
 * layer receives the resolved value as an explicit argument.
 */
export interface AuditRetentionConfig {
  /** Rolling retention window in days. Rows older than this are deleted. [C] */
  windowDays: number;
}

/** [C] — customer-configurable; see module docstring for rationale. */
export const AUDIT_RETENTION: AuditRetentionConfig = {
  windowDays: 90,
};
