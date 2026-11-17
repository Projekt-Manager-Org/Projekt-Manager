/**
 * Push subscription repository — the `push_subscriptions` queries
 * (ADR-0023). Reads and deletes are scoped to a `userId`; the upsert moves
 * an endpoint another user holds to the caller (AC-656). The self-scope
 * rules live in `services/PushSubscriptionService.ts`, the dispatch in
 * `services/PushDispatcher.ts`.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { TransactionalDatabase } from '../db/connection.js';
import { pushSubscriptions } from '../db/schema.js';

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export interface PushSubscriptionValues {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

/**
 * Register `endpoint` for `userId`. An existing row for the endpoint
 * moves to `userId` and takes the new keys and user agent.
 */
export async function upsertPushSubscription(
  db: TransactionalDatabase,
  values: PushSubscriptionValues,
): Promise<PushSubscriptionRow | undefined> {
  const { userId, p256dh, auth, userAgent } = values;
  const [row] = await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh, auth, userAgent },
    })
    .returning();
  return row;
}

export async function deletePushSubscriptionByEndpoint(
  db: TransactionalDatabase,
  userId: string,
  endpoint: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function deletePushSubscriptionById(
  db: TransactionalDatabase,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)));
}

export async function findPushSubscriptionIdByEndpoint(
  db: TransactionalDatabase,
  userId: string,
  endpoint: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  return row;
}

export async function countPushSubscriptionsByUserId(
  db: TransactionalDatabase,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return row?.value ?? 0;
}

/** What a dispatch needs of every subscription the given users hold. */
export async function findPushTargetsByUserIds(
  db: TransactionalDatabase,
  userIds: string[],
): Promise<{ id: string; userId: string; endpoint: string; p256dh: string; auth: string }[]> {
  return db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));
}

/**
 * Remove a user's device registrations, optionally keeping the one with
 * `keepEndpoint` (the device a password change was made on, AC-676).
 * Scoped to `userId`: another user's registration is never touched,
 * even when `keepEndpoint` names it.
 */
export async function deletePushSubscriptionsByUserId(
  db: TransactionalDatabase,
  userId: string,
  keepEndpoint?: string,
): Promise<void> {
  const condition = keepEndpoint
    ? and(eq(pushSubscriptions.userId, userId), ne(pushSubscriptions.endpoint, keepEndpoint))
    : eq(pushSubscriptions.userId, userId);
  await db.delete(pushSubscriptions).where(condition);
}
