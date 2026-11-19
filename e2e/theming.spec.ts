import { test, expect } from '@playwright/test';

/**
 * Theming state/timing tests — AC-750, AC-741 and AC-112
 * (docs/spec/verification.md §15.19).
 *
 * Scope notes:
 *   - The dark-surface walk and the configured-accent walk
 *     are NOT covered here. They are listed as gaps in
 *     docs/testing/verification-exceptions.md and need E2E specs that drive the
 *     scenario so a reviewer can judge the result in Playwright UI
 *     mode (per ADR-0014). Earlier attempts to verify them via
 *     getComputedStyle + addStyleTag produced the brittle
 *     computed-style-assertion pattern the project rejected in
 *     iteration 5; a proper E2E that exercises the real surfaces is
 *     the replacement path.
 *   - Uses the `chromium` project (parallel, read-only). Empty
 *     storageState forces the unauthenticated login view.
 *   - The localStorage key `theme-preference` mirrors
 *     src/config/themeStorage.ts; the key itself is internal.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const THEME_PREFERENCE_KEY = 'theme-preference';

// AC-750, AC-741
test('AC-750, AC-741: the theme preference this device last applied is applied before first paint', async ({
  page,
}) => {
  // Seed preference = 'dark' via addInitScript, which runs BEFORE the page's
  // own scripts — this is the earliest hook available. The pre-paint theme
  // script (public/theme-init.js, referenced from index.html) must already
  // have run by DOMContentLoaded; if it hasn't, data-theme is still unset
  // when we read it and this test fails.
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, 'dark');
      const snapshot: { at: string; value: string | null }[] = [];
      (window as unknown as { __themeSnapshot: typeof snapshot }).__themeSnapshot = snapshot;
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          snapshot.push({
            at: 'DOMContentLoaded',
            value: document.documentElement.getAttribute('data-theme'),
          });
          requestAnimationFrame(() => {
            snapshot.push({
              at: 'firstRAF',
              value: document.documentElement.getAttribute('data-theme'),
            });
          });
        },
        { once: true },
      );
    },
    { key: THEME_PREFERENCE_KEY },
  );

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  await page.waitForFunction(() => {
    const w = window as unknown as { __themeSnapshot?: { at: string }[] };
    return !!w.__themeSnapshot && w.__themeSnapshot.length >= 2;
  });

  const snapshots = await page.evaluate(
    () =>
      (window as unknown as { __themeSnapshot: { at: string; value: string | null }[] })
        .__themeSnapshot,
  );
  const byCheckpoint = Object.fromEntries(snapshots.map((s) => [s.at, s.value]));

  expect(
    byCheckpoint['DOMContentLoaded'],
    `data-theme was "${byCheckpoint['DOMContentLoaded']}" at DOMContentLoaded with preference=dark seeded in localStorage["${THEME_PREFERENCE_KEY}"]. The pre-paint theme script (public/theme-init.js) did not run before DOMContentLoaded, so users will see a flash of the light theme on reload.`,
  ).toBe('dark');
  expect(
    byCheckpoint['firstRAF'],
    `data-theme was "${byCheckpoint['firstRAF']}" at the first requestAnimationFrame. Even if the attribute is eventually set, it must be set before the first paint.`,
  ).toBe('dark');
});

// AC-741, AC-112
test('AC-741, AC-112: with no cached preference, the theme tracks an OS color-scheme change', async ({
  page,
}) => {
  // No cached preference: the device falls back to `system` (AC-741).
  await page.emulateMedia({ colorScheme: 'light' });

  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();

  // Track navigations — an OS scheme change MUST NOT cause a reload
  // (AC-112: live subscription, not refresh).
  let navigations = 0;
  const onNav = () => {
    navigations += 1;
  };
  page.on('framenavigated', onNav);

  // Start light: data-theme attribute should be absent or non-'dark'.
  const lightAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(lightAttr).not.toBe('dark');

  await page.emulateMedia({ colorScheme: 'dark' });

  // Wait for the matchMedia listener to flip data-theme.
  try {
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      null,
      { timeout: 2000 },
    );
  } catch {
    // fall through — assertion below gives a descriptive message
  }

  const darkAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  page.off('framenavigated', onNav);

  expect(
    darkAttr,
    `data-theme did not flip to "dark" after OS scheme change (preference='system'). Got "${darkAttr}". The client is not subscribed to (prefers-color-scheme: dark).`,
  ).toBe('dark');

  expect(
    navigations,
    `Expected zero navigations between emulateMedia(colorScheme:'dark') and the attribute flip. Observed ${navigations}.`,
  ).toBe(0);
});
