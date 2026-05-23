/**
 * Shared session-expiry handler for all stores.
 *
 * Every store that calls the API must delegate session-expiry detection
 * to the auth store. This one-liner was duplicated across five stores;
 * centralizing it removes the noise without adding abstraction.
 *
 * The override-with-users import path expects 401s on background fetches
 * (projectStore, SSE-driven refresh, etc.) the moment the text leg wipes
 * `users` and CASCADEs the operator's session. The orchestrator drives
 * the binary leg with a Bearer `importToken` instead, then surfaces a
 * summary the operator closes themselves — at which point the dialog
 * fires `handleSessionExpired` explicitly. Suppression bridges that
 * window so the global handler stays inert while the dialog owns the
 * redirect.
 */

import { useAuthStore } from './authStore';

let suppressionDepth = 0;

export function beginSessionExpiredSuppression(): void {
  suppressionDepth += 1;
}

export function endSessionExpiredSuppression(): void {
  if (suppressionDepth > 0) suppressionDepth -= 1;
}

export function handleSessionExpired(): void {
  if (suppressionDepth > 0) return;
  useAuthStore.getState().handleSessionExpired();
}
