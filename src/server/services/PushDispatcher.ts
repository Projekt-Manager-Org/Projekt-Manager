/**
 * Push dispatcher — ADR-0023.
 *
 * Interface + no-op fallback. The real `web-push` transport lives in
 * the sibling `WebPushDispatcher.ts` and is selected by `buildApp`
 * when all three `VAPID_*` env vars are present; otherwise the
 * composition falls back to the `noopPushDispatcher` exported here
 * (also what tests use by default via the absent-env path).
 *
 * Key generation — operators mint a keypair with
 *   npx web-push generate-vapid-keys --json
 * and persist the public/private into the deploy environment. The server
 * NEVER generates keys at runtime — doing so would rotate subscriptions
 * away on every restart.
 *
 * A `410 Gone` / `404 Not Found` response from the push endpoint means
 * the subscription is permanently dead; the dispatcher returns
 * `'gone'` and the caller prunes the subscription row.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/connection.js';
import { pushSubscriptions } from '../db/schema.js';

export interface PushSubscriptionTarget {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushDispatchStatus = 'ok' | 'gone' | 'error';

export interface PushDispatchResult {
  subscriptionId: string;
  status: PushDispatchStatus;
  error?: string;
}

/**
 * Transport abstraction. A production implementation calls
 * `web-push.sendNotification`; the default noop records attempts and
 * always returns 'ok' so tests can assert recipient resolution without
 * a real browser-side endpoint.
 */
export interface PushDispatcher {
  send(target: PushSubscriptionTarget, payload: PushPayload): Promise<PushDispatchStatus>;
}

/**
 * Wire-format payload sent through the push transport (web-push) and
 * read by the service worker (`src/sw/pushHandlers.ts`, bundled into
 * `dist/sw.js`). The service worker
 * surfaces `title` / `body` / `url` to the user; `eventClass` and
 * `auditEntryId` are diagnostic aids visible in browser devtools and
 * useful for any future click-routing or telemetry.
 *
 * AC-211 pins title/body/url as user-facing strings — the publisher
 * composes them via `pushPayloadComposer` before dispatch.
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  eventClass: string;
  auditEntryId: string | null;
}

/** No-op dispatcher used in tests and when VAPID keys are absent. */
export const noopPushDispatcher: PushDispatcher = {
  async send(_target, _payload) {
    return 'ok';
  },
};

/**
 * Resolve every subscription row owned by the given user ids, then ask
 * the dispatcher to deliver the payload. Dead subscriptions (410/404)
 * are pruned in-place — AC-196 "dispatch-time pruning".
 *
 * Returns the per-subscription results so the caller (publisher) can
 * log, or a future adapter can resurrect a rate-limited endpoint.
 */
export async function dispatchToSubscriptions(
  db: Database,
  dispatcher: PushDispatcher,
  userIds: string[],
  payload: PushPayload,
): Promise<PushDispatchResult[]> {
  if (userIds.length === 0) return [];

  const rows = await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, userIds));

  const results: PushDispatchResult[] = [];
  const deadIds: string[] = [];

  for (const row of rows) {
    try {
      const status = await dispatcher.send(row, payload);
      results.push({ subscriptionId: row.id, status });
      if (status === 'gone') deadIds.push(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ subscriptionId: row.id, status: 'error', error: message });
    }
  }

  // Prune dead subscriptions. This is housekeeping — a self-scope
  // delete keyed by (id, userId) so a caller cannot prune another
  // user's row even if a dispatcher mis-reports a 410.
  if (deadIds.length > 0) {
    await db.transaction(async (tx) => {
      for (const id of deadIds) {
        // userId check is redundant here (the row was just read), but
        // keeps the self-scope invariant explicit.
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        await tx
          .delete(pushSubscriptions)
          .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, row.userId)));
      }
    });
  }

  return results;
}
