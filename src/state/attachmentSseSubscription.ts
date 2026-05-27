/**
 * Cross-cutting subscription that refreshes the attachment caches on
 * every `attachment_changed` SSE frame (api.md §14.2.13, ADR-0025,
 * AC-336 / AC-337). Closes the gallery cross-user view-sync gap (#237):
 * before this, `attachmentStore` fetched once on mount and never again,
 * so an always-open gallery never saw another user's add / hide /
 * restore / purge.
 *
 * `attachmentStore` holds two per-project caches:
 *   - `byProject` — the live (`status = 'ready'`) gallery / binary list.
 *   - `hiddenByProject` — the Papierkorb (owner / office only),
 *     populated lazily on tab open.
 *
 * The event carries no payload (architecture.md §11.13 — invalidation
 * hint only, per-project scoping deliberately out of scope), so the
 * handler refetches every project the user has already loaded. Trash is
 * refetched only for projects whose Papierkorb has been opened (a key
 * exists in `hiddenByProject`); a 403 for a non-privileged caller is
 * absorbed by `fetchTrashForProject`.
 *
 * Auth lifetime is the correct boundary; the auth-gated `useEffect` in
 * `App.tsx` is the only correct entry point — opening `/api/events`
 * before the session cookie is set lands on the server's `authenticate`
 * preHandler with no cookie, returns 401, and per WHATWG the
 * EventSource transitions to CLOSED with no spec-mandated reconnect
 * (same reasoning as `projectSseSubscription.ts` /
 * `invoiceSseSubscription.ts`).
 */

import { useAttachmentStore } from './attachmentStore';
import { ATTACHMENT_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

export function subscribeAttachmentStoreToSse(): () => void {
  return onSseEvent(ATTACHMENT_CHANGED, () => {
    const state = useAttachmentStore.getState();
    for (const projectId of Object.keys(state.byProject)) {
      void state.fetchForProject(projectId);
    }
    for (const projectId of Object.keys(state.hiddenByProject)) {
      void state.fetchTrashForProject(projectId);
    }
  });
}
