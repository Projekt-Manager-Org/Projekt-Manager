import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { STORAGE_STATES } from './storage-states';
import { STRINGS } from '../src/config/strings';

/**
 * AC-27 — an open, idle app whose session ends shows the login screen
 * with the expiry message within one heartbeat interval plus 30 s,
 * without user action.
 *
 * The session ends by deactivation from another session (AC-570); the
 * app makes no request of its own, so only the realtime connection can
 * notice: the server closes it at the next heartbeat (AC-275), and the
 * client hands over to session-expired handling.
 *
 * Runs under `chromium-mutating`: creates, deactivates and deletes a
 * throwaway worker.
 */

const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_INTERVAL_MS || 25_000);
const AC_27_BOUND_MS = HEARTBEAT_MS + 30_000;

test.use({ storageState: { cookies: [], origins: [] } });

test('AC-27: an idle app shows the login screen once its session ends elsewhere', async ({
  browser,
  page,
}) => {
  test.setTimeout(AC_27_BOUND_MS + 60_000);

  const owner = await browser.newContext({ storageState: STORAGE_STATES.owner });
  const suffix = crypto.randomUUID().slice(0, 8);
  const password = `E2e-${crypto.randomUUID()}`;
  const created = await owner.request.post('/api/users', {
    data: {
      username: `e2e_idle_${suffix}`,
      displayName: `E2E Idle ${suffix}`,
      password,
      roles: ['worker'],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const userId = ((await created.json()) as { id: string }).id;

  try {
    await page.goto('/');
    await page.getByTestId('login-username').fill(`e2e_idle_${suffix}`);
    await page.getByTestId('login-password').fill(password);
    // Deactivate only once the realtime connection is up, so its close at
    // the next heartbeat — not a 401 on the first connect — is what ends it.
    const sseConnected = page.waitForResponse((r) => r.url().endsWith('/api/events') && r.ok());
    await page.getByTestId('login-submit').click();
    await sseConnected;
    await expect(page.getByRole('button', { name: `E2E Idle ${suffix}` })).toBeVisible({
      timeout: 15_000,
    });

    const deactivated = await owner.request.post(`/api/users/${userId}/deactivate`);
    expect(deactivated.ok(), await deactivated.text()).toBe(true);

    await expect(page.getByTestId('login-form')).toBeVisible({ timeout: AC_27_BOUND_MS });
    await expect(page.getByText(STRINGS.auth.sessionExpiredLogin)).toBeVisible();
  } finally {
    await owner.request.delete(`/api/users/${userId}`);
    await owner.close();
  }
});
