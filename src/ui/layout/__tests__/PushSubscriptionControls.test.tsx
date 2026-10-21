/**
 * PushSubscriptionControls — component test for AC-201's activation
 * clause ("the prompt is raised only on user activation of
 * `Push-Benachrichtigungen aktivieren`").
 *
 * ---------------------------------------------------------------------
 * Exception from the [vis] → E2E-only rule
 * ---------------------------------------------------------------------
 *
 * ADR-0014 defines `[vis]` ACs as verified by an E2E spec driving the scenario
 * (human review via `npx playwright test --ui`). The E2E spec must
 * exist — without it there is nothing to watch.
 *
 * AC-201 is `[vis]`, and its first clause ("no auto-request on page
 * load") IS covered by `e2e/push-permission.spec.ts:35` — a passing,
 * headless-compatible assertion.
 *
 * The second clause — "activation triggers exactly one prompt" —
 * cannot be E2E'd under our default headless Chromium:
 *
 *   - Headless Chromium pins `Notification.permission === 'denied'`
 *     regardless of `context.clearPermissions()` /
 *     `context.grantPermissions(['notifications'])`. Empirically
 *     verified: the three-step grant/clear cycle leaves permission
 *     at `'denied'` in headless, while headed resolves to `'default'`.
 *   - The UI gates the opt-in button on `permission !== 'denied'`
 *     (`PushSubscriptionControls.tsx`), so the affordance never
 *     renders in headless → no button to click → no prompt to
 *     observe.
 *
 * Prior e2e workaround used `Object.defineProperty(window.Notification,
 * 'permission', { get: () => 'default' })` to force the button to
 * render. That shipped a fake-pass: a regression where the click
 * handler calls `requestPermission()` zero or two times would still
 * have passed because the DOM override masks the real browser state.
 * The e2e now self-skips with a documented reason; this component
 * test is the real regression gate for the "exactly one prompt per
 * click" contract.
 *
 * Options evaluated before writing this file:
 *   1. `headless: false` + `xvfb-run` in CI — correct but adds CI
 *      plumbing to every run. Reserved as escalation if this unit
 *      test starts missing real bugs.
 *   2. Drop / re-scope the AC — rejected; "exactly one prompt" is a
 *      deliberate UX safety (double-prompt bug would annoy users and
 *      conflict with AC-201's rationale that every prompt is a
 *      deliberate user action).
 *   3. This component test (chosen) — covers the regression surface
 *      (handler wiring, busy-gate against double-click).
 *
 * Human judgement gate (the `[vis]` reviewer) still applies: the
 * opt-in affordance's visual rendering, disabled state, and error
 * surface live in the e2e specs that run under real conditions (mute
 * toggle, failure-path tests). This file covers only the browser-API
 * call contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { AuthUser } from '@/api/client';

const { useAuthStore } = await import('@/state/authStore');
const { PushSubscriptionControls } = await import('@/ui/layout/PushSubscriptionControls');

function seedAuthUser(): void {
  const user: AuthUser = {
    id: 'u-1',
    username: 'owner',
    displayName: 'Test Owner',
    roles: ['owner'],
    email: null,
    themePreference: 'system',
    pushMuted: false,
  };
  useAuthStore.setState({
    authUser: user,
    authError: null,
    sessionChecked: true,
  });
}

/**
 * Stub the three globals `isPushSupported()` checks plus the
 * `Notification` API surface. pushClient reads these synchronously, so
 * the stubs must land before the component mounts.
 *
 * Returns the spy on `Notification.requestPermission` so the test
 * asserts on the call count. Each test installs its own stub with the
 * permission state and permission-resolve semantics it needs — no
 * shared mutable state between tests.
 */
function installPushEnvironment(
  initialPermission: 'default' | 'granted' | 'denied',
  requestPermissionImpl: () => Promise<NotificationPermission>,
): { requestPermission: ReturnType<typeof vi.fn> } {
  const requestPermission = vi.fn(requestPermissionImpl);
  const NotificationStub = {
    permission: initialPermission,
    requestPermission,
  };
  // Notification must be both on `window` (the component reads
  // `window.Notification.permission`) and in the global scope (the
  // `'Notification' in window` feature check inside pushClient).
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: NotificationStub,
  });
  // PushManager presence is the second feature check. A minimal stub
  // suffices — the component never calls into it in the branches this
  // test exercises (permission dismissed/denied exits before subscribe).
  Object.defineProperty(window, 'PushManager', {
    configurable: true,
    writable: true,
    value: function PushManagerStub() {},
  });
  // navigator.serviceWorker is the third feature check. Not called in
  // the tested branches either, but must be present for isPushSupported
  // to return true.
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: {
      register: vi.fn(),
      getRegistration: vi.fn(async () => undefined),
    },
  });
  return { requestPermission };
}

function uninstallPushEnvironment(): void {
  // @ts-expect-error — non-standard deletion on jsdom.
  delete window.Notification;
  // @ts-expect-error — non-standard deletion on jsdom.
  delete window.PushManager;
  // @ts-expect-error — navigator.serviceWorker is read-only in the DOM
  // spec but configurable in jsdom per our defineProperty above.
  delete navigator.serviceWorker;
}

describe('AC-201: push permission is user-initiated', () => {
  beforeEach(() => {
    seedAuthUser();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ authUser: null, authError: null, sessionChecked: false });
    uninstallPushEnvironment();
    vi.restoreAllMocks();
  });

  it('does not call Notification.requestPermission on mount', async () => {
    const { requestPermission } = installPushEnvironment('default', async () => 'default');

    render(<PushSubscriptionControls />);

    // Drain the mount-effect's async getCurrentSubscription probe.
    // Three microtask ticks are enough for the effect → .catch →
    // setState chain to settle; a regression that auto-prompts on
    // mount would be caught regardless of tick count.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('clicking the opt-in button triggers exactly one requestPermission call', async () => {
    // Resolve to 'default' (dismissed) so subscribeToPush exits before
    // touching the ServiceWorker registration path. We are asserting
    // only on the browser-permission call, not the full subscribe
    // round-trip — the latter is covered by the failure-path e2e spec.
    const { requestPermission } = installPushEnvironment('default', async () => 'default');

    render(<PushSubscriptionControls />);

    await act(async () => {
      await Promise.resolve();
    });

    const button = screen.getByTestId('push-opt-in-button');

    await act(async () => {
      fireEvent.click(button);
      // Drain microtasks so subscribeToPush's await
      // `Notification.requestPermission` has resolved.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('a second click while busy does not trigger a second prompt', async () => {
    // Hold the first requestPermission open so `busy` stays true.
    // The assertion catches a regression where the busy-gate is
    // removed or bypassed — the click would produce a second native
    // prompt in a real browser.
    let resolveFirst!: (value: NotificationPermission) => void;
    const firstCall = new Promise<NotificationPermission>((resolve) => {
      resolveFirst = resolve;
    });
    const { requestPermission } = installPushEnvironment('default', () => firstCall);

    render(<PushSubscriptionControls />);

    await act(async () => {
      await Promise.resolve();
    });

    const button = screen.getByTestId('push-opt-in-button');

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    // Second click while the first prompt is still open.
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);

    // Settle the hanging promise so the test runner doesn't hold it.
    await act(async () => {
      resolveFirst('default');
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('does not render the opt-in button when permission is already denied', async () => {
    installPushEnvironment('denied', async () => 'denied');

    render(<PushSubscriptionControls />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('push-opt-in-button')).toBeNull();
    expect(screen.getByTestId('push-denied-hint')).toBeInTheDocument();
  });
});
