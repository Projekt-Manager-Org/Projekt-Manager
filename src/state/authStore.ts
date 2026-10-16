/**
 * Authentication state — login, logout, session management.
 *
 * Separated from project and UI state so auth concerns don't
 * pollute other stores, and so the login flow can be tested independently.
 */

import { create } from 'zustand';
import { authApi, type AuthUser } from '@/api/client';
import { STRINGS } from '@/config/strings';
import { THEME_PREFERENCE_KEY, type ThemePreference } from '@/config/themeStorage';
import { applyThemePreference } from '@/styles/themeRuntime';
import type { BackupStatus } from '@/domain/backupBadge';
import { useProjectStore } from './projectStore';
import { useUIStore } from './uiStore';
import { useCustomerStore } from './customerStore';
import { useUserStore } from './userStore';
import { useProjectManagementStore } from './projectManagementStore';
import { useExportJobStore } from './exportJobStore';
import { useImportJobStore } from './importJobStore';

interface AuthState {
  authUser: AuthUser | null;
  authError: string | null;
  sessionChecked: boolean;
  /**
   * Backup-freshness status attached to the authenticated session. The
   * server only includes this for callers with role `owner`
   * (verification.md AC-170). `undefined` means either "not an owner"
   * or "status source unreachable"; the badge component treats the
   * latter as the "Status unbekannt" branch and non-owner UI never
   * reads this field.
   */
  backupStatus: BackupStatus | undefined;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  handleSessionExpired: () => void;
  updateThemePreference: (value: ThemePreference) => Promise<void>;
  updatePushMuted: (value: boolean) => Promise<void>;
}

/**
 * Normalize a server-returned user profile so optional fields the
 * client relies on always carry a defined value.
 *
 * The login endpoint (api.md §14.2.1) historically did not include
 * `pushMuted` in its response — only `/api/auth/me` and PATCH /me did.
 * The data-model default for a fresh user is `false`
 * (data-model.md §5.3), so a missing value maps to `false` here. This
 * is a client-side safety net; the authoritative value still arrives
 * via the next `/api/auth/me` hydration and wins on reconciliation.
 */
function normalizeAuthUser(user: AuthUser): AuthUser {
  return {
    ...user,
    pushMuted: typeof user.pushMuted === 'boolean' ? user.pushMuted : false,
  };
}

/**
 * Write the theme preference to localStorage. Extracted so the optimistic
 * update and the revert path stay symmetric — both need to tolerate the
 * occasional localStorage throw (private-browsing, sandboxed contexts).
 */
function writeCachedPreference(value: ThemePreference | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) {
      window.localStorage.removeItem(THEME_PREFERENCE_KEY);
    } else {
      window.localStorage.setItem(THEME_PREFERENCE_KEY, value);
    }
  } catch {
    // Swallow — the in-memory state still reflects the user's choice; a
    // cache failure only costs a flash on next reload.
  }
}

function readCachedPreference(): ThemePreference | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Same rationale as above.
  }
  return null;
}

/**
 * Reset downstream state when the user is no longer authenticated.
 *
 * Runs for BOTH the interactive logout path AND the
 * handleSessionExpired path — before this fix, only the interactive
 * logout cleared downstream stores, so a mid-session expiry left the
 * project list, selected project, filter, and view state populated in
 * memory. That data was re-rendered the instant the next user logged
 * in, a same-tab cross-session leak that the review (C F-6) flagged
 * as a latent privacy concern.
 *
 * The reset covers payload data (projects, customers, ...) AND the
 * view's filter/sort/search state. The latter is store-owned for the
 * management surfaces (so SSE / post-mutation refreshes keep the
 * user's view intact); a logout that left it behind would let user A's
 * "show archived + filter by Anna + sort by Title desc" preferences
 * survive into user B's first paint on the same browser.
 *
 * Kept inside authStore rather than imported from store.ts to avoid
 * the circular-via-barrel pattern: projectStore already imports
 * authStore for handleSessionExpired, and a second path through
 * store.ts would add another leg to the cycle for no gain.
 */
function clearDownstreamState(): void {
  useProjectStore.setState({
    projects: [],
    mutationInFlight: {},
    mutationError: null,
  });
  useUIStore.setState({
    selectedProjectId: null,
    filterNoDates: false,
    activeView: 'kanban',
  });
  useCustomerStore.setState({
    customers: [],
    total: 0,
    loading: false,
    error: null,
    search: '',
    sortBy: 'name',
    sortDir: 'asc',
  });
  useUserStore.setState({
    users: [],
    total: 0,
    loading: false,
    error: null,
  });
  useProjectManagementStore.setState({
    projects: [],
    customers: [],
    workers: [],
    loading: false,
    error: null,
    showArchived: false,
    assignedWorkerIds: [],
    includeUnassigned: false,
    search: '',
    sortBy: null,
    sortDir: 'asc',
  });
  // The data-exchange job stores hold a module-singleton `job` (and the
  // import side a dismissed-job marker) that would otherwise survive into the
  // next operator's first paint on the same tab — an inline export-download
  // link or an auto-opened import summary for the PRIOR user. Reset them here
  // too (the mount-time probe re-attaches the new user's job server-side).
  useExportJobStore.getState().reset();
  useImportJobStore.getState().reset();
  // No audit-store reset: the factory-based `createAuditStore()` yields
  // per-component instances (see `src/state/auditStore.ts`), so audit
  // state dies with the `ActivityFeed` / `AuditManagement` components
  // on logout-triggered unmount. Touching a singleton here would re-
  // introduce the shared-state coupling the factory split was built
  // to eliminate.
}

export const useAuthStore = create<AuthState>((set, get) => ({
  authUser: null,
  authError: null,
  sessionChecked: false,
  backupStatus: undefined,

  login: async (username: string, password: string) => {
    set({ authError: null });

    const result = await authApi.login(username, password);

    if (!result.ok) {
      set({ authError: result.error.message || STRINGS.auth.loginFailed });
      return;
    }

    // Spec §9.6: after the authenticated session is established, the
    // client replaces the local cache with the server value and re-applies
    // the theme. Login is one of the two session-establishment paths
    // (checkSession is the other) so the same hydration rule applies.
    writeCachedPreference(result.data.user.themePreference);
    applyThemePreference(result.data.user.themePreference);

    set({
      authUser: normalizeAuthUser(result.data.user),
      authError: null,
      // `backupStatus` is only included by the server for owner callers
      // (verification.md AC-170). The envelope is typed as optional, so
      // a missing field lands here as `undefined` and the badge
      // component stays hidden for non-owners without a second branch.
      backupStatus: result.data.backupStatus,
    });
  },

  logout: async () => {
    await authApi.logout();
    set({
      authUser: null,
      authError: null,
      backupStatus: undefined,
    });
    clearDownstreamState();
  },

  checkSession: async () => {
    const result = await authApi.me();

    if (!result.ok) {
      set({ authUser: null, sessionChecked: true, backupStatus: undefined });
      return;
    }

    // /api/auth/me returns `{ user: { ... } }` — same envelope as
    // /api/auth/login (consolidation review E F-7). The shape is
    // still untrusted at runtime (the server is reasonable but this
    // is a network boundary), so validate the critical string fields
    // before committing to the store — the same defensive shape the
    // pre-envelope version kept.
    const user = result.data?.user;
    if (user && typeof user.username === 'string' && typeof user.displayName === 'string') {
      // Spec §9.6 / AC-120: the server value is authoritative. On
      // hydration, overwrite any stale localStorage cache and re-apply
      // the scheme so a cache mismatch does not survive the round-trip.
      if (
        user.themePreference === 'light' ||
        user.themePreference === 'dark' ||
        user.themePreference === 'system'
      ) {
        writeCachedPreference(user.themePreference);
        applyThemePreference(user.themePreference);
      }
      set({
        authUser: normalizeAuthUser(user),
        sessionChecked: true,
        backupStatus: result.data.backupStatus,
      });
    } else {
      set({ sessionChecked: true });
    }
  },

  handleSessionExpired: () => {
    set({
      authUser: null,
      authError: STRINGS.auth.sessionExpiredLogin,
      sessionChecked: true,
      backupStatus: undefined,
    });
    clearDownstreamState();
  },

  /**
   * Self-update the user's color-scheme preference.
   *
   * Spec §9.6: applied optimistically, reconciled with the server response,
   * reverted on failure. The UI must flip before the round-trip completes
   * (AC-119). The optimistic leg updates:
   *   1. The in-memory `authUser.themePreference`,
   *   2. The localStorage cache (so a reload without a new session
   *      hydration still paints the chosen scheme via the pre-paint
   *      script in public/theme-init.js),
   *   3. The document root via `applyThemePreference`.
   *
   * On success the server-returned user replaces the optimistic one. On
   * failure all three of the above are reverted to the pre-click state,
   * and the error is surfaced via the projectStore mutation-error banner
   * (spec §9.5) — the same mechanism other failed mutations use.
   */
  updateThemePreference: async (value: ThemePreference) => {
    const previousUser = get().authUser;
    if (!previousUser) return;
    const previousPreference = previousUser.themePreference;
    if (previousPreference === value) return;
    const previousCache = readCachedPreference();

    // --- Optimistic leg ----------------------------------------------------
    set({ authUser: { ...previousUser, themePreference: value } });
    writeCachedPreference(value);
    applyThemePreference(value);

    const result = await authApi.updateSelf({ themePreference: value });

    if (!result.ok) {
      // Revert the optimistic local state FIRST so the login screen
      // (or whichever view the user lands on) reflects the last
      // server-authoritative value, not a theme the server never
      // accepted. This applies to both the session-expired and the
      // generic-error branches.
      set({ authUser: { ...previousUser, themePreference: previousPreference } });
      writeCachedPreference(previousCache);
      applyThemePreference(previousPreference);

      if (result.sessionExpired) {
        get().handleSessionExpired();
        return;
      }
      // Surface the server-supplied message (or the canonical German
      // fallback for empty-message paths). Reuses the projectStore
      // mutation-error banner so the feedback surface stays consistent
      // with spec §9.5.
      useProjectStore.setState({
        mutationError: result.error.message || STRINGS.errors.mutationFailed,
      });
      return;
    }

    // --- Reconcile with server response -----------------------------------
    // Replace the optimistic user with the server-returned profile so any
    // other server-authoritative fields on the projection stay in sync.
    // Defensive shape check matches checkSession above.
    const serverUser = result.data?.user;
    if (
      serverUser &&
      typeof serverUser.username === 'string' &&
      typeof serverUser.displayName === 'string'
    ) {
      set({ authUser: normalizeAuthUser(serverUser) });
      writeCachedPreference(serverUser.themePreference);
      applyThemePreference(serverUser.themePreference);
    }
  },

  /**
   * Self-update the user's push-mute flag.
   *
   * Spec ui/behavior.md §9.8 + §9.5: applied optimistically, reverts on
   * failure. Same shape as `updateThemePreference` above — the only
   * fields that diverge are the local-cache side effects (pushMuted has
   * none; the server value is the single source of truth).
   */
  updatePushMuted: async (value: boolean) => {
    const previousUser = get().authUser;
    if (!previousUser) return;
    if (previousUser.pushMuted === value) return;

    // --- Optimistic leg ----------------------------------------------------
    set({ authUser: { ...previousUser, pushMuted: value } });

    const result = await authApi.updateSelf({ pushMuted: value });

    if (!result.ok) {
      // Revert to the pre-click state. Match the theme-preference
      // handler: surface the session-expired path through the central
      // helper so the UI bounces to the login screen, and surface
      // every other failure via the mutation-error banner.
      set({ authUser: previousUser });

      if (result.sessionExpired) {
        get().handleSessionExpired();
        return;
      }
      useProjectStore.setState({
        mutationError: result.error.message || STRINGS.errors.mutationFailed,
      });
      return;
    }

    // Reconcile with the server-returned profile. Defensive shape check
    // matches `checkSession` and `updateThemePreference`.
    const serverUser = result.data?.user;
    if (
      serverUser &&
      typeof serverUser.username === 'string' &&
      typeof serverUser.displayName === 'string'
    ) {
      set({ authUser: normalizeAuthUser(serverUser) });
    }
  },
}));

/**
 * Standalone password-change action. Does not affect auth state (the session
 * stays valid), so it lives outside the store. UI components can import this
 * instead of reaching for @/api/client directly.
 */
export async function changePassword(currentPassword: string, newPassword: string) {
  const result = await authApi.changePassword(currentPassword, newPassword);
  if (!result.ok && result.sessionExpired) {
    useAuthStore.getState().handleSessionExpired();
  }
  return result;
}
