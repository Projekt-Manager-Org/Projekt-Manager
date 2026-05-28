/**
 * Audit-log domain types (frontend view).
 *
 * Mirrors the API-facing `AuditEntry` contract from `api.md §14.2.8`
 * and `data-model.md §5.10`. Pure types + type guards — no state, no
 * API calls. This module is safe to import from config, state, and
 * UI layers.
 *
 * The server applies per-role response shaping (actorId / payload
 * stripping for worker callers), so every optional field below has a
 * documented "may be null" reason tied to the API contract.
 */

/**
 * Entity types that can appear as an audit row's target. Matches the
 * server-side `AuditEntityType` enum (data-model.md §5.10, see
 * `src/server/db/schema.ts`). The union is written here rather than
 * imported from the server module to respect the layering rule — the
 * domain layer must not depend on server internals.
 *
 * `data_import` is a synthetic type (no physical row) carried by the
 * single audit entry a business-data import (`ImportService`) commit
 * writes (issue #230). The
 * domain row stands alone — `entity_id` is a per-import batch UUID,
 * not a row reference.
 */
export type AuditEntityType =
  | 'project'
  | 'customer'
  | 'user'
  | 'project_worker'
  | 'attachment'
  | 'invoice'
  | 'company_profile'
  | 'data_import';

export type AuditActorKind = 'user' | 'system';

/**
 * One audit-log entry as returned by the API (`GET /api/audit` or
 * `GET /api/audit/:id`). Every nullable field's nullability is pinned
 * by the server contract — the client must never synthesize values.
 */
export interface AuditEntry {
  id: string;
  createdAt: string;
  /** The actor's user id (or null for `system`-kind rows). */
  actorId: string | null;
  actorKind: AuditActorKind;
  /** Free-text reason carried on system-actor rows. */
  actorReason: string | null;
  /** Display name of the user actor. Null on system rows. */
  actorDisplayName: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /**
   * Human-readable label for the entity at event time (e.g. a
   * project's "2026-002 Innenraumgestaltung Weber", a customer's
   * "Firma Weber GmbH"). Frozen at write time — stays meaningful
   * after the target is renamed or purged. Null on legacy rows or
   * paths that couldn't supply one; the UI falls back to `entityId`.
   */
  entityLabel: string | null;
  /**
   * Parent project's label snapshot at write time (architecture.md
   * §11.12). Non-null for project rows (self-ancestor) and child-entity
   * rows (`project_worker`, `attachment`, `invoice`); null for top-level
   * entities (`customer`, `user`, `company_profile`, `data_import`).
   * Powers the activity dock's single-line row (AC-339) and the global
   * Aktivität view's `Projekt` column (AC-342) without a JOIN.
   */
  ancestorEntityLabel: string | null;
  /**
   * Action vocabulary — free-text by design (data-model.md §5.10). The
   * shipping set is pinned by `auditActionLabels.ts` for UI rendering;
   * filter-side validation is enforced by the server.
   */
  action: string;
  /**
   * The field-level diff payload (jsonb on the server). `unknown`
   * is deliberate — the payload shape varies by action and entity
   * type and is rendered by a shape-tolerant drawer.
   */
  payload: unknown | null;
  correlationId: string | null;
}

export interface AuditListResponse {
  data: AuditEntry[];
  total: number;
}

/**
 * Filter / pagination parameters accepted by `GET /api/audit`. All
 * fields are optional; inversely-ordered date bounds (`to < from`)
 * are a validation error on the server (api.md §14.2.8).
 */
export interface AuditListParams {
  offset?: number;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: string;
  /**
   * Ancestor-scoped filter (architecture.md §11.12). Returns every row
   * whose write-time ancestor link equals `(ancestorType, ancestorId)`.
   * Used by the project-detail activity feed so the one call returns
   * project rows plus nested entities (worker assignments, attachments).
   */
  ancestorType?: AuditEntityType;
  ancestorId?: string;
  /**
   * Case-insensitive substring match on `entityLabel`. Min 3 chars so
   * the server's GIN trigram index can serve the query (api.md §14.2.8).
   * Rows with a null label are excluded.
   */
  entityLabelQuery?: string;
  actorId?: string;
  /** ISO-8601 lower bound, inclusive. */
  from?: string;
  /** ISO-8601 upper bound, inclusive. */
  to?: string;
  action?: string;
  /**
   * Recipient-scoped narrowing (AC-200, ui/management.md §8.13.1). When
   * `true` the server is expected to return only rows the caller would
   * receive per the resolved notification-rule set (rule-match across
   * enabled rules → recipient resolution includes the caller). When
   * `false` or omitted, no recipient narrowing applies — the caller's
   * RBAC-scoped feed is returned as-is.
   *
   * Driven by the "Alles anzeigen" toggle on the global Aktivität view.
   * The per-project activity feed never sets this — it is strictly a
   * global-view concern.
   *
   * Server-side support is a prerequisite — a client-only filter would
   * mislead under pagination (partial-page filtering collapses the
   * "Ältere anzeigen" guarantee). See the UI wiring in
   * `AuditManagement.tsx` for the toggle state machine.
   */
  recipientScope?: boolean;
}

/**
 * Shape guard for the before/after diff used in the payload drawer.
 *
 * The server's `mutate()` helper writes payloads like
 *   `{ before: { field: value, ... }, after: { field: value, ... } }`
 * for update actions; create / delete rows carry a single-sided shape
 * (e.g. `{ after: { ... } }`). The drawer renders whichever keys are
 * present, so the guard accepts any object with at least one of the
 * two keys.
 */
export function isPayloadDiff(payload: unknown): payload is {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
} {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return 'before' in p || 'after' in p;
}

/**
 * Canonical audit label for a project row — `"<number> <title>"`.
 *
 * Used by the service layer when writing `audit_log` rows for projects
 * and for project cascades during customer deletes. A single seam so a
 * future format change does not have to chase eight string literals.
 */
export function projectAuditLabel(row: { number: string; title: string }): string {
  return `${row.number} ${row.title}`;
}

/**
 * Em dash for the "Projekt" cell when an audit row has no project
 * ancestor (top-level entities: customer / user / company_profile /
 * data_import). Single visual atom — the user reads "no project"
 * without parsing a blank cell.
 */
export const AUDIT_NO_PROJECT_LABEL = '—';

/**
 * Display value for the project slot — `ancestorEntityLabel` when set,
 * em dash otherwise. AC-339 (dock single-line row) and AC-342 (audit
 * table Projekt column) share this; centralising avoids drift.
 */
export function auditProjectSlot(entry: Pick<AuditEntry, 'ancestorEntityLabel'>): string {
  return entry.ancestorEntityLabel ?? AUDIT_NO_PROJECT_LABEL;
}
