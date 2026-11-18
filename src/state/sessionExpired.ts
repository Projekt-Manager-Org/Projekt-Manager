/**
 * Shared session-expiry handler for all stores.
 *
 * Every store that calls the API must delegate session-expiry detection
 * to the auth store. This one-liner was duplicated across five stores;
 * centralizing it removes the noise without adding abstraction.
 */

import { useAuthStore } from './authStore';

export function handleSessionExpired(): void {
  useAuthStore.getState().handleSessionExpired();
}
