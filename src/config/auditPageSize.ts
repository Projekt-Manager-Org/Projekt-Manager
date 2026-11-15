/**
 * Audit-list page size.
 *
 * Default window size for `GET /api/audit` list requests. Shared by
 * both activity surfaces — the global Aktivität view ([ui/management.md
 * §8.13](docs/spec/ui/management.md#813-audit-view)) and the project-detail
 * activity feed ([ui/workflow-views.md §8.4.1](docs/spec/ui/workflow-views.md#841-activity-feed))
 * paginate in this increment via "Ältere anzeigen".
 *
 * [C] customer-configurable per architecture.md §12.2 — the exact value
 * is a deployment concern (AC-628 pins the configurability, not the
 * number). Layer placement mirrors `auditRetention.ts` and
 * `backupThresholds.ts`: the config layer owns the default, the state
 * layer imports it, the UI never hard-codes a number.
 */

/** [C] — customer-configurable; see module docstring for rationale. */
export const AUDIT_PAGE_SIZE = 50;
