import { test, expect, type Response } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../src/test/seedAssumptions';

/**
 * E2E — Push permission + Stummschalten toggle.
 *
 * Pins AC-201's "no auto-prompt on page load" clause and AC-658
 * (Stummschalten toggle reflects `pushMuted`, the same on every device).
 *
 * AC-201's second clause — "activation triggers exactly one prompt" —
 * is NOT exercised here. Headless Chromium pins
 * `Notification.permission === 'denied'` regardless of
 * `grantPermissions` / `clearPermissions`, so the opt-in affordance
 * never renders and cannot be clicked. Patching the DOM to force it
 * ships a fake-pass. Regression gate moved to
 * `src/ui/layout/__tests__/PushSubscriptionControls.test.tsx` —
 * documented exception from the `[vis]` → E2E-only rule. See that
 * file's header for the full rationale.
 *
 * AC-658 uses `chromium-mutating` because `Stummschalten` persists via
 * the self-update mutation.
 */

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------
// AC-201 — No auto-request on page load
// ---------------------------------------------------------------
test.describe('AC-201: push permission is user-initiated, not auto-requested', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('page load does not call Notification.requestPermission', async ({ page }) => {
    // Spy is installed BEFORE any navigation so first-load calls are
    // observed. `addInitScript` runs before page scripts in every
    // frame of every navigation in this context.
    await page.addInitScript(() => {
      const W = window as unknown as Record<string, unknown>;
      W.__requestPermissionCalls = 0;
      const orig = (window.Notification && window.Notification.requestPermission) || undefined;
      if (!window.Notification) {
        // Some browsers without the API — still install a stub to
        // observe calls that WOULD have been made.
        W.Notification = {
          permission: 'default',
          requestPermission: () => {
            (W.__requestPermissionCalls as number)++;
            return Promise.resolve('default');
          },
        };
      } else {
        window.Notification.requestPermission = () => {
          (W.__requestPermissionCalls as number)++;
          return orig
            ? (orig.call(window.Notification) as Promise<NotificationPermission>)
            : Promise.resolve('default');
        };
      }
    });

    await page.goto('/');
    // Wait for the app shell to render so the initial-mount scripts
    // have had a chance to run any auto-prompt logic a regression
    // would introduce.
    await page.getByTestId('header').waitFor({ state: 'visible' });

    const calls = await page.evaluate(
      () => (window as unknown as { __requestPermissionCalls: number }).__requestPermissionCalls,
    );
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------
// AC-658 — Stummschalten persists and reflects pushMuted
// ---------------------------------------------------------------
const isMuteSave = (r: Response): boolean =>
  r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH';

test.describe('AC-658: Stummschalten reflects pushMuted and persists', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('toggling Stummschalten persists across a reload', async ({ page }) => {
    // Reset the state via API first so the UI-side assertion is
    // deterministic.
    const reset = await page.request.patch('/api/auth/me', {
      data: { pushMuted: false },
    });
    expect(reset.ok()).toBe(true);

    await page.goto('/');
    await page.getByTestId('user-menu-trigger').click();

    const toggle = page.getByTestId('push-mute-toggle');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();

    // Reload — persisted value must survive.
    await page.reload();
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('push-mute-toggle')).toBeChecked();
  });

  test('a mute set on one device shows on another the user signs in on, and back', async ({
    page,
    browser,
  }) => {
    const reset = await page.request.patch('/api/auth/me', { data: { pushMuted: false } });
    expect(reset.ok()).toBe(true);

    // First device: the stored owner session mutes.
    await page.goto('/');
    await page.getByTestId('user-menu-trigger').click();
    const muted = page.waitForResponse(isMuteSave);
    await page.getByTestId('push-mute-toggle').check();
    expect((await muted).ok()).toBe(true);

    // Second device: a fresh browser, signed in through the login form.
    const secondDevice = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const second = await secondDevice.newPage();
      await second.goto('/');
      await second.getByTestId('login-username').fill(SEED_USERS.owner.username);
      await second.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
      await second.getByTestId('login-submit').click();
      await second.getByTestId('user-menu-trigger').click();
      const secondToggle = second.getByTestId('push-mute-toggle');
      await expect(secondToggle).toBeChecked();

      // Unmuting there shows on the first device.
      const unmuted = second.waitForResponse(isMuteSave);
      await secondToggle.uncheck();
      expect((await unmuted).ok()).toBe(true);
    } finally {
      await secondDevice.close();
    }
    await page.reload();
    await page.getByTestId('user-menu-trigger').click();
    await expect(page.getByTestId('push-mute-toggle')).not.toBeChecked();
  });

  test('failed mutation reverts the optimistic toggle', async ({ page }) => {
    // Hold the PATCH response until the test releases it. The optimistic
    // flip is observable for as long as the request is in flight, so we
    // can pin it deterministically — no race against CDP / fulfill
    // latency. Once we assert the flipped state, release the deferred
    // promise so the 500 lands and the store reverts.
    let releaseResponse!: () => void;
    const responseHeld = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route('**/api/auth/me', async (route) => {
      if (route.request().method() === 'PATCH') {
        await responseHeld;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVER_ERROR', message: 'synthetic test failure' }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByTestId('user-menu-trigger').click();
    const toggle = page.getByTestId('push-mute-toggle');
    const before = await toggle.isChecked();

    await toggle.click();

    // AC-658 / AC-754 contract — two halves to pin:
    //  1. The optimistic flip is observable BEFORE the server responds.
    //  2. The flip reverts after the 500 lands.
    await expect.poll(async () => toggle.isChecked()).toBe(!before);

    // Release the 500 → the toggle must revert to its prior state.
    releaseResponse();
    await expect.poll(async () => toggle.isChecked()).toBe(before);
  });
});
