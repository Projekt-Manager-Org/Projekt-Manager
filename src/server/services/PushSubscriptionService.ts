/**
 * Push subscription service — api.md §14.2.10, ADR-0023.
 *
 * Self-scope CRUD: `userId` is always derived from the authenticated
 * session (AC-196). A client-supplied id or endpoint that belongs to
 * another user is treated as unknown — the server returns the same
 * idempotent no-op that a truly-unknown input produces, so an attacker
 * cannot enumerate other users' subscriptions.
 *
 * Re-subscribing an endpoint UPDATES the existing row (ON CONFLICT)
 * rather than duplicating — the `push_subscriptions_user_endpoint_uq`
 * unique index enforces the invariant at the DB level.
 *
 * Writes land outside `mutate()` because push subscriptions are NOT in
 * `AuditEntityType` — they're transport state, not a domain entity. The
 * ADR-0021 type-gate is still honoured (a transaction is required for the
 * MutatingDatabase handle).
 */

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { pushSubscriptions } from '../db/schema.js';
import { validationError } from '../errors.js';
import { STRINGS } from '../../config/strings.js';

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
}

export interface PushSubscriptionResponse {
  id: string;
  endpoint: string;
  createdAt: string;
}

export class PushSubscriptionService {
  constructor(private db: Database) {}

  async subscribe(userId: string, input: SubscribeInput): Promise<PushSubscriptionResponse> {
    // Minimal structural validation — the browser-generated endpoint is
    // an opaque string, so length/shape is the only defensible check
    // outside a round-trip to the push server.
    if (
      typeof input.endpoint !== 'string' ||
      input.endpoint.length === 0 ||
      typeof input.keys?.p256dh !== 'string' ||
      input.keys.p256dh.length === 0 ||
      typeof input.keys?.auth !== 'string' ||
      input.keys.auth.length === 0
    ) {
      throw validationError(STRINGS.notifications.invalidPushSubscription);
    }

    // Upsert on (user_id, endpoint). If the row exists, update key
    // material + userAgent so the caller can rotate keys without
    // re-registering.
    const rows = await this.db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: {
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
        },
      })
      .returning();

    const row = rows[0]!;
    return {
      id: row.id,
      endpoint: row.endpoint,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Unsubscribe by endpoint. Self-scoped — filters by `userId` so the
   * caller can never remove another user's subscription.
   */
  async unsubscribeByEndpoint(userId: string, endpoint: string): Promise<void> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw validationError(STRINGS.notifications.invalidPushSubscription);
    }
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
  }

  /**
   * Unsubscribe by subscription id. Same self-scope behavior — an id
   * belonging to another user is treated as unknown (no-op). Avoids
   * the existence leak a 404 would produce.
   */
  async unsubscribeById(userId: string, id: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)));
  }

  /**
   * Prune a subscription the dispatcher reported permanently dead.
   * Scoped to `userId` so the caller cannot cross user boundaries even
   * if the subscription id originates from an untrusted source.
   */
  async prunePermanentlyDead(userId: string, subscriptionId: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, subscriptionId), eq(pushSubscriptions.userId, userId)));
  }

  /** Count the caller's subscriptions — used by tests for assertions. */
  async countForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return row?.value ?? 0;
  }
}
