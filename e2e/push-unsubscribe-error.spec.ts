import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — `Gerät abmelden` failure path.
 *
 * Pins AC-205 from `docs/spec/verification.md §15.24` and the
 * optimistic-UI revert contract in `docs/spec/ui/behavior.md §9.5`.
 *
 * Contract: when the DELETE `/api/push-subscriptions` call fails (5xx),
 * the UI must:
 *   1. Restore the `Gerät abmelden` affordance (optimistic hide reverts).
 *   2. Show an error notification (data-testid="push-error").
 *   3. Leave the subscription registered server-side.
 * After clearing the route override, a retry must succeed: the
 * affordance disappears and no error is shown.
 *
 * Test topology: the browser's PushManager requires a VAPID key and a
 * real push-service endpoint, which are not available in headless CI.
 * Instead, this spec injects a mock push subscription via
 * `addInitScript` so the component's `getCurrentSubscription()` call
 * returns a fake subscription object, causing the `Gerät abmelden`
 * affordance to render without exercising the real subscribe path. The
 * DELETE interception (page.route) covers the server failure branch.
 *
 * Service-worker mock strategy: Playwright's `addInitScript` runs
 * before any page script. We override `ServiceWorkerContainer.prototype
 * .getRegistration` so that the native object's prototype method is
 * replaced — this avoids the "non-configurable/non-writable" problem
 * when trying to assign directly to `navigator.serviceWorker`.
 *
 * NOTE: playwright.config.ts MUTATING_TESTS must include
 * `push-unsubscribe-error` for this spec to run in `chromium-mutating`.
 * Until that update lands the spec runs in the `chromium` project.
 */

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------
// AC-205 — Gerät abmelden failure path: revert + error + retry
// ---------------------------------------------------------------
test.describe('AC-205: Gerät abmelden failure reverts affordance and shows error', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  const MOCK_ENDPOINT = 'https://push.test.example/mock-subscription-endpoint';

  test('unsubscribe failure reverts affordance, shows push-error, retry succeeds', async ({
    page,
  }) => {
    // Install the service-worker mock BEFORE navigation so the
    // component's mount-time `getCurrentSubscription()` call observes
    // the fake subscription.
    await page.addInitScript((endpoint: string) => {
      const fakeSub = {
        endpoint,
        getKey: (_name: string) => new ArrayBuffer(16),
        unsubscribe: () => Promise.resolve(true),
        toJSON: () => ({ endpoint, keys: {} }),
      };

      const fakeRegistration = {
        pushManager: {
          getSubscription: () => Promise.resolve(fakeSub),
          subscribe: () => Promise.resolve(fakeSub),
          permissionState: () => Promise.resolve('granted'),
          supportedContentEncodings: [],
        },
        active: { state: 'activated' },
        installing: null,
        waiting: null,
        scope: '/',
        updateViaCache: 'imports',
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        update: () => Promise.resolve(),
      };

      // Override the prototype method on ServiceWorkerContainer so the
      // native navigator.serviceWorker object dispatches through our mock.
      // This is safer than trying to replace navigator.serviceWorker
      // (which is typically non-writable) or calling Object.defineProperty
      // on a potentially non-configurable descriptor.
      const proto = Object.getPrototypeOf(navigator.serviceWorker) as {
        getRegistration: unknown;
        register: unknown;
      };

      // Save originals so that unrelated registration calls still work.
      const origGetRegistration = proto.getRegistration;

      Object.defineProperty(proto, 'getRegistration', {
        configurable: true,
        writable: true,
        value: (_scope?: string) => Promise.resolve(fakeRegistration),
      });

      // Also mock `ready` — pushClient.ts calls `navigator.serviceWorker.ready`
      // after `register()` to wait for an active worker.
      Object.defineProperty(navigator.serviceWorker, 'ready', {
        configurable: true,
        get: () => Promise.resolve(fakeRegistration),
      });

      // Restore hint — store original so the prototype mutation is
      // clearly scoped to this page context.
      void origGetRegistration;
    }, MOCK_ENDPOINT);

    // --- Step 1: verify the affordance renders after page load ---------------
    await page.goto('/');
    await page.getByTestId('header').waitFor({ state: 'visible' });
    await page.getByTestId('user-menu-trigger').click();

    const unsubBtn = page.getByTestId('push-unsubscribe-button');
    // The component reads hasSubscription asynchronously via useEffect;
    // poll until the mock subscription is reflected in the UI.
    await expect(unsubBtn).toBeVisible({ timeout: 5000 });

    // --- Step 2: intercept DELETE and return 500 -----------------------------
    await page.route('**/api/push-subscriptions**', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVER_ERROR', message: 'synthetic test failure' }),
        });
        return;
      }
      await route.continue();
    });

    await unsubBtn.click();

    // --- Step 3: affordance is restored; error notification appears ----------
    // handleUnsubscribe catches the throw from unsubscribeFromPush(),
    // sets errorMessage (via catch), and does NOT set hasSubscription=false.
    await expect(unsubBtn).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('push-error')).toBeVisible();

    // --- Step 4: clear the route override; retry should succeed ---------------
    await page.unroute('**/api/push-subscriptions**');

    // Route the retry DELETE to 204 so the test does not need a real
    // server-side push subscription row.
    await page.route('**/api/push-subscriptions**', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 204 });
        return;
      }
      await route.continue();
    });

    await unsubBtn.click();

    // On success: hasSubscription=false → button gone, error cleared.
    await expect(unsubBtn).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('push-error')).not.toBeVisible();
  });
});
