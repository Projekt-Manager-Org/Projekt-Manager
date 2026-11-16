/**
 * Push client — encapsulates browser-side push subscription plumbing.
 *
 * Responsibilities (spec verification.md §15.24, ui/index.md §8.7.2):
 *   - Feature detection (`serviceWorker` + `PushManager`).
 *   - `Notification.requestPermission()` is called ONLY from inside a
 *     user-click handler (AC-201). This module exposes primitives; the
 *     caller is responsible for invoking them from a user-activation
 *     handler.
 *   - Subscribe / unsubscribe against the browser's push manager and
 *     forward the result to the self-scope server endpoints (AC-654).
 *
 * Service Worker registration: eager at SPA boot (`src/main.tsx`).
 * The SW intercepts `/encrypted-storage/*` requests for binary
 * attachment decryption (ADR-0024) and must be active before any
 * `<img src="/encrypted-storage/...">` renders. AC-201's rule applies to
 * the OS permission prompt, not to `register()`, which is silent.
 *
 * VAPID public-key source: `GET /api/push/vapid-public-key` at subscribe
 * time. The server derives the public key from `VAPID_PRIVATE_KEY` at
 * boot, so the operator maintains a single env var. A missing or empty
 * key surfaces as the `notConfigured` branch in the UI.
 */

import { pushApi } from '@/api/client';

const SERVICE_WORKER_PATH = '/sw.js';

/**
 * True when the runtime supports Web Push. Controls whether the opt-in
 * affordance is rendered at all (ui/index.md §8.7.2: iOS and feature-poor
 * browsers fall under the "unsupported" branch).
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Runtime VAPID public-key resolution via `GET /api/push/vapid-public-
 * key` (single source of truth — the server derives the public half
 * from `VAPID_PRIVATE_KEY` at boot). Returns `null` when the server
 * reports the key as unconfigured or the request fails, triggering
 * the `notConfigured` UI branch.
 *
 * Not cached in-module — the browser's HTTP cache (5-minute max-age
 * set by the endpoint) is the cache layer. Re-fetching per
 * subscribe-attempt keeps the key fresh across deploys without
 * needing an explicit invalidation path.
 */
export async function resolveVapidPublicKey(): Promise<string | null> {
  try {
    const response = await fetch('/api/push/vapid-public-key', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { vapidPublicKey?: unknown };
    if (typeof body.vapidPublicKey === 'string' && body.vapidPublicKey.length > 0) {
      return body.vapidPublicKey;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a URL-safe base64 VAPID public key into a fresh `ArrayBuffer`.
 * `pushManager.subscribe` types `applicationServerKey` as `BufferSource`
 * over a plain `ArrayBuffer`, so returning a `Uint8Array` backed by
 * `ArrayBufferLike` (which can include `SharedArrayBuffer`) is rejected
 * under strict TS. Building the buffer directly avoids the
 * ArrayBufferLike → ArrayBuffer narrowing issue.
 */
function urlBase64ToArrayBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Encode an `ArrayBuffer` returned by the browser push API to the URL-
 * safe base64 string the server-side push library (and data-model.md
 * §5.12) expects.
 */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; ++i) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Resolve the active Service Worker registration. The SW is registered
 * eagerly at SPA boot (`src/main.tsx`) because it intercepts
 * `/encrypted-storage/*` requests for binary attachment decryption
 * (ADR-0024). This function awaits `navigator.serviceWorker.ready`,
 * which resolves with the active registration once the worker has
 * progressed past `installing`.
 *
 * Safe to call from a user-click handler — `ready` resolves immediately
 * if the worker is already active.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

/**
 * Read the current push subscription for this browser, if any. Returns
 * `null` when the worker has not yet been registered OR when no
 * subscription is active. Used by the UI to decide whether to render
 * the opt-in affordance or the unsubscribe affordance.
 */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export interface PushSubscribeOutcome {
  ok: boolean;
  /** Machine-readable code for the UI to branch on. */
  reason?:
    | 'unsupported'
    | 'not-configured'
    | 'permission-denied'
    | 'permission-dismissed'
    | 'subscribe-failed'
    | 'server-error';
  /** German-language error message when `ok === false`. */
  message?: string;
}

/**
 * Full opt-in flow: request permission, register the service worker,
 * subscribe to the browser's push manager, forward the subscription to
 * the server. MUST be invoked from a user-click handler — AC-201.
 *
 * Ordering note: we call `Notification.requestPermission()` BEFORE
 * validating the VAPID key. AC-201 requires that the
 * permission prompt fires only inside a user-click handler — i.e. the
 * user action is a prerequisite for the prompt. Skipping the prompt
 * because the server is not yet configured would silently swallow the
 * user's intent and hide the real failure. The user still sees the
 * browser's permission UI exactly once per click, regardless of whether
 * the round-trip to the server ultimately succeeds.
 */
export async function subscribeToPush(): Promise<PushSubscribeOutcome> {
  if (!isPushSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  // User-initiated permission request (AC-201). A browser that
  // already has `permission === 'denied'` returns that value without a
  // prompt; the caller is expected to hide the affordance in that case,
  // but we still branch defensively.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    return { ok: false, reason: 'permission-denied' };
  }
  if (permission !== 'granted') {
    // 'default' — user dismissed the prompt without a decision.
    return { ok: false, reason: 'permission-dismissed' };
  }

  const vapid = await resolveVapidPublicKey();
  if (!vapid) {
    return { ok: false, reason: 'not-configured' };
  }

  const registration = await ensureServiceWorker();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(vapid),
  });

  // The Push API spec says `subscribe()` either resolves with a
  // `PushSubscription` or rejects — null is not a valid resolution. A
  // null here is a browser bug, but observed in the wild (mobile
  // Firefox on certain builds). Guard explicitly so a misbehaving
  // browser surfaces an actionable error instead of crashing on
  // `.getKey()` with a TypeError the user cannot interpret.
  if (!subscription) {
    return { ok: false, reason: 'subscribe-failed' };
  }

  const p256dhBuffer = subscription.getKey('p256dh');
  const authBuffer = subscription.getKey('auth');
  if (!p256dhBuffer || !authBuffer) {
    // Browser returned a subscription without key material — we cannot
    // forward anything meaningful to the server. Roll back.
    await subscription.unsubscribe().catch(() => undefined);
    return { ok: false, reason: 'subscribe-failed' };
  }

  const result = await pushApi.subscribe({
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToBase64Url(p256dhBuffer),
      auth: arrayBufferToBase64Url(authBuffer),
    },
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  });

  if (!result.ok) {
    // Server rejected the subscription (e.g., VALIDATION_ERROR). Roll
    // back the browser-side subscription so the UI stays consistent —
    // leaving an orphan browser subscription without a server row would
    // permanently hide the opt-in affordance on this device.
    await subscription.unsubscribe().catch(() => undefined);
    return { ok: false, reason: 'server-error', message: result.error.message };
  }

  return { ok: true };
}

/**
 * Tear down the local subscription for this device and notify the
 * server. Keeps the service worker registered (the user may opt in
 * again) — spec ui/index.md §8.7.2 "Gerät abmelden" scope.
 *
 * Throws on server error so PushSubscriptionControls' handleUnsubscribe
 * can show the AC-673 error notification; sign-out (`authStore.logout`,
 * AC-655) swallows it.
 * The browser-side subscription is revoked first so the browser stops
 * forwarding pushes even if the server call fails; the server row is
 * reconciled on the next successful unsubscribe (the DELETE is
 * idempotent) or by dispatch-time pruning.
 */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  // Revoke locally first.
  await subscription.unsubscribe().catch(() => undefined);
  const result = await pushApi.unsubscribeByEndpoint(endpoint);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

/**
 * On sign-in, revoke a browser subscription that is not registered for
 * the signed-in user (AC-679): another user's, or one whose registration
 * a password change removed. The controls then offer `aktivieren`.
 * Fails closed — a failed check revokes too, so a shared device never
 * keeps delivering a previous user's pushes.
 */
export async function dropSubscriptionNotRegisteredForUser(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  const result = await pushApi.registrationStatus(subscription.endpoint);
  if (result.ok && result.data.registered) return;
  await subscription.unsubscribe();
}
