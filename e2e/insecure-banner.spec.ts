import { test, expect } from '@playwright/test';
import { BRANDING } from '../src/config/brandingConfig';

/**
 * Insecure connection banner — verifies the red warning bar appears
 * on the login page when the app is accessed via plain HTTP on a
 * non-localhost address, and does NOT appear on localhost.
 *
 * Uses empty storageState so every test sees the unauthenticated
 * login page. The banner is most critical there — credentials are
 * about to be typed.
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

test.describe('Insecure connection banner', () => {
  test('no banner and standard title on localhost', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-form')).toBeVisible();

    await expect(page.getByTestId('insecure-banner')).not.toBeVisible();
    // AC-363: the shell's identity reaches the browser only through the
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

    await expect(page.getByTestId('insecure-banner')).toBeVisible();
    await expect(page.getByTestId('insecure-banner')).toContainText('UNSICHERER MODUS');
    await expect(page).toHaveTitle(/^UNSICHER/);
  });
});
