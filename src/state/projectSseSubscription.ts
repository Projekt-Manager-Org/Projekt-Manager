/**
 * Cross-cutting subscription that refreshes both project stores on every
 * `project_changed` SSE frame (ADR-0025).
 *
 * Why a dedicated module rather than a `subscribe()` on one of the
 * project stores:
 *   - The handler must drive BOTH `useProjectStore` (kanban / calendar /
 *     detail) and `useProjectManagementStore` (management list). A
 *     `subscribe()` on either store would force the other to know about
 *     it, leaking the SSE concern across both slices.
 *   - The channel must be live regardless of which surface is currently
 *     mounted — an always-open observer parked on /projects is one
 *     scenario; a worker on /kanban is another. A single auth-lifetime
 *     subscription beats a per-surface refcount when the lifetime is
 *     "the whole authenticated page".
 *
 * Lifecycle: caller invokes once when `authUser` becomes truthy and runs
 * the returned unsubscribe when `authUser` becomes null. The auth-gated
 * `useEffect` in `App.tsx` is the only correct entry point — opening
 * `/api/events` before the session cookie is set lands on the server's
 * `authenticate` preHandler with no cookie, returns 401, and per WHATWG
 * the EventSource transitions to CLOSED with no spec-mandated reconnect.
 * That is the bug this module's docstring used to describe as "page
 * lifetime"; auth lifetime is the correct boundary.
 */

import { useProjectStore } from './projectStore';
import { useProjectManagementStore } from './projectManagementStore';
import { PROJECT_CHANGED } from '@/config/sseEvents';
import { onSseEvent } from '@/sse/client';

export function subscribeProjectStoresToSse(): () => void {
  return onSseEvent(PROJECT_CHANGED, () => {
    void useProjectStore.getState().fetchProjects();
    void useProjectManagementStore.getState().fetchProjects();
  });
}
