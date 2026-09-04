import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

/**
 * E2E — Notification Rules admin view.
 *
 * Pins AC-199 (form conditional fields) plus the basic create → list →
 * edit → delete flow tied to the admin surface defined in
 * `docs/spec/ui/management.md §8.14`.
 *
 * Why `chromium-mutating`: the spec drives rule CRUD, which mutates DB
 * state. It must run in the mutating project so playwright.config.ts
 * serializes it after read-only specs (shared DB fixture, no isolation
 * between specs within a project).
 *
 * Role coverage: AC-198 (URL-gated access by role) is asserted in
 * `permission-visibility.spec.ts` — that spec owns the role-matrix walk.
 *
 * Auth: pre-authenticated storage states per e2e/auth.setup.ts.
 */

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------
// AC-199 — Form conditional fields by event class
// ---------------------------------------------------------------
test.describe('AC-199: rule-editor form renders conditional fields per eventClass', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  test('Ziel-Status is rendered only for transition events; hidden otherwise', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'benachrichtigungen');
    await expect(page.getByTestId('notification-rules-view')).toBeVisible();

    await page.getByTestId('notification-rule-create-button').click();

    // Select a transition event — Ziel-Status must be visible.
    await page
      .getByTestId('notification-rule-event-select')
      .selectOption('project.transition_forward');
    await expect(page.getByTestId('notification-rule-state-filter')).toBeVisible();

    // Switch to a non-transition event — Ziel-Status must disappear.
    await page.getByTestId('notification-rule-event-select').selectOption('project.archived');
    await expect(page.getByTestId('notification-rule-state-filter')).toHaveCount(0);
  });

  test('"Zugewiesene Mitarbeiter benachrichtigen" toggle is disabled on backup.failed / disk.threshold_reached', async ({
    page,
  }) => {
    await page.goto('/');
    await clickView(page, 'benachrichtigungen');
    await page.getByTestId('notification-rule-create-button').click();

    // Project-scoped event — toggle enabled.
    await page
      .getByTestId('notification-rule-event-select')
      .selectOption('project.transition_forward');
    await expect(page.getByTestId('notification-rule-assigned-workers-toggle')).toBeEnabled();

    // Non-project-scoped event — toggle disabled AND forced false.
    await page.getByTestId('notification-rule-event-select').selectOption('backup.failed');
    const toggle = page.getByTestId('notification-rule-assigned-workers-toggle');
    await expect(toggle).toBeDisabled();
    // The toggle's checked state must be false when disabled by event
    // class — the UI contract is "disabled AND forced false".
    await expect(toggle).not.toBeChecked();

    // Same for disk.threshold_reached.
    await page.getByTestId('notification-rule-event-select').selectOption('disk.threshold_reached');
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
  });
});

// ---------------------------------------------------------------
// Basic flow — create → list → edit → delete
// ---------------------------------------------------------------
//
// Not a standalone AC; this is the end-to-end sanity on the CRUD UI
// that AC-189..AC-193 collectively describe. Runs in order; each
// step depends on the previous.
test.describe('Notification Rules CRUD flow (owner)', () => {
  test.use({ storageState: STORAGE_STATES.owner });

  const ruleEventClass = 'project.transition_forward';

  test('create rule appears in the list', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'benachrichtigungen');

    await page.getByTestId('notification-rule-create-button').click();
    await page.getByTestId('notification-rule-event-select').selectOption(ruleEventClass);
    // Select owner role as recipient so the spec is non-empty.
    await page.getByTestId('notification-rule-role-owner').check();
    await page.getByTestId('notification-rule-enabled-toggle').check();
    await page.getByTestId('notification-rule-submit').click();

    // Row lands in the list — the Ereignis cell carries the event
    // class's German label (from [C] event-class mapping).
    await expect(page.getByTestId('notification-rules-list')).toBeVisible();
    const row = page.locator('[data-testid^="notification-rule-row-"]').first();
    await expect(row).toBeVisible();
  });

  test('edit rule toggles Aktiv state', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'benachrichtigungen');

    const row = page.locator('[data-testid^="notification-rule-row-"]').first();
    await row.getByTestId('notification-rule-edit-button').click();

    // Flip Aktiv off.
    const enabled = page.getByTestId('notification-rule-enabled-toggle');
    await enabled.uncheck();
    await page.getByTestId('notification-rule-submit').click();

    // Row's Aktiv indicator should reflect the new state.
    await expect(row.getByTestId('notification-rule-enabled-indicator')).toHaveAttribute(
      'data-enabled',
      'false',
    );
  });

  test('delete rule removes it from the list', async ({ page }) => {
    await page.goto('/');
    await clickView(page, 'benachrichtigungen');

    const list = page.getByTestId('notification-rules-list');
    // `fetchRules` lands asynchronously after the view mounts — poll
    // until at least one row is in the DOM before snapshotting the
    // count, otherwise the first read races the fetch and returns 0.
    await expect
      .poll(async () => list.locator('[data-testid^="notification-rule-row-"]').count())
      .toBeGreaterThan(0);
    const initialCount = await list.locator('[data-testid^="notification-rule-row-"]').count();

    const firstRow = list.locator('[data-testid^="notification-rule-row-"]').first();
    await firstRow.getByTestId('notification-rule-delete-button').click();

    // German confirmation dialog — confirm. Scoped to the dialog's
    // own testid because the role/name regex would otherwise collide
    // with the row-level "Löschen" buttons under strict mode.
    await page.getByTestId('confirm-ok').click();

    await expect
      .poll(async () => list.locator('[data-testid^="notification-rule-row-"]').count())
      .toBeLessThan(initialCount);
  });
});
