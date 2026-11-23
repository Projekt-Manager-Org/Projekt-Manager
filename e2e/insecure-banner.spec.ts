import { test, expect } from '@playwright/test';
import { BRANDING } from '../src/config/brandingConfig';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../src/test/seedAssumptions.js';

/**
 * Insecure connection banner — verifies the red warning bar appears
 * when the app is accessed via plain HTTP on a non-localhost address,
 * on the login page and on the signed-in shell (App.tsx renders each
 * separately), offers no way to dismiss it, and does NOT appear on
 * localhost.
 */

// Override the project's default storageState (which has the
// authenticated session from auth.setup.ts) — we need the login page.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Non-localhost name that Chromium resolves to 127.0.0.1 — see
 * `INSECURE_HOST` in playwright.config.ts. The dev server is on loopback
 * only (#826), so the LAN IP is not an option.
 */
const INSECURE_HOST = 'insecure.test';

test.describe('AC-766: Insecure connection banner', () => {
  test('no banner and standard title on localhost', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();

    await expect(page.getByTestId('insecure-banner')).not.toBeVisible();
    // AC-743: the shell's identity reaches the browser only through the
    // `brand-app-shell` plugin, so this is where it is observable.
    // index.html ships `%APP_NAME%` / `%SHELL_THEME_COLOR%` rather than
    // literals — a failed injection renders the placeholder and fails
    // these, instead of coinciding with the default name.
    await expect(page).toHaveTitle(BRANDING.appName);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      BRANDING.shell.themeColor,
    );
    // The dev middleware and the `<link rel="manifest">` target, which
    // no unit test can reach: a 404 here is a PWA that will not install.
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.ok()).toBeTruthy();
    expect(await manifest.json()).toMatchObject({
      name: BRANDING.appName,
      short_name: BRANDING.shortName,
      theme_color: BRANDING.shell.themeColor,
    });
  });

  test('banner and title prefix on non-localhost HTTP', async ({ page }) => {
    // Swap the `localhost` host for INSECURE_HOST, keeping the port of
    // Playwright's isolated E2E server (playwright.config.ts webServer —
    // the only one that admits INSECURE_HOST).
    const { baseURL } = test.info().project.use;
    await page.goto(`http://${INSECURE_HOST}:${new URL(baseURL!).port}/`);
    await expect(page.getByTestId('login-form')).toBeVisible();

    const banner = page.getByTestId('insecure-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('UNSICHERER MODUS');
    await expect(banner.getByRole('button')).toHaveCount(0);
    // AC-778: the tab title carries the prefix.
    await expect(page).toHaveTitle(/^UNSICHER – /);
  });

  test('banner stays on the signed-in shell over non-localhost HTTP', async ({ page }) => {
    const { baseURL } = test.info().project.use;
    await page.goto(`http://${INSECURE_HOST}:${new URL(baseURL!).port}/`);
    await page.getByTestId('login-username').fill(SEED_USERS.owner.username);
    await page.getByTestId('login-password').fill(SEED_DEFAULT_PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });

    const banner = page.getByTestId('insecure-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('UNSICHERER MODUS');
    await expect(banner.getByRole('button')).toHaveCount(0);
  });
});
