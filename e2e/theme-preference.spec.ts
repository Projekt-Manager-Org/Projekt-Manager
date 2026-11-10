import { test, expect, type Page } from '@playwright/test';

/**
 * Per-user theme preference E2E — covers AC-119 and AC-120 from the
 * themePreference block (spec: docs/spec/verification.md §15.21,
 * docs/spec/ui/index.md §8.7.2, docs/spec/ui/behavior.md §9.6,
 * docs/spec/data-model.md §5.7).
 *
 * AC-119 [vis]: The user menu exposes a 3-way theme selector ("Hell",
 * "Dunkel", "Systemstandard"). Selecting an option updates the UI
 * immediately AND persists server-side; the selection survives a page
 * reload.
 *
 * AC-120 [vis]: On session hydration, the server-stored preference
 * replaces any locally cached value. A client on a different device
 * reflects the updated preference after the next session start.
 *
 * Scope notes:
 *   - This file is classified as MUTATING (see playwright.config.ts,
 *     MUTATING_TESTS regex). Both tests PATCH the inhaber user's
 *     `themePreference` and MUST restore it to `'system'` in teardown
 *     so read-only theming.spec.ts and other tests do not inherit a
 *     stale preference from this run.
 *   - The read-only theming.spec.ts deliberately stays parallel and
 *     unauthenticated; anything that writes to the DB lives here.
 *   - German labels are pinned contract — see §8.7.2. If the impl picks
 *     different labels, these tests fail and the LABELS get reconciled
 *     in the spec, not by rewriting the test.
 *   - The localStorage key is pinned contract — see
 *     src/config/themeStorage.ts.
 */

test.describe.configure({ mode: 'serial' });

// Local-cache key for the user's theme preference. Pinned contract.
const THEME_PREFERENCE_KEY = 'theme-preference';

// Self-update API path.
const AUTH_ME_PATH = '/api/auth/me';

// German labels for the theme selector. Pinned by docs/spec/ui/index.md §8.7.2.
// If the implementation picks different labels, these tests fail and
// the spec gets updated, not the test.
const DARSTELLUNG_LABEL = 'Darstellung';
const THEME_LABEL_LIGHT = 'Hell';
const THEME_LABEL_DARK = 'Dunkel';
const THEME_LABEL_SYSTEM = 'Systemstandard';

/**
 * Reset the inhaber's server-side preference to `'system'` so other
 * tests (including theming.spec.ts and subsequent runs) start from the
 * documented default. Called from afterAll — using the same page the
 * tests use so we piggyback on its authenticated cookie without
 * constructing a second APIRequestContext.
 */
async function resetPreferenceToSystem(page: Page): Promise<void> {
  await page.request.patch(AUTH_ME_PATH, {
    data: { themePreference: 'system' },
  });
}

/** Read the current `data-theme` attribute on <html>, or null if absent. */
async function readThemeAttr(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

/** Read the current `localStorage['theme-preference']` value, or null if absent. */
async function readCachedPreference(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => window.localStorage.getItem(k), key);
}

/** Read the body's resolved background-color. */
async function readBodyBg(page: Page): Promise<string> {
  return page.evaluate(() => window.getComputedStyle(document.body).backgroundColor);
}

/**
 * Open the user menu and return the locator for the "Darstellung" section's
 * selector option matching `label`. The implementation is free to use
 * <button role="radio">, <option>, or plain <button> — we locate by
 * accessible name so the test does not pin a specific element type.
 *
 * The user-menu trigger is `data-testid="user-indicator"` (Header.tsx:100).
 */
async function openThemeSelector(page: Page): Promise<void> {
  // Idempotent: the user-menu trigger toggles. Selecting a theme does not
  // close the menu (deliberate UX — the user can see the updated selected
  // state), so a second call between phases would otherwise close the
  // already-open menu.
  const section = page.getByText(DARSTELLUNG_LABEL, { exact: true });
  if (!(await section.isVisible())) {
    await page.getByTestId('user-indicator').click();
  }
  await expect(section).toBeVisible();
}

// AC-119
test('AC-119 [vis]: user menu theme selector updates UI, persists, survives reload', async ({
  page,
}) => {
  // --- Baseline: start from the default state. ---
  //
  // auth.setup.ts logs in as inhaber, whose DB `themePreference` is the
  // NOT NULL DEFAULT `'system'`. We do NOT seed localStorage — the
  // default state is "no cache entry, server says 'system'".
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // --- Phase 1: select "Dunkel" from the user menu. ---
  await openThemeSelector(page);

  // Wait for the PATCH to land so subsequent reload sees the new server
  // value — optimistic update means the UI flips before the response,
  // but persistence requires the server to have written it.
  const [dunkelResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().endsWith(AUTH_ME_PATH) && resp.request().method() === 'PATCH',
    ),
    page.getByRole('button', { name: THEME_LABEL_DARK, exact: true }).click(),
  ]);
  expect(
    dunkelResponse.ok(),
    `PATCH ${AUTH_ME_PATH} for Dunkel returned ${dunkelResponse.status()}. The self-update mutation failed; the UI flip (if any) is purely optimistic and will revert on reload.`,
  ).toBe(true);

  // UI, cache, and server state must all agree on `'dark'`.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await readCachedPreference(page, THEME_PREFERENCE_KEY)).toBe('dark');
  const darkBodyBg = await readBodyBg(page);

  const darkPayload = await dunkelResponse.json();
  expect(
    darkPayload?.user?.themePreference,
    `PATCH response must echo the new themePreference under user.themePreference. Got: ${JSON.stringify(darkPayload)}`,
  ).toBe('dark');

  // --- Phase 2: reload. The attribute, cache, and rendered palette
  //   must survive the reload. This is the "persistence" half of the AC. ---
  await page.reload();
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await readCachedPreference(page, THEME_PREFERENCE_KEY)).toBe('dark');
  expect(
    await readBodyBg(page),
    `Body background after reload does not match the dark-mode value seen before reload. Either the server did not persist the value, or the first paint after reload is not consulting it.`,
  ).toBe(darkBodyBg);

  // --- Phase 3: flip to "Hell" — full round-trip in reverse. ---
  await openThemeSelector(page);
  const [hellResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().endsWith(AUTH_ME_PATH) && resp.request().method() === 'PATCH',
    ),
    page.getByRole('button', { name: THEME_LABEL_LIGHT, exact: true }).click(),
  ]);
  expect(hellResponse.ok()).toBe(true);

  // `'light'` means the app's explicit light mode: the FOUC resolver
  // removes `data-theme` (themeRuntime.ts:41). We therefore assert the
  // attribute is either absent or explicitly `'light'` — depending on
  // how the implementation models its light token layer.
  const lightAttr = await readThemeAttr(page);
  expect(
    lightAttr,
    `After selecting "Hell", data-theme was "${lightAttr}". Expected the dark override to be cleared (null or "light").`,
  ).not.toBe('dark');
  expect(await readCachedPreference(page, THEME_PREFERENCE_KEY)).toBe('light');
  const lightBodyBg = await readBodyBg(page);
  expect(
    lightBodyBg,
    `Body background after "Hell" (${lightBodyBg}) is identical to the dark-mode value (${darkBodyBg}). The theme flip did not repaint the body surface.`,
  ).not.toBe(darkBodyBg);

  // --- Phase 4: "Systemstandard" persists server-side. Live OS-scheme
  //   reactivity under preference=system is AC-112's contract and is
  //   covered by `e2e/theming.spec.ts:94-147`. ---
  await openThemeSelector(page);
  const [systemResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().endsWith(AUTH_ME_PATH) && resp.request().method() === 'PATCH',
    ),
    page.getByRole('button', { name: THEME_LABEL_SYSTEM, exact: true }).click(),
  ]);
  expect(systemResponse.ok()).toBe(true);
  expect(await readCachedPreference(page, THEME_PREFERENCE_KEY)).toBe('system');

  // --- Teardown: reset so other tests see the documented default. ---
  // Done in afterAll below instead of inline so a failure mid-test still
  // cleans up.
});

// AC-120
test('AC-120 [vis]: server preference wins over stale localStorage on hydration', async ({
  page,
}) => {
  // Pin OS color-scheme to light so a system-mode fallback does not
  // accidentally match the server-stored 'dark' value we assert on.
  await page.emulateMedia({ colorScheme: 'light' });

  // --- Step 1: set the server-side preference to `'dark'` directly via
  //   the API. We use page.request, which inherits the authenticated
  //   storageState cookie — no second login needed. ---
  const patchResponse = await page.request.patch(AUTH_ME_PATH, {
    data: { themePreference: 'dark' },
  });
  expect(
    patchResponse.ok(),
    `Direct PATCH ${AUTH_ME_PATH} to seed server preference failed: ${patchResponse.status()}.`,
  ).toBe(true);

  // --- Step 2: seed a STALE localStorage value before the app boots.
  //   addInitScript runs before any page script on every navigation to
  //   this origin — earliest safe hook. We set the cache to 'light'
  //   while the server holds 'dark'; hydration MUST overwrite the cache. ---
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, 'light');
    },
    { key: THEME_PREFERENCE_KEY },
  );

  // --- Step 3: navigate. Wait for the authenticated surface AND for
  //   the hydration GET to complete, so we know the client has had the
  //   chance to reconcile cache ↔ server. ---
  const [hydrationResponse] = await Promise.all([
    page.waitForResponse(
      (resp) => resp.url().endsWith(AUTH_ME_PATH) && resp.request().method() === 'GET',
    ),
    page.goto('/'),
  ]);
  expect(hydrationResponse.ok()).toBe(true);
  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // --- Assertions: the server-stored 'dark' value must have replaced
  //   the stale 'light' cache, and the UI must reflect it. ---
  await expect(
    page.locator('html'),
    `data-theme did not resolve to "dark" after hydration. localStorage["${THEME_PREFERENCE_KEY}"] held a stale "light" value and the client failed to overwrite it with the server's "dark". The hydration contract (spec §9.6) is broken.`,
  ).toHaveAttribute('data-theme', 'dark');

  const cachedAfter = await readCachedPreference(page, THEME_PREFERENCE_KEY);
  expect(
    cachedAfter,
    `localStorage["${THEME_PREFERENCE_KEY}"] is "${cachedAfter}" after hydration, still holding the stale pre-login value. Spec §9.6: "after the authenticated session is established, the client replaces the local cache with the server value".`,
  ).toBe('dark');
});

test.afterAll(async ({ browser }) => {
  // Restore the inhaber's server-side preference to the documented
  // default. Done via a fresh context+page pair because afterAll does
  // not receive per-test fixtures — we reuse the saved storageState so
  // the request is authenticated.
  const context = await browser.newContext({
    storageState: 'e2e/.auth/owner.json',
  });
  const page = await context.newPage();
  try {
    await resetPreferenceToSystem(page);
  } finally {
    await context.close();
  }
});
