import { test, expect } from '@playwright/test';
import { clickView, type NavViewKey } from './nav-helpers';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-751: picking a view in the navigation shows it without reloading
 * the page. A marker set on `window` survives only while the document
 * does, so it proves no reload across a walk of every owner view.
 * Runs as owner (the default storage state), who sees the most views.
 */
const OWNER_WALK: readonly [NavViewKey, string][] = [
  ['kalender', '/calendar'],
  ['projekte', '/projects'],
  ['kunden', '/customers'],
  ['rechnungen', '/rechnungen'],
  ['benutzer', '/users'],
  ['daten', '/daten'],
  ['aktivitaet', '/audit'],
  ['benachrichtigungen', '/benachrichtigungen'],
  ['kanban', '/kanban'],
];

test('AC-751: walking every view through the navigation never reloads the page', async ({
  page,
}) => {
  await page.goto('/kanban');
  await page.getByTestId('header').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    (window as unknown as { __navMarker: string }).__navMarker = 'set';
  });

  for (const [view, path] of OWNER_WALK) {
    await clickView(page, view);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    const marker = await page.evaluate(
      () => (window as unknown as { __navMarker?: string }).__navMarker,
    );
    expect(marker, `navigating to ${view} reloaded the page`).toBe('set');
  }
});

/**
 * AC-752 at phone width: every entry outside `Verwaltung` is a tab in
 * the bottom bar, shown on every view. The worker walk also picks
 * Meine Projekte, which owners never see (AC-751).
 */
test.describe('at most 768 px wide', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.describe('worker', () => {
    test.use({ storageState: STORAGE_STATES.worker });

    test('AC-752, AC-751: the tab bar reaches every view in one tap, without a reload', async ({
      page,
    }) => {
      const tabs = ['meineProjekte', 'kanban', 'kalender'];
      await page.goto('/meine-projekte');
      await expect(page.getByTestId('mobile-tab-bar')).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as { __navMarker: string }).__navMarker = 'set';
      });

      for (const [view, path] of [
        ['kanban', '/kanban'],
        ['kalender', '/calendar'],
        ['meineProjekte', '/meine-projekte'],
      ] as const) {
        const bar = page.getByTestId('mobile-tab-bar');
        await expect(bar.locator('[data-testid^="tab-bar-"]')).toHaveCount(tabs.length);
        for (const t of tabs) await expect(page.getByTestId(`tab-bar-${t}`)).toBeVisible();
        await page.getByTestId(`tab-bar-${view}`).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        const marker = await page.evaluate(
          () => (window as unknown as { __navMarker?: string }).__navMarker,
        );
        expect(marker, `navigating to ${view} reloaded the page`).toBe('set');
      }
    });
  });

  test('AC-752: owner sees the primary entries as tabs and Verwaltung in the header', async ({
    page,
  }) => {
    await page.goto('/kanban');
    const bar = page.getByTestId('mobile-tab-bar');
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-testid^="tab-bar-"]')).toHaveCount(4);
    for (const t of ['kanban', 'kalender', 'projekte', 'kunden']) {
      await expect(page.getByTestId(`tab-bar-${t}`)).toBeVisible();
    }
    await expect(page.getByTestId('nav-admin-trigger')).toBeVisible();
  });
});
