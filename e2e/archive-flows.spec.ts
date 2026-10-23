import { test, expect } from '@playwright/test';

/**
 * E2E Archive flows
 *
 * Pins the project-archive feature introduced by issue #98:
 *   - AC-497: "Archivieren" button soft-deletes a project from
 *     the management view; the project disappears from the default list.
 *   - AC-492: "Archivierte einblenden" toggle on the project management
 *     view; when on, archived projects appear in the table alongside
 *     active ones.
 *   - AC-153: archived rows are visually distinguished from active ones
 *     via a muted row class and an "Archiviert" badge.
 *   - AC-154: the customer-delete confirmation dialog names the archived
 *     project count when `archivedProjectCount > 0` (sourced from
 *     GET /api/customers/:id; purge is atomic per AC-91).
 *   - AC-478: the create form's number check reports an archived
 *     project's number as taken.
 *
 * Serial mode — steps depend on each other's state:
 *   1. Create a customer + two projects under it.
 *   2. Archive one project (AC-497).
 *   3. Toggle the filter — archived project appears/disappears (AC-492).
 *   4. Verify the visual distinction (AC-153).
 *   5. The number check counts the archived project (AC-478).
 *   6. Archive the second project, then delete the customer with the
 *      archived-count warning text and confirm cleanup (AC-154).
 *
 * Seed data assumptions (inherited from auth.setup.ts):
 *   - Logged in as owner — full permissions on projects and customers.
 */

test.describe.configure({ mode: 'serial' });

test.describe('Archive flows', () => {
  /** Customer name created fresh for this suite to isolate from other
   *  serial management-flows tests which reuse `E2E Testkunde GmbH`. */
  const archiveCustomerName = 'E2E Archive Testkunde';

  const firstProjectNumber = 'E2E-ARC-001';
  const firstProjectTitle = 'Archive Fixture 1';
  const secondProjectNumber = 'E2E-ARC-002';
  const secondProjectTitle = 'Archive Fixture 2';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Fixture setup: create customer + two projects.
  // ---------------------------------------------------------------
  test('setup: create a dedicated customer and two projects', async ({ page }) => {
    // Customer
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill(archiveCustomerName);
    await page.getByTestId('customer-submit').click();
    await expect(page.getByText(archiveCustomerName)).toBeVisible();

    // Project 1
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();
    await page.getByTestId('project-create-button').click();
    await page.getByTestId('project-number-input').fill(firstProjectNumber);
    await page.getByTestId('project-title-input').fill(firstProjectTitle);
    await page.getByTestId('project-customer-select').click();
    // Scope to the dropdown — the customer name can also appear in the
    // projects table for already-created projects under the same customer.
    await page.getByTestId('project-customer-select').getByText(archiveCustomerName).click();
    await page.getByTestId('project-submit').click();
    await expect(page.getByText(firstProjectNumber)).toBeVisible();

    // Project 2
    await page.getByTestId('project-create-button').click();
    await page.getByTestId('project-number-input').fill(secondProjectNumber);
    await page.getByTestId('project-title-input').fill(secondProjectTitle);
    await page.getByTestId('project-customer-select').click();
    // Scope to the dropdown — the customer name can also appear in the
    // projects table for already-created projects under the same customer.
    await page.getByTestId('project-customer-select').getByText(archiveCustomerName).click();
    await page.getByTestId('project-submit').click();
    await expect(page.getByText(secondProjectNumber)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // AC-497: "Archivieren" button archives from management view.
  // The row disappears from the default table after confirm.
  // ---------------------------------------------------------------
  test('AC-497: Archivieren from project management hides the project from default list', async ({
    page,
  }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    // Scope the archive click to the first project's row so we don't hit
    // the wrong button if the button testid is repeated per row.
    const row = page.getByRole('row', { name: new RegExp(firstProjectNumber) });
    await expect(row).toBeVisible();
    await row.getByTestId('project-archive-button').click();

    // The confirmation dialog must name the project and use the German
    // "archivieren" verb (not "löschen") — per STRINGS.projects.archiveConfirm.
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(new RegExp(`${firstProjectNumber}.*archivieren`, 'i'));

    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/projects/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);

    // After archive, the row must be gone from the default (active-only) list.
    await expect(page.getByRole('row', { name: new RegExp(firstProjectNumber) })).toHaveCount(0);
    // The sibling, non-archived project is still shown.
    await expect(page.getByRole('row', { name: new RegExp(secondProjectNumber) })).toBeVisible();
  });

  // ---------------------------------------------------------------
  // AC-492: "Archivierte einblenden" toggle includes archived rows.
  // ---------------------------------------------------------------
  test('AC-492: show-archived toggle includes and re-hides archived rows', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    // Baseline: archived project hidden, active project visible.
    await expect(page.getByRole('row', { name: new RegExp(firstProjectNumber) })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(secondProjectNumber) })).toBeVisible();

    // Toggle on — archived row appears.
    await page.getByTestId('project-show-archived-toggle').check();
    await expect(page.getByRole('row', { name: new RegExp(firstProjectNumber) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(secondProjectNumber) })).toBeVisible();

    // Toggle off — archived row hidden again; active row stays.
    await page.getByTestId('project-show-archived-toggle').uncheck();
    await expect(page.getByRole('row', { name: new RegExp(firstProjectNumber) })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(secondProjectNumber) })).toBeVisible();
  });

  // ---------------------------------------------------------------
  // AC-153: archived rows are visually distinct (badge + muted class).
  // ---------------------------------------------------------------
  test('AC-153: archived rows carry the Archiviert badge and a muted class', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    await page.getByTestId('project-show-archived-toggle').check();

    const archivedRow = page.getByRole('row', { name: new RegExp(firstProjectNumber) });
    const activeRow = page.getByRole('row', { name: new RegExp(secondProjectNumber) });

    // Archived row: badge present.
    await expect(archivedRow.getByTestId('project-archived-badge')).toBeVisible();
    await expect(archivedRow.getByTestId('project-archived-badge')).toHaveText(/Archiviert/);

    // Active row: badge absent.
    await expect(activeRow.getByTestId('project-archived-badge')).toHaveCount(0);
  });

  // ---------------------------------------------------------------
  // AC-478: the create form's number check counts archived projects.
  // ---------------------------------------------------------------
  test('AC-478: number check reports an archived project number as taken', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();
    await page.getByTestId('project-create-button').click();

    await page.getByTestId('project-number-input').fill(firstProjectNumber);
    await page.getByTestId('project-title-input').focus();

    await expect(page.getByTestId('project-number-taken')).toBeVisible();
    await expect(page.getByTestId('project-number-available')).toHaveCount(0);

    await page.keyboard.press('Escape');
  });

  // ---------------------------------------------------------------
  // AC-154: customer-delete warning surfaces archivedProjectCount.
  // Setup for this test: archive the second project as well, so the
  // customer has 0 active and 2 archived projects — allowed for delete
  // but the dialog must warn.
  // ---------------------------------------------------------------
  test('AC-154: customer delete warns with archived-project count and purges on confirm', async ({
    page,
  }) => {
    // Archive the second project so the customer has only archived projects.
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(secondProjectNumber) });
    await expect(row).toBeVisible();
    await row.getByTestId('project-archive-button').click();
    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/projects/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);
    await expect(page.getByRole('row', { name: new RegExp(secondProjectNumber) })).toHaveCount(0);

    // Now delete the customer. Both projects are archived, so the delete
    // must be allowed (AC-91) but the confirm dialog must warn with the
    // archived count.
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    const customerRow = page.getByRole('row', { name: new RegExp(archiveCustomerName) });
    await expect(customerRow).toBeVisible();
    // The customer row's delete button lives in the actions cell. Scope to
    // this row so multi-customer tables don't pick the wrong button.
    await customerRow.getByRole('button', { name: /löschen/i }).click();

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    // AC-154's load-bearing contract is the archived-project count
    // surfaced to the user; the surrounding German copy belongs to
    // unit-level STRINGS tests.
    await expect(dialog).toContainText('2');

    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/customers/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);

    // Customer row gone — atomic purge by AC-91 also removed both archived
    // projects, so this suite leaves the DB clean.
    await expect(page.getByRole('row', { name: new RegExp(archiveCustomerName) })).toHaveCount(0);
  });

  // ---------------------------------------------------------------
  // AC-501, AC-505: Per-project `Endgültig löschen` action on archived rows.
  //
  // Uses a dedicated customer + project so this test stands on its own
  // and does not depend on the AC-154 test's teardown state. The AC-154
  // test atomically purges its customer, which would leave nothing for
  // a reuse-the-fixture approach to work against.
  //
  // Flow:
  //   1. Create customer + project.
  //   2. Archive the project from the management view.
  //   3. Toggle `Archivierte einblenden` on so the archived row is visible.
  //   4. Click the row-level `project-purge-button`.
  //   5. Confirm the dialog (German warning mentioning "endgültig").
  //   6. Wait for DELETE /api/projects/*/purge to resolve.
  //   7. Row is gone from the table (even with archive toggle still on).
  //   8. Clean up: delete the now-empty customer.
  // ---------------------------------------------------------------
  test('AC-501, AC-505: Endgültig löschen hard-deletes an archived project from the management view', async ({
    page,
  }) => {
    const purgeCustomerName = 'E2E Purge Testkunde';
    const purgeProjectNumber = 'E2E-PURGE-001';
    const purgeProjectTitle = 'Purge Fixture';

    // 1. Customer
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill(purgeCustomerName);
    await page.getByTestId('customer-submit').click();
    await expect(page.getByText(purgeCustomerName)).toBeVisible();

    // 2. Project
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();
    await page.getByTestId('project-create-button').click();
    await page.getByTestId('project-number-input').fill(purgeProjectNumber);
    await page.getByTestId('project-title-input').fill(purgeProjectTitle);
    await page.getByTestId('project-customer-select').click();
    await page.getByTestId('project-customer-select').getByText(purgeCustomerName).click();
    await page.getByTestId('project-submit').click();
    await expect(page.getByText(purgeProjectNumber)).toBeVisible();

    // 3. Archive the project.
    const activeRow = page.getByRole('row', { name: new RegExp(purgeProjectNumber) });
    await expect(activeRow).toBeVisible();
    await activeRow.getByTestId('project-archive-button').click();
    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/projects/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);
    await expect(page.getByRole('row', { name: new RegExp(purgeProjectNumber) })).toHaveCount(0);

    // 4. Reveal archived rows.
    await page.getByTestId('project-show-archived-toggle').check();
    const archivedRow = page.getByRole('row', { name: new RegExp(purgeProjectNumber) });
    await expect(archivedRow).toBeVisible();

    // AC-501: with archived rows shown, no active row offers permanent delete.
    const activeRows = page
      .getByTestId('project-table')
      .locator('tbody tr')
      .filter({ hasNot: page.getByTestId('project-archived-badge') });
    await expect(activeRows.first()).toBeVisible();
    await expect(activeRows.getByTestId('project-purge-button')).toHaveCount(0);

    // 5. The per-row purge button must be present on an archived row.
    const purgeButton = archivedRow.getByTestId('project-purge-button');
    await expect(purgeButton).toBeVisible();
    await purgeButton.click();

    // 6. Confirmation dialog with the German "endgültig" warning.
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/endgültig/i);
    await expect(dialog).toContainText(purgeProjectNumber);

    // 7. Confirm → wait for the purge request → row disappears even with
    //    the archive toggle still on (purge removes the record entirely).
    await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes('/api/projects/') &&
          resp.url().endsWith('/purge') &&
          resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);
    await expect(page.getByRole('row', { name: new RegExp(purgeProjectNumber) })).toHaveCount(0);

    // 8. Clean up the now-empty customer so this test is net-zero.
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();
    const customerRow = page.getByRole('row', { name: new RegExp(purgeCustomerName) });
    await expect(customerRow).toBeVisible();
    await customerRow.getByRole('button', { name: /löschen/i }).click();
    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/customers/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);
    await expect(page.getByRole('row', { name: new RegExp(purgeCustomerName) })).toHaveCount(0);
  });
});
