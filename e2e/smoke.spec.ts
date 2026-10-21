import { test, expect } from '@playwright/test';

/**
 * E2E Smoke Test — minimal boot-and-round-trip check
 *
 * Answers a single question: does the app boot, can a seeded user log in,
 * see the main view, and log out again? If this fails, the deployment is
 * broken. Extended integration scenarios (filters, transitions, calendar,
 * date editing, session persistence, back-button protection, etc.) live in
 * kanban-flows.spec.ts so a smoke failure points at one thing, not thirteen.
 *
 * Seed data assumptions:
 *   - User: inhaber / changeme (Thomas Berger, admin/owner)
 */
test('app boots, seeded user can log in and log out', async ({ page }) => {
  // ── Step 1: App loads — login screen is displayed ──
  // AC-21: Unauthenticated users see only a login screen.
  await page.goto('/');
  const loginForm = page.getByTestId('login-form');
  await expect(loginForm).toBeVisible();
  await expect(page.getByTestId('login-username')).toBeVisible();
  await expect(page.getByTestId('login-password')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toBeVisible();

  // No project data should be visible before login
  await expect(page.getByTestId('kanban-board')).not.toBeVisible();

  // ── Step 2: User enters credentials and logs in — Kanban view renders ──
  // AC-22: Valid credentials → Kanban view
  await page.getByTestId('login-username').fill('inhaber');
  await page.getByTestId('login-password').fill('changeme');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('kanban-board')).toBeVisible();

  // ── Step 3: Header shows user's display name ──
  // AC-24: User indicator shows display name
  const userIndicator = page.getByTestId('user-indicator');
  await expect(userIndicator).toBeVisible();
  await expect(userIndicator).toContainText('Thomas Berger');

  // ── Step 16: User clicks "Abmelden" — login screen appears ──
  // AC-25: Clicking "Abmelden" logs out and shows login screen
  await userIndicator.click();
  await page.getByTestId('logout-button').click();

  await expect(page.getByTestId('login-form')).toBeVisible();
  await expect(page.getByTestId('kanban-board')).not.toBeVisible();
});
