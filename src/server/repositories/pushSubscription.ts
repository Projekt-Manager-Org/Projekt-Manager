import { and, eq, ne } from 'drizzle-orm';
import type { TransactionalDatabase } from '../db/connection.js';
import { pushSubscriptions } from '../db/schema.js';

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
