import { test, expect } from '@playwright/test';
import os from 'node:os';
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

/** Returns the first non-loopback IPv4 address, or null. */
function getLocalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

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
    const ip = getLocalIPv4();
    test.skip(!ip, 'No non-loopback IPv4 address available');

    // Swap the `localhost` host for the machine's LAN IP while keeping
    // whatever port the active project was configured with — 5173 for
    // the developer dev server, 5174 for Playwright's isolated E2E
    // server (see playwright.config.ts webServer).
    const port = new URL(test.info().project.use.baseURL ?? 'http://localhost:5173').port || '5173';
    await page.goto(`http://${ip}:${port}/`);
    await expect(page.getByTestId('login-form')).toBeVisible();

    await expect(page.getByTestId('insecure-banner')).toBeVisible();
    await expect(page.getByTestId('insecure-banner')).toContainText('UNSICHERER MODUS');
    await expect(page).toHaveTitle(/^UNSICHER/);
  });
});
