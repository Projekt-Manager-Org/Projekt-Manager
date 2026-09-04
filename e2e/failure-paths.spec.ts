/**
 * E2E failure paths
 *
 * The smoke test covers the happy path. This file covers what happens when
 * things go wrong end-to-end:
 *
 *   1. Network error during a transition — the user sees a German error
 *      banner and the local state does not get corrupted.
 *   2. Session expiry mid-flow — clicking a transition while the session
 *      has been invalidated server-side redirects to the login screen
 *      with the expiry message.
 *
 * These two scenarios are the closest the spec gets to a deployment
 * robustness check (verification.md AC-23, AC-27).
 */

import { test, expect } from '@playwright/test';

test.describe('E2E failure paths', () => {
  test.beforeEach(async ({ page }) => {
    // Auth comes from the shared storageState (see auth.setup.ts);
    // the tests in this file exercise transition-time failures, not
    // login-time failures, so they start from an authenticated board.
    // The "session expiry" test still simulates server-side invalidation
    // via route mocking — that's unrelated to client-side auth state.
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  test('network error during transition shows error banner and reverts state', async ({ page }) => {
    // Inject a network failure on the next transition request.
    await page.route('**/api/projects/*/transition/*', async (route) => {
      await route.abort('failed');
    });

    // Find a project in geplant — this is the same column the smoke test uses.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    const cardTestId = await geplantCard.getAttribute('data-testid');
    const projectId = cardTestId!.replace('project-card-', '');

    // Trigger the forward transition from the Kanban card — the detail
    // panel no longer owns transition buttons; they moved to the card
    // itself so the Kanban view is the single place to organize
    // projects.
    await geplantCard.getByTestId(`forward-button-${projectId}`).click();
    await page.getByTestId('confirm-ok').click();

    // The error banner appears (German, no stack trace). Use the dedicated
    // testid instead of a fuzzy text regex — a regex that matches "Netzwerk"
    // would happily match any other element on the page that mentions it.
    // The banner is only rendered when `mutationError` is truthy (see
    // src/App.tsx), so visibility alone is a reliable signal. We deliberately
    // do not assert on the German copy so this test is not coupled to
    // translation tweaks.
    const errorBanner = page.getByTestId('mutation-error-banner');
    await expect(errorBanner).toBeVisible();

    // State is unchanged: the project is still in geplant, not in_arbeit.
    await expect(
      page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId('kanban-column-in_arbeit').getByTestId(`project-card-${projectId}`),
    ).not.toBeVisible();
  });

  test('session expiry mid-flow redirects to login with expiry message', async ({ page }) => {
    // Intercept the next transition call and respond with 401 + SESSION_EXPIRED.
    // This simulates the session being invalidated server-side between page
    // load and the user's next action.
    await page.route('**/api/projects/*/transition/*', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'SESSION_EXPIRED',
          message: 'Sitzung abgelaufen.',
        }),
      });
    });

    // Trigger the forward transition from the Kanban card.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    const cardTestId = await geplantCard.getAttribute('data-testid');
    const projectId = cardTestId!.replace('project-card-', '');
    await geplantCard.getByTestId(`forward-button-${projectId}`).click();
    await page.getByTestId('confirm-ok').click();

    // The login screen reappears with the German expiry message.
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.locator('text=/Sitzung abgelaufen/i').first()).toBeVisible();
    // The Kanban board is no longer visible.
    await expect(page.getByTestId('kanban-board')).not.toBeVisible();
  });

  test('cancelling the confirmation modal does not transition the project', async ({ page }) => {
    // No network mocking — the test verifies the confirm/cancel UX itself.
    const geplantColumn = page.getByTestId('kanban-column-geplant');
    const geplantCard = geplantColumn.locator('[data-testid^="project-card-"]').first();
    const cardTestId = await geplantCard.getAttribute('data-testid');
    const projectId = cardTestId!.replace('project-card-', '');

    await geplantCard.getByTestId(`forward-button-${projectId}`).click();

    // Modal opens — click Abbrechen.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).not.toBeVisible();

    // Card is still in geplant column — never left.
    await expect(
      page.getByTestId('kanban-column-geplant').getByTestId(`project-card-${projectId}`),
    ).toBeVisible();
  });
});
