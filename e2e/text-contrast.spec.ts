import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STORAGE_STATES } from './storage-states';

/**
 * AC-748: text meets WCAG AA contrast against its surface in both themes.
 *
 * axe's `color-contrast` rule measures each rendered text node against its
 * computed background. The walk covers every view, the login error, the
 * board with collapsed columns and the phone layout; states it does not
 * render (dialogs, the detail panel, toasts, hover) are unchecked. The
 * seeded users store `system`, so `colorScheme` picks the theme.
 */

type Scheme = 'light' | 'dark';
const SCHEMES: Scheme[] = ['light', 'dark'];

async function expectAaContrast(page: Page, scheme: Scheme): Promise<void> {
  if (scheme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');

  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  const failed = results.violations.flatMap((v) =>
    v.nodes.map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? v.help}`),
  );
  // axe cannot measure text over images, gradients or overlapping elements
  // and reports it as incomplete. Icon glyphs (`nonBmp`) are not text.
  const unmeasured = results.incomplete.flatMap((v) =>
    v.nodes
      .filter((n) => (n.any[0]?.data as { messageKey?: string } | null)?.messageKey !== 'nonBmp')
      .map((n) => `${n.target.join(' ')} — unmeasured: ${n.any[0]?.message ?? v.help}`),
  );
  const offenders = [...failed, ...unmeasured];
  expect(offenders, offenders.join('\n')).toEqual([]);
}

async function firstId(page: Page, url: string): Promise<string> {
  const res = await page.request.get(url);
  expect(res.ok()).toBe(true);
  const id = ((await res.json()) as { data: { id: string }[] }).data[0]?.id;
  expect(id, `${url} returned no rows`).toBeDefined();
  return id!;
}

// Each view with the first element that exists only once its data loaded.
const OWNER_VIEWS: { path: string; loaded: string }[] = [
  { path: '/kanban', loaded: '[data-testid^="project-card-"]' },
  { path: '/calendar', loaded: '[data-testid^="calendar-bar-"]' },
  { path: '/projects', loaded: '[data-testid="project-table"] tbody tr' },
  { path: '/customers', loaded: '[data-testid="customer-table"] tbody tr' },
  { path: '/rechnungen', loaded: '[data-testid^="invoice-row-"]' },
  { path: '/users', loaded: '[data-testid="user-table"] tbody tr' },
  { path: '/daten', loaded: '[data-testid="daten-view"]' },
  // A fresh seed may hold no audit entries yet: the empty state is loaded too.
  {
    path: '/audit',
    loaded:
      '[data-testid="audit-list"] :is([data-testid^="activity-feed-row-"], [data-testid$="empty-state"])',
  },
  { path: '/benachrichtigungen', loaded: '[data-testid^="notification-rule-row-"]' },
];

for (const scheme of SCHEMES) {
  test.describe(`AC-748: text contrast, ${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    for (const view of OWNER_VIEWS) {
      test(`AC-748: ${view.path}`, async ({ page }) => {
        await page.goto(view.path);
        await expect(page.locator(view.loaded).first()).toBeVisible();
        await expectAaContrast(page, scheme);
      });
    }

    test('AC-748: project detail page', async ({ page }) => {
      await page.goto(`/projects/${await firstId(page, '/api/projects?limit=1')}`);
      await expect(page.getByTestId('project-detail-page')).toBeVisible();
      await expectAaContrast(page, scheme);
    });

    test('AC-748: invoice detail view', async ({ page }) => {
      await page.goto(`/rechnungen/${await firstId(page, '/api/invoices?limit=1')}`);
      await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
      await expectAaContrast(page, scheme);
    });

    test.describe('laptop width', () => {
      // Below 1780 px the board collapses its low-tier columns.
      test.use({ viewport: { width: 1440, height: 900 } });

      test('AC-748: /kanban with collapsed columns', async ({ page }) => {
        await page.goto('/kanban');
        await expect(page.locator('[data-testid^="project-card-"]').first()).toBeVisible();
        await expectAaContrast(page, scheme);
      });
    });

    test.describe('phone width', () => {
      test.use({ viewport: { width: 390, height: 844 } });

      test('AC-748: /projects with the tab bar', async ({ page }) => {
        await page.goto('/projects');
        await expect(page.locator('[data-testid="project-table"] tbody tr').first()).toBeVisible();
        await expectAaContrast(page, scheme);
      });
    });

    test.describe('worker', () => {
      test.use({ storageState: STORAGE_STATES.worker });

      test('AC-748: /meine-projekte', async ({ page }) => {
        await page.goto('/meine-projekte');
        await expect(page.getByTestId('my-projects-view')).toBeVisible();
        await expectAaContrast(page, scheme);
      });
    });

    test.describe('signed out', () => {
      test.use({ storageState: { cookies: [], origins: [] } });

      test('AC-748: login screen', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('login-form')).toBeVisible();
        await expectAaContrast(page, scheme);
      });

      test('AC-748: login error', async ({ page }) => {
        // Answered here, so no real failed login counts against the account.
        await page.route('**/api/auth/login', (route) =>
          route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'INVALID_CREDENTIALS',
              message: 'Anmeldung fehlgeschlagen',
            }),
          }),
        );
        await page.goto('/');
        await page.getByTestId('login-username').fill('inhaber');
        await page.getByTestId('login-password').fill('falsch');
        await page.getByTestId('login-submit').click();
        await expect(page.getByTestId('login-error')).toBeVisible();
        await expectAaContrast(page, scheme);
      });
    });
  });
}
