import { createECDH } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { STRINGS } from '../src/config/strings';

/**
 * E2E — AC-653: a failed device registration names the failure and keeps
 * offering `Push-Benachrichtigungen aktivieren`.
 *
 * Headless Chromium has no push service and pins notification permission
 * to `denied`, so the browser side is replaced: permission starts at
 * `default` and the prompt grants it; the push manager holds no
 * subscription and accepts or refuses a new one. The E2E server may run
 * without a VAPID key (CI does), so a case that subscribes stubs the key
 * endpoint too (`serveVapidKey`); the replaced browser ignores the key. The rest of the
 * server side is real unless a case says otherwise. Granted permission is
 * the AC's precondition, not its subject: the prompt itself (AC-201) is not
 * asserted here.
 */

type BrowserSubscribe = 'accept' | 'refuse';

async function installGrantingPushBrowser(page: Page, subscribe: BrowserSubscribe): Promise<void> {
  await page.addInitScript((mode: BrowserSubscribe) => {
    let permission: NotificationPermission = 'default';
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => permission,
    });
    Notification.requestPermission = async () => {
      permission = 'granted';
      return permission;
    };

    const subscription = {
      endpoint: 'https://push.test.example/ac653-device',
      getKey: (name: string) => new Uint8Array(name === 'p256dh' ? 65 : 16).buffer,
      unsubscribe: async () => true,
    };
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => {
          if (mode === 'refuse') {
            throw new DOMException('Registration failed - push service error', 'AbortError');
          }
          return subscription;
        },
      },
    };
    Object.defineProperty(Object.getPrototypeOf(navigator.serviceWorker), 'getRegistration', {
      configurable: true,
      writable: true,
      value: async () => registration,
    });
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      configurable: true,
      get: () => Promise.resolve(registration),
    });
  }, subscribe);
}

// A real P-256 public key, in the encoding the server serves.
const STUB_VAPID_PUBLIC_KEY = createECDH('prime256v1').generateKeys().toString('base64url');

async function serveVapidKey(page: Page): Promise<void> {
  await page.route('**/api/push/vapid-public-key', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ vapidPublicKey: STUB_VAPID_PUBLIC_KEY }),
    }),
  );
}

async function activatePush(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('push-opt-in-button').click();
}

async function expectFailureShownAndOptInKept(page: Page, message: string): Promise<void> {
  await expect(page.getByTestId('push-error')).toHaveText(message);
  await expect(page.getByTestId('push-opt-in-button')).toBeEnabled();
  await expect(page.getByTestId('push-unsubscribe-button')).toHaveCount(0);
}

test.describe('AC-653: a failed device registration is named and opt-in stays offered', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('the browser refuses the subscription', async ({ page }) => {
    await installGrantingPushBrowser(page, 'refuse');
    await serveVapidKey(page);
    await activatePush(page);
    await expectFailureShownAndOptInKept(page, STRINGS.push.subscribeFailed);
  });

  test('the server has no push configured', async ({ page }) => {
    await installGrantingPushBrowser(page, 'accept');
    await page.route('**/api/push/vapid-public-key', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await activatePush(page);
    await expectFailureShownAndOptInKept(page, STRINGS.push.notConfigured);
  });

  test('the server refuses the registration', async ({ page }) => {
    await installGrantingPushBrowser(page, 'accept');
    await serveVapidKey(page);
    await page.route('**/api/push-subscriptions', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'SERVER_ERROR', message: '' }),
          })
        : route.continue(),
    );
    await activatePush(page);
    await expectFailureShownAndOptInKept(page, STRINGS.errors.serverError);
  });
});
