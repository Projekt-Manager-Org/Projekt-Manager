/**
 * Push-notifications group for the user menu.
 *
 * Rendering contract (spec ui/index.md §8.7.2, verification.md §15.24):
 *   - The opt-in affordance appears iff (browser permission !== 'denied'
 *     AND no subscription is registered on this device).
 *   - The `Stummschalten` toggle is always visible; it reflects
 *     `UserAccount.pushMuted` regardless of subscription state (a user
 *     may mute on a device they are not subscribed on).
 *   - The unsubscribe affordance appears iff a subscription is active
 *     on this device.
 *   - When the browser lacks Web Push (feature detection) the section
 *     collapses to a single informational hint — no interactive
 *     affordances at all. Denied permission renders the distinct
 *     "unblock in browser settings" hint. Missing VAPID config is
 *     surfaced AFTER a click, so the user's deliberate action still
 *     produces a clear explanation rather than being silently swallowed.
 *
 * Hard rules:
 *   - `Notification.requestPermission()` is triggered ONLY from the
 *     click handler of the opt-in button (AC-201). We do NOT call it
 *     on mount, on user menu open, or on hover.
 *   - The Service Worker is registered eagerly at SPA boot
 *     (`src/main.tsx`) because it also intercepts
 *     `/encrypted-storage/*` for binary attachment decryption
 *     (ADR-0024). This module reads the existing registration via
 *     `navigator.serviceWorker.ready`.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/state/authStore';
import { STRINGS } from '@/config/strings';
import {
  getCurrentSubscription,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/pwa/pushClient';
import styles from './PushSubscriptionControls.module.css';

type PushPermissionState = 'default' | 'granted' | 'denied';

function readPermission(): PushPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default';
  const value = window.Notification.permission;
  if (value === 'granted' || value === 'denied' || value === 'default') return value;
  return 'default';
}

export function PushSubscriptionControls() {
  const authUser = useAuthStore((s) => s.authUser);
  const updatePushMuted = useAuthStore((s) => s.updatePushMuted);

  const supported = isPushSupported();

  const [permission, setPermission] = useState<PushPermissionState>(() =>
    supported ? readPermission() : 'default',
  );
  const [hasSubscription, setHasSubscription] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Read the current subscription state once on mount. This is a pure
  // local query against the ServiceWorkerRegistration — it does NOT
  // trigger a permission prompt, does NOT register the worker, and
  // does NOT make any network call. `getRegistration()` returns
  // `undefined` on first load (worker was never registered), which
  // maps to `hasSubscription = false`.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      const sub = await getCurrentSubscription().catch(() => null);
      if (!cancelled) setHasSubscription(sub !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const handleOptIn = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const result = await subscribeToPush();
      // Re-read permission after the prompt — it may have flipped to
      // 'denied' (user clicked "Block") or 'granted' (success).
      setPermission(readPermission());
      if (result.ok) {
        setHasSubscription(true);
        return;
      }
      if (result.reason === 'permission-denied') {
        // UI re-renders against the new `denied` state; no error row
        // needed — the denied hint IS the feedback.
        return;
      }
      if (result.reason === 'permission-dismissed') {
        // User closed the prompt without answering. No state change;
        // the opt-in affordance stays visible for another try.
        return;
      }
      if (result.reason === 'unsupported') {
        setErrorMessage(STRINGS.push.unsupported);
        return;
      }
      if (result.reason === 'not-configured') {
        setErrorMessage(STRINGS.push.notConfigured);
        return;
      }
      if (result.reason === 'subscribe-failed') {
        // The browser refused the subscription (e.g. its push service is
        // unreachable) or returned one without keys. pushClient already
        // rolled back any partial state — surface an actionable error so
        // the user can retry instead of seeing a silent no-op (AC-653).
        setErrorMessage(STRINGS.push.subscribeFailed);
        return;
      }
      setErrorMessage(result.message ?? STRINGS.push.subscribeFailed);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleUnsubscribe = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await unsubscribeFromPush();
      setHasSubscription(false);
    } catch {
      setErrorMessage(STRINGS.errors.mutationFailed);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleMuteToggle = useCallback(
    (next: boolean) => {
      // Fire-and-forget: the store handles optimistic update and
      // revert-on-failure, mirroring the theme-preference pattern
      // (AC-754). A failed mutation flips the toggle back when the
      // store state propagates here via the selector.
      void updatePushMuted(next);
    },
    [updatePushMuted],
  );

  // Gate the entire group on sign-in — push is a user-level preference.
  if (!authUser) return null;

  // Unsupported browser: hide every interactive affordance, show only
  // the informational hint. The `Stummschalten` toggle is also gated
  // here because the server-side mute still works, but a mute toggle
  // on a device that cannot receive push is confusing UX — better to
  // surface the capability gap and let the user manage mute from a
  // supported device.
  if (!supported) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionLabel}>{STRINGS.push.section}</div>
        <div className={styles.hint} data-testid="push-unsupported">
          {STRINGS.push.unsupported}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>{STRINGS.push.section}</div>

      {permission !== 'denied' && !hasSubscription && (
        <button
          type="button"
          className={styles.item}
          onClick={handleOptIn}
          disabled={busy}
          data-testid="push-opt-in-button"
        >
          {STRINGS.push.enable}
        </button>
      )}

      {permission === 'denied' && (
        <div className={styles.hint} data-testid="push-denied-hint">
          {STRINGS.push.denied}
        </div>
      )}

      {hasSubscription && (
        <button
          type="button"
          className={styles.item}
          onClick={handleUnsubscribe}
          disabled={busy}
          data-testid="push-unsubscribe-button"
        >
          {STRINGS.push.unsubscribe}
        </button>
      )}

      <label className={styles.toggleRow}>
        <span>{STRINGS.push.mute}</span>
        <input
          type="checkbox"
          className={styles.toggleInput}
          checked={authUser.pushMuted}
          onChange={(e) => handleMuteToggle(e.target.checked)}
          disabled={busy}
          data-testid="push-mute-toggle"
        />
      </label>

      {errorMessage && (
        <div className={styles.hint} role="alert" data-testid="push-error">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
