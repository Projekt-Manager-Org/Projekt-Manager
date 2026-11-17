/**
 * Notification rule repository — data-model.md §5.11, ADR-0023.
 *
 * Rule mutations do NOT route through `mutate()` (ADR-0023 §Decision:
 * rule changes are administrative config, not audited domain events).
 * Write functions therefore accept `TransactionalDatabase` — the same
 * type reads use — rather than `MutatingDatabase`, the handle
 * `services/mutate.ts` mints for audited entities. Reads take a plain
 * `Database` or transaction handle.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { Database, TransactionalDatabase } from '../db/connection.js';
import { notificationRule } from '../db/schema.js';
import type {
  NotificationEventClass,
  NotificationRecipientSpec,
} from '../../domain/notifications.js';

/** Database row shape. */
export type NotificationRuleRow = typeof notificationRule.$inferSelect;

/** API-facing rule shape (camelCase, ISO timestamps). */
export interface NotificationRuleResponse {
  id: string;
  eventClass: NotificationEventClass;
  stateFilter: string | null;
  recipientSpec: NotificationRecipientSpec;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export function toRuleResponse(row: NotificationRuleRow): NotificationRuleResponse {
  return {
    id: row.id,
    eventClass: row.eventClass as NotificationEventClass,
    stateFilter: row.stateFilter ?? null,
    recipientSpec: row.recipientSpec as NotificationRecipientSpec,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
  };
}

/** List every rule. Ordered by eventClass, then createdAt for determinism. */
export async function listRules(db: Database): Promise<NotificationRuleResponse[]> {
  const rows = await db
    .select()
    .from(notificationRule)
    .orderBy(asc(notificationRule.eventClass), asc(notificationRule.createdAt));
  return rows.map(toRuleResponse);
}

/** Read every enabled rule for a given event class. Used by the publisher. */
export async function listEnabledRulesForEventClass(
  db: TransactionalDatabase,
  eventClass: NotificationEventClass,
): Promise<NotificationRuleRow[]> {
  return db
    .select()
    .from(notificationRule)
    .where(and(eq(notificationRule.eventClass, eventClass), eq(notificationRule.enabled, true)));
}

export async function findRuleById(
  db: TransactionalDatabase,
  id: string,
): Promise<NotificationRuleRow | null> {
  const rows = await db.select().from(notificationRule).where(eq(notificationRule.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertRule(
  db: TransactionalDatabase,
  data: {
    eventClass: NotificationEventClass;
    stateFilter: string | null;
    recipientSpec: NotificationRecipientSpec;
    enabled: boolean;
    createdBy: string | null;
    updatedBy: string | null;
  },
): Promise<NotificationRuleRow> {
  const rows = await db
    .insert(notificationRule)
    .values({
      eventClass: data.eventClass,
      stateFilter: data.stateFilter,
      recipientSpec: data.recipientSpec,
      enabled: data.enabled,
      createdBy: data.createdBy,
      updatedBy: data.updatedBy,
    })
    .returning();
  return rows[0]!;
}

export async function updateRule(
  db: TransactionalDatabase,
  id: string,
  actorId: string,
  patch: {
    eventClass?: NotificationEventClass;
    stateFilter?: string | null;
    recipientSpec?: NotificationRecipientSpec;
    enabled?: boolean;
  },
): Promise<NotificationRuleRow | null> {
  const setClause: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: actorId,
  };
  if (patch.eventClass !== undefined) setClause.eventClass = patch.eventClass;
  if ('stateFilter' in patch) setClause.stateFilter = patch.stateFilter;
  if (patch.recipientSpec !== undefined) setClause.recipientSpec = patch.recipientSpec;
  if (patch.enabled !== undefined) setClause.enabled = patch.enabled;

  const rows = await db
    .update(notificationRule)
    .set(setClause)
    .where(eq(notificationRule.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteRule(db: TransactionalDatabase, id: string): Promise<boolean> {
  const rows = await db
    .delete(notificationRule)
    .where(eq(notificationRule.id, id))
    .returning({ id: notificationRule.id });
  return rows.length > 0;
}
