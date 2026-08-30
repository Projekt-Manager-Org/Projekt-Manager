/**
 * Audit-log repository — read-only (api.md §14.2.8).
 *
 * The audit surface is append-only (data-model.md §5.10); no create,
 * update, or delete path is exposed. Writes happen exclusively through
 * the service-layer `mutate()` helper.
 *
 * Scope composition follows the ADR-0019 pattern: the repository
 * applies one `WHERE` fragment — destructive-action narrowing — ANDed
 * with filters into the list query, and the same fragment decides
 * in-scope vs out-of-scope for get-by-id. An earlier revision carried
 * a second fragment (worker reachability); it was dropped when
 * workers lost `audit:read`.
 *
 * Deterministic ordering: `created_at DESC, id DESC` — the stable
 * tiebreaker ensures a second fetch with the same filters returns
 * the same page (api.md §14.1).
 */

import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { auditLog, users } from '../db/schema.js';
import type { AuditEntityType } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import { auditDestructiveScopeForCaller, OUT_OF_SCOPE, type ScopedReadResult } from './scope.js';

/** Escape LIKE-pattern metacharacters so user input is treated literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

/**
 * SQL predicate restricting the audit feed to rows whose resolved
 * notification-dispatch recipient set would have included `caller`
 * (verification.md AC-200 — the Aktivität "Meine Benachrichtigungen"
 * default view).
 *
 * Structure — a single EXISTS subquery over `notification_rule`:
 *   - Rule is enabled.
 *   - Rule's `event_class` matches the `(entity_type, action)` → class
 *     map from `src/config/notificationEvents.ts`. Encoded inline as a
 *     CASE expression — the map is closed and not user-editable
 *     (data-model.md §5.11), so inlining keeps the predicate composable
 *     in SQL without a server-side round trip. A row whose
 *     `(entity_type, action)` is not in the map yields NULL from the
 *     CASE and cannot match any rule → excluded (expected).
 *   - `state_filter` semantics: NULL matches any `after.status` (or no
 *     status at all); a non-null filter matches only when the payload's
 *     `after.status` equals the filter (mirrors `ruleMatches` in
 *     notificationRecipientResolver.ts — the non-transition classes
 *     only carry NULL per AC-190, so the branch collapses for them).
 *   - Recipient-spec match — at least one of:
 *       a) Role overlap: caller's roles intersect the rule's
 *          `recipient_spec.roles` jsonb array. Encoded with
 *          `jsonb_array_elements_text` + a caller-roles array literal.
 *          Cheap: roles are a tiny bounded set.
 *       b) Assigned-worker match: rule has `includeAssignedWorkers =
 *          true`, the row's entity is project-scoped
 *          (`project` / `project_worker` / `attachment`), and caller is
 *          on `project_workers` for the row's project id. That id is
 *          `entity_id` for `project` / `project_worker` rows, but
 *          `ancestor_entity_id` for `attachment` rows (entity_id there
 *          is the attachment id) — mirrors `extractProjectId` in
 *          notificationRecipientResolver.ts.
 *       c) Explicit userIds membership: caller.id is a string element
 *          of the rule's `recipient_spec.userIds` jsonb array. The `?`
 *          operator tests jsonb key-or-string-array-element existence.
 *
 * Caller liveness: `AuthUser` is produced by the auth middleware, which
 * rejects inactive users with `SESSION_EXPIRED` (401) before the route
 * runs. Dispatch-time also drops inactive users (AC-192 / AC-203) — so
 * no live caller reaches this code path with `active = false`, and the
 * predicate intentionally does not re-check liveness.
 *
 * Returns `null` when `recipientScope` is false/omitted — the caller
 * composes the result into the WHERE clause with `and(...)` so a null
 * collapses to a no-op filter.
 */
function auditRecipientScopePredicate(caller: AuthUser, enabled: boolean): SQL | null {
  if (!enabled) return null;

  // Literal SQL array of caller roles — constructed once. Empty arrays
  // are safe: Postgres array overlap `&&` on two empty arrays returns
  // false, so a caller with no roles cannot match the role clause.
  const rolesLiteral = sql.join(
    caller.roles.map((role) => sql`${role}`),
    sql`, `,
  );
  const callerRolesArray =
    caller.roles.length > 0 ? sql`ARRAY[${rolesLiteral}]::text[]` : sql`ARRAY[]::text[]`;

  return sql`EXISTS (
    SELECT 1 FROM notification_rule nr
    WHERE nr.enabled = TRUE
      AND nr.event_class = (
        CASE
          WHEN audit_log.entity_type = 'project' AND audit_log.action = 'transition:forward'
            THEN 'project.transition_forward'
          WHEN audit_log.entity_type = 'project' AND audit_log.action = 'transition:backward'
            THEN 'project.transition_backward'
          WHEN audit_log.entity_type = 'project' AND audit_log.action = 'archive'
            THEN 'project.archived'
          WHEN audit_log.entity_type = 'project_worker' AND audit_log.action = 'create'
            THEN 'project.assignment_changed'
          WHEN audit_log.entity_type = 'project_worker' AND audit_log.action = 'delete'
            THEN 'project.assignment_changed'
          WHEN audit_log.entity_type = 'attachment' AND audit_log.action = 'attachment:add'
            THEN 'project.attachment_added'
          ELSE NULL
        END
      )
      AND (
        nr.state_filter IS NULL
        OR nr.state_filter = (audit_log.payload -> 'after' ->> 'status')
      )
      AND (
        -- (a) role overlap
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(nr.recipient_spec -> 'roles') AS r(role)
          WHERE r.role = ANY(${callerRolesArray})
        )
        OR
        -- (b) includeAssignedWorkers, project-scoped rows only
        (
          (nr.recipient_spec ->> 'includeAssignedWorkers')::boolean = TRUE
          AND audit_log.entity_type IN ('project', 'project_worker', 'attachment')
          AND EXISTS (
            SELECT 1 FROM project_workers pw
            WHERE pw.project_id = (CASE WHEN audit_log.entity_type = 'attachment'
                                        THEN audit_log.ancestor_entity_id
                                        ELSE audit_log.entity_id END)
              AND pw.user_id = ${caller.id}
          )
        )
        OR
        -- (c) explicit userIds membership — jsonb ? operator on a string array
        (nr.recipient_spec -> 'userIds') ? ${caller.id}
      )
  )`;
}

/**
 * Joined audit row shape returned from the repository, before the
 * service layer shapes it by actor kind. Carries the raw DB column
 * values plus the joined actor display name (when the actor is a user).
 *
 * The repository returns the full column set so both unscoped and
 * scoped read paths share one query shape.
 */
export interface AuditRow {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: 'user' | 'system';
  actorReason: string | null;
  entityType: AuditEntityType;
  entityId: string;
  /** Snapshot of the entity's human-readable label at write time. */
  entityLabel: string | null;
  /**
   * Snapshot of the parent project's human-readable label at write time
   * (architecture.md §11.12). Null for top-level entities. Powers the
   * dock and the /audit Projekt column without a JOIN.
   */
  ancestorEntityLabel: string | null;
  action: string;
  payload: unknown;
  correlationId: string | null;
  /** null when `actorKind='system'` or the actor user has been hard-deleted. */
  actorDisplayName: string | null;
}

export interface ListAuditOpts {
  offset?: number;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: string;
  /**
   * Ancestor-scoped filter (architecture.md §11.12). When set, narrows
   * to rows whose `ancestorEntityType` / `ancestorEntityId` equal the
   * given pair. Powers the per-project activity feed: one indexed
   * predicate returns the project row plus every nested-entity row
   * (`project_worker`, `attachment`, …) scoped to that project.
   *
   * AND-composes with every other filter. The DB CHECK
   * `audit_log_ancestor_pair` guarantees the columns are both set or
   * both null at write time, so a filter on (type, id) produces a
   * well-defined index scan without needing to guard against partial
   * rows in SQL.
   */
  ancestorType?: AuditEntityType;
  ancestorId?: string;
  /**
   * Substring match on `entity_label` (case-insensitive). Used by the
   * Aktivität filter bar in lieu of a UUID input; project-detail's
   * contextual feed continues to filter by `entityId`. NULL-labelled
   * rows are excluded — imports and retention cleanup that omit a label
   * cannot match a label query.
   */
  entityLabelQuery?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  action?: string;
  /**
   * When true, narrow the feed to rows whose resolved dispatch recipient
   * set would have included the caller (verification.md AC-200 — the
   * Aktivität default view). Composes AND with every other filter and
   * is applied BEFORE offset/limit so pagination never drops matching
   * rows. Default false preserves the full RBAC-scoped feed (AC-180).
   */
  recipientScope?: boolean;
}

/** Re-exported so route-layer schema validation pins the same set. */
export { AUDIT_ENTITY_TYPES } from '../db/schema.js';

/**
 * List audit entries visible to the caller.
 *
 * Filters AND-compose; `auditDestructiveScopeForCaller` narrows
 * office visibility (purges / user deletes / role changes are owner-
 * only). Owner gets a null predicate (unfiltered).
 */
export async function listAuditEntries(
  db: Database,
  caller: AuthUser,
  opts: ListAuditOpts,
): Promise<{ rows: AuditRow[]; total: number }> {
  const conditions: SQL[] = [];

  if (opts.entityType !== undefined) {
    conditions.push(eq(auditLog.entityType, opts.entityType));
  }
  if (opts.entityId !== undefined) {
    conditions.push(eq(auditLog.entityId, opts.entityId));
  }
  if (opts.ancestorType !== undefined) {
    conditions.push(eq(auditLog.ancestorEntityType, opts.ancestorType));
  }
  if (opts.ancestorId !== undefined) {
    conditions.push(eq(auditLog.ancestorEntityId, opts.ancestorId));
  }
  if (opts.entityLabelQuery !== undefined) {
    conditions.push(ilike(auditLog.entityLabel, `%${escapeLike(opts.entityLabelQuery)}%`));
  }
  if (opts.actorId !== undefined) {
    conditions.push(eq(auditLog.actorId, opts.actorId));
  }
  if (opts.from !== undefined) {
    conditions.push(gte(auditLog.createdAt, opts.from));
  }
  if (opts.to !== undefined) {
    conditions.push(lte(auditLog.createdAt, opts.to));
  }
  if (opts.action !== undefined) {
    conditions.push(eq(auditLog.action, opts.action));
  }

  const destructive = auditDestructiveScopeForCaller(caller);
  if (destructive) conditions.push(destructive);

  const recipientScope = auditRecipientScopePredicate(caller, opts.recipientScope === true);
  if (recipientScope) conditions.push(recipientScope);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Join users LEFT so rows with actor_id=null (system) or with a
  // hard-deleted actor still appear. The service layer decides whether
  // to expose display_name to the caller.
  const baseSelect = db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      actorReason: auditLog.actorReason,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityLabel: auditLog.entityLabel,
      ancestorEntityLabel: auditLog.ancestorEntityLabel,
      action: auditLog.action,
      payload: auditLog.payload,
      correlationId: auditLog.correlationId,
      actorDisplayName: users.displayName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId));

  const orderedQuery = whereClause
    ? baseSelect.where(whereClause).orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    : baseSelect.orderBy(desc(auditLog.createdAt), desc(auditLog.id));

  const paginated =
    opts.limit !== undefined
      ? orderedQuery.limit(opts.limit).offset(opts.offset ?? 0)
      : orderedQuery;

  const countQuery = whereClause
    ? db
        .select({ value: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(whereClause)
    : db.select({ value: sql<number>`count(*)::int` }).from(auditLog);

  const [rows, countResult] = await Promise.all([paginated, countQuery]);
  const total = countResult[0]?.value ?? 0;

  return {
    rows: rows.map(toAuditRow),
    total,
  };
}

/**
 * Get an audit entry by id, respecting caller scope.
 *
 * Three-valued result (ADR-0019):
 *   - `null`         — row does not exist (→ 404 NOT_FOUND)
 *   - `OUT_OF_SCOPE` — row exists but caller's scope excludes it
 *                      (→ 403 NOT_PERMITTED)
 *   - `AuditRow`     — in-scope row
 *
 * The two-step fetch (id lookup, then scope check with both predicates)
 * is deliberate: one combined query cannot distinguish "not found" from
 * "out of scope" post-hoc, and collapsing them would leak existence via
 * absence (parity with AC-147 for the per-entity surface).
 */
export async function getAuditEntry(
  db: Database,
  caller: AuthUser,
  id: string,
): Promise<ScopedReadResult<AuditRow>> {
  const baseQuery = db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorKind: auditLog.actorKind,
      actorReason: auditLog.actorReason,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      entityLabel: auditLog.entityLabel,
      ancestorEntityLabel: auditLog.ancestorEntityLabel,
      action: auditLog.action,
      payload: auditLog.payload,
      correlationId: auditLog.correlationId,
      actorDisplayName: users.displayName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(eq(auditLog.id, id))
    .limit(1);

  const rows = await baseQuery;
  if (rows.length === 0) return null;

  // Scope check: the row exists; re-run the destructive predicate to
  // catch office-visibility narrowing (purges / user-deletes etc.).
  // Owner gets null (unfiltered). A tiny lookup query is cheaper than
  // evaluating the jsonb predicates in application code.
  const destructive = auditDestructiveScopeForCaller(caller);
  if (destructive !== null) {
    const check = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.id, id), destructive))
      .limit(1);
    if (check.length === 0) return OUT_OF_SCOPE;
  }

  return toAuditRow(rows[0]!);
}

function toAuditRow(row: {
  id: string;
  createdAt: Date;
  actorId: string | null;
  actorKind: string;
  actorReason: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  ancestorEntityLabel: string | null;
  action: string;
  payload: unknown;
  correlationId: string | null;
  actorDisplayName: string | null;
}): AuditRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorKind as 'user' | 'system',
    actorReason: row.actorReason,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    ancestorEntityLabel: row.ancestorEntityLabel,
    action: row.action,
    payload: row.payload,
    correlationId: row.correlationId,
    actorDisplayName: row.actorDisplayName,
  };
}
