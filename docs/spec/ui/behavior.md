# UI: Behavior

Section 9 of the [product spec](../index.md) — cross-cutting behavioral rules that apply across views.

---

## 9. Behavioral Rules

### 9.4 Authentication Behavior

- On app load, the client checks for an existing valid session. If valid → load authenticated view. If expired or absent → login screen.
- After successful login, the client fetches the full project list and renders the default view (Kanban).
- Logout clears the local session and returns to the login screen.
- Session expiry while the app is open (detected by an API request returning an authentication error) → redirect to login with message: `"Sitzung abgelaufen. Bitte erneut anmelden."` **[C]**
- The login screen is the **only** view available to unauthenticated users. No project data is accessible without authentication.
- After logout, the browser back button must **not** reveal project data.

### 9.5 Asynchronous Mutation Behavior

Mutations (state transitions, date updates, creates, edits) go through the API (see [API](../api.md)). The UI must handle:

- **Loading state**: brief indicator (disabled button, spinner) while mutation is in flight. No double-submit on the same project.
- **Optimistic update**: the UI may update locally before the server responds, but must reconcile with the server response (revert on failure).
- **Error feedback**: failed mutation shows German-language error message, reverts local state. `"Änderung fehlgeschlagen. Bitte erneut versuchen."` **[C]**
- **In-flight mutation lock**: while a create, edit, or state-changing request is in flight for a form or dialog, the submit action is disabled, every input in the form is disabled, and the enclosing modal cannot be closed by the user (Escape, close button, backdrop). The lock also covers any user-confirmation dialog that precedes the request dispatch, so a submit initiated behind an open confirmation dialog cannot fire a second time. The lock releases when the request resolves (success or failure).
- **Stale-write recovery**: a versioned edit ([data-model.md §6.4](../data-model.md#64-concurrency)) carries the entity version its edit started from — the version displayed when the form or the confirmation dialog opened, advanced only by the form's own successful save. A background refresh (realtime invalidation, refetch) never advances it. A `VERSION_CONFLICT` response (see [api.md §14.4](../api.md#144-error-handling)) refetches the entity, resets the form to the refetched values, and surfaces `"Inzwischen geändert. Die aktuelle Fassung wurde geladen – bitte erneut versuchen."` **[C]** via the mutation error banner. No auto-retry, no merge.
- **Idempotency-conflict recovery**: a response with the idempotency-conflict error code (see [api.md §14.4](../api.md#144-error-handling)) closes the create form, refreshes the affected list so the stored row becomes visible, and surfaces the German error message via the mutation error banner. The form does not auto-retry.

### 9.6 Theme Handling

The application renders in light or dark color scheme based on the user's theme preference (see [data-model.md §5.7](../data-model.md#57-user-theme-preference)).

- **Authoritative source**: the server value on `UserAccount.themePreference`. The client mirrors the preference value locally only to avoid a flash of the wrong theme on page load.
- **Local cache semantics**: the cache holds the preference value (`'light' | 'dark' | 'system'`), not the resolved light/dark scheme. When the cached value is `'system'`, the client resolves the scheme from the operating system at each render.
- **Initial resolution** (before first paint): the client reads its local cache; if absent, it falls back to the operating-system `prefers-color-scheme`. This runs before themed content is first painted.
- **Session hydration**: after the authenticated session is established, the client replaces the local cache with the server value and re-applies the theme.
- **`'system'` mode**: the client subscribes to operating-system color-scheme changes and updates the UI without a reload.
- **Updates**: the user selects a theme via the user menu ([index.md §8.7.2](index.md#872-user-menu)). The selection is sent to the server via the self-update operation ([api.md §14.2.1](../api.md#1421-authentication)) and applied optimistically — a failed mutation reverts the local theme per [§9.5](#95-asynchronous-mutation-behavior).
- **Unauthenticated screens**: the login screen and insecure banner follow the client's initial resolution (local cache or operating-system preference); no server value is available yet.
- **Logout and session expiry**: the local cache is retained across logout so the returning user does not see a theme flash at the login screen. Logging in as a different user replaces the cache on the next session hydration.

### 9.7 Modal Interaction

All modals close on Escape (equivalent to the cancel action). Form modals submit the primary action on Enter when focus is within the form. Modals without a primary action — read-only detail views, success-state confirmations — accept Escape but do not submit on Enter.

Form modals and confirmation dialogs do not close on backdrop click — only via Escape or the explicit cancel action. Non-editing side panels close on backdrop click as the cancel equivalent.

While a mutation is in flight, close paths (Escape, explicit cancel, close button, backdrop) are suspended per the in-flight mutation lock in [§9.5](#95-asynchronous-mutation-behavior).

### 9.8 Push Notifications

The application never auto-requests the browser push permission. The prompt is raised only as the direct result of a user activation on the opt-in affordance ([index.md §8.7.2](index.md#872-user-menu)). Auto-request on page load is forbidden — a denied permission has no in-app remediation (the user must reset it via browser settings), so the request surface must be deliberate.

- **Opt-in flow.** The user activates `Push-Benachrichtigungen aktivieren`. The client requests browser permission, obtains the device's subscription handle, and posts it via subscribe ([api.md §14.2.10](../api.md#14210-push-subscription)). On success, the affordance re-renders as a registered-device indicator with `Gerät abmelden`. If registration fails (network error, server 5xx), the button remains, an error notification appears, and the user can retry.
- **Mute toggle.** `Stummschalten` reflects `pushMuted`. Applied optimistically via self-update ([api.md §14.2.1](../api.md#1421-authentication)); reverts on failure per [§9.5](#95-asynchronous-mutation-behavior). Mute retains the subscription — unmuting restores delivery without another browser prompt.
- **Unsubscribe.** `Gerät abmelden` removes the current device's subscription ([api.md §14.2.10](../api.md#14210-push-subscription)). Other registered devices remain subscribed. Optimistic UI hides the affordance on click; on failure (network error, 5xx) it returns with an error notification, the subscription remains registered, and a retry succeeds per [§9.5](#95-asynchronous-mutation-behavior).
- **Permission denied / unsupported.** If the browser denies permission or web push is unsupported, the affordance is replaced by an informational German cue pointing at browser settings; no retry, no re-prompt on later sessions.
