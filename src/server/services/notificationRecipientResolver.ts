/**
 * Notification recipient resolver — pure helpers for the publisher.
 *
 * Extracted from `notification-publisher.ts` so the orchestrator stays
 * focused on bus wiring, observation fan-out, and dispatch flow. The
 * helpers here are:
 *   - `extractAfterStatus`: pull `payload.after.status` from an audit row.
 *   - `extractProjectId`: derive a project id for project-scoped events.
 *   - `ruleMatches`: apply the stateFilter semantics.
 *   - `resolveRecipients`: deduplicated union across matching rules.
 *   - `filterUnmutedUserIds`: push-mute filter at delivery time.
 *
 * Every helper takes its dependencies explicitly so the set is
 * unit-testable if needed and the publisher's module-scope bindings
 * stay isolated.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { users, projectWorkers } from '../db/schema.js';
import type { NotificationRuleRow } from '../repositories/notificationRule.js';
import {
  type NotificationEventClass,
  PROJECT_SCOPED_EVENT_CLASSES,
  TRANSITION_EVENT_CLASSES,
} from '../../config/notificationEvents.js';
import type { NotificationRecipientSpec } from '../../domain/notifications.js';
import type { AuditLogRow } from './audit-publisher.js';

export function extractAfterStatus(row: AuditLogRow | null): string | null {
  if (!row) return null;
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const after = (payload as { after?: unknown }).after;
  if (typeof after !== 'object' || after === null) return null;
  const status = (after as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

export function extractProjectId(
  eventClass: NotificationEventClass,
  row: AuditLogRow | null,
): string | null {
  if (!row) return null;
  if (!PROJECT_SCOPED_EVENT_CLASSES.has(eventClass)) return null;
  // Where the project id lives on the audit row depends on the entity:
  //   - `project` rows: entityId IS the projectId.
  //   - `project_worker` rows: entityId is the project id per the
  //     ProjectCrudService convention (the worker assignment uses the
  //     project id as entity id so the feed renders "Projekt X ·
  //     Mitarbeiter Y zugewiesen" without a second lookup).
  //   - `attachment` rows: entityId is the ATTACHMENT id; the project id
  //     lives in the ancestor link (architecture.md §11.12). Use it so
  //     `includeAssignedWorkers` rules resolve against the right project.
  return row.entityType === 'attachment' ? row.ancestorEntityId : row.entityId;
}

export function ruleMatches(rule: NotificationRuleRow, afterStatus: string | null): boolean {
  if (!rule.enabled) return false;
  if (!TRANSITION_EVENT_CLASSES.has(rule.eventClass as NotificationEventClass)) {
    // Non-transition events ignore stateFilter.
    return true;
  }
  if (rule.stateFilter === null) return true;
  if (afterStatus === null) return false;
  return rule.stateFilter === afterStatus;
}

export async function resolveRecipients(
  db: Database,
  rules: NotificationRuleRow[],
  projectId: string | null,
): Promise<string[]> {
  if (rules.length === 0) return [];

  // Collect the three additive channels across every matching rule.
  const roleSet = new Set<string>();
  let anyAssignedWorkers = false;
  const explicitUserIds = new Set<string>();

  for (const rule of rules) {
    const spec = rule.recipientSpec as NotificationRecipientSpec;
    for (const r of spec.roles) roleSet.add(r);
    if (spec.includeAssignedWorkers) anyAssignedWorkers = true;
    for (const u of spec.userIds) explicitUserIds.add(u);
  }

  const candidateIds = new Set<string>();

  // 1. Role-expansion: every active user holding one of the listed
  //    roles. roles is a text[] column; `&&` is Postgres's array-overlap
  //    operator.
  if (roleSet.size > 0) {
    const roleList = Array.from(roleSet);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`${users.roles} && ARRAY[${sql.join(
          roleList.map((r) => sql`${r}`),
          sql`, `,
        )}]::text[] AND ${eq(users.active, true)}`,
      );
    for (const row of rows) candidateIds.add(row.id);
  }

  // 2. Assigned-worker expansion: only meaningful when the event is
  //    project-scoped AND a projectId is known.
  if (anyAssignedWorkers && projectId !== null) {
    const rows = await db
      .select({ userId: projectWorkers.userId })
      .from(projectWorkers)
      .innerJoin(users, eq(users.id, projectWorkers.userId))
      .where(and(eq(projectWorkers.projectId, projectId), eq(users.active, true)));
    for (const row of rows) candidateIds.add(row.userId);
  }

  // 3. Explicit userIds — resolved against the users table with the
  //    active filter. A bogus id (not matching any row) OR an inactive
  //    user is silently skipped per AC-192 / AC-203. The validator
  //    (AC-190(e)) rejects these at rule-create time; this filter is
  //    the safety net for the post-create deactivate/delete path.
  if (explicitUserIds.size > 0) {
    const ids = Array.from(explicitUserIds);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.active, true)));
    for (const row of rows) candidateIds.add(row.id);
  }

  return Array.from(candidateIds);
}

export async function filterUnmutedUserIds(db: Database, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.pushMuted, false), eq(users.active, true)));
  return rows.map((r) => r.id);
}
