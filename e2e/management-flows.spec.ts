import { test, expect } from '@playwright/test';
import { clickView } from './nav-helpers';

/**
 * E2E Management flows
 *
 * Covers §16.4 steps 18–24: customer CRUD, project CRUD, user management.
 *
 * These tests are written ahead of the implementation (TDD). They define
 * the expected end-to-end behavior for management views introduced in
 * iteration 6. They will fail until the corresponding views, routes,
 * and services are implemented.
 *
 * Tests run serially because each step depends on the previous:
 *   18. Create customer → 19. Create project referencing that customer →
 *   20. Verify in Kanban → 21. Edit project → 22. Create user →
 *   23. Deactivate user → 24. Reactivate user
 *
 * Seed data assumptions (inherited from auth.setup.ts):
 *   - User: inhaber / changeme (Thomas Berger, owner)
 *   - Auth storageState consumed from shared setup
 *
 * Test IDs follow the established naming convention (kebab-case, prefixed
 * by feature area). The actual component implementation must use these
 * data-testid values for the tests to pass.
 */

test.describe.configure({ mode: 'serial' });

test.describe('Management flows', () => {
  /** Customer name created in step 18, referenced in step 19. */
  const testCustomerName = 'E2E Testkunde GmbH';

  /** Project number created in step 19, used for search in step 21. */
  const testProjectNumber = 'E2E-001';
  const testProjectTitle = 'Fassadenreinigung E2E-Test';

  /** Username created in step 22, used for deactivation/reactivation. */
  const testUsername = 'e2e_worker';
  const testPassword = 'E2eSecure123!';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 18: Create customer
  // AC-54, AC-81, AC-85
  // ---------------------------------------------------------------
  test('step 18: navigate to Customer view and create a customer', async ({ page }) => {
    // Navigate to the Customer Management view
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    // Open create form
    await page.getByTestId('customer-create-button').click();

    // Fill required + optional fields
    await page.getByTestId('customer-name-input').fill(testCustomerName);
    await page.getByTestId('customer-street-input').fill('Industriestr. 42');
    await page.getByTestId('customer-zip-input').fill('50667');
    await page.getByTestId('customer-city-input').fill('Köln');

    // Submit
    await page.getByTestId('customer-submit').click();

    // Verify the customer appears in the table
    await expect(page.getByText(testCustomerName)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 19: Create project referencing the new customer
  // AC-59, AC-77, AC-85
  // ---------------------------------------------------------------
  test('step 19: navigate to Project view and create a project', async ({ page }) => {
    // Navigate to the Project Management view
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    // Open create form
    await page.getByTestId('project-create-button').click();

    // Fill required fields
    await page.getByTestId('project-number-input').fill(testProjectNumber);
    await page.getByTestId('project-title-input').fill(testProjectTitle);

    // Select the customer created in step 18
    await page.getByTestId('project-customer-select').click();
    await page.getByText(testCustomerName).click();

    // Submit
    await page.getByTestId('project-submit').click();

    // Verify the project appears in the table
    await expect(page.getByText(testProjectNumber)).toBeVisible();
    await expect(page.getByText(testProjectTitle)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 20: New project appears in Kanban under first state
  // AC-77
  // ---------------------------------------------------------------
  test('step 20: new project appears in Kanban board under Anfrage', async ({ page }) => {
    // Navigate to Kanban view
    await page.getByTestId('view-toggle-kanban').click();
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The new project should be in the Anfrage column (first workflow state)
    const anfrage = page.getByTestId('kanban-column-anfrage');
    await expect(anfrage.getByText(testProjectTitle)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 21: Search and edit project notes
  // AC-76, AC-78
  // ---------------------------------------------------------------
  test('step 21: search project in management view and edit notes', async ({ page }) => {
    // Navigate to Project Management view
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    // Search for the project by number
    await page.getByTestId('project-search').fill(testProjectNumber);
    await expect(page.getByText(testProjectTitle)).toBeVisible();

    // Clicking the project navigates to the detail page — the primary
    // edit surface. Notes live there as an editable textarea that
    // saves on blur.
    await page.getByText(testProjectTitle).click();

    const notes = page.getByTestId('project-notes-input');
    await notes.waitFor({ state: 'visible' });
    await notes.fill('Gerüst bestellt, Lieferung Montag');
    // Save-on-blur: move focus off the field to trigger the PATCH.
    await page.getByTestId('project-title-edit').focus();

    // Navigate away and back; the notes value must persist across the
    // round-trip.
    await page.getByTestId('view-toggle-projekte').click();
    await page.getByText(testProjectTitle).click();
    await expect(page.getByTestId('project-notes-input')).toHaveValue(
      'Gerüst bestellt, Lieferung Montag',
    );
  });

  // ---------------------------------------------------------------
  // Step 22: Create a user with worker role
  // AC-63, AC-82, AC-83
  // ---------------------------------------------------------------
  test('step 22: navigate to User view and create a worker user', async ({ page }) => {
    // Navigate to the User Management view
    await clickView(page, 'benutzer');
    await expect(page.getByTestId('user-table')).toBeVisible();

    // Open create form
    await page.getByTestId('user-create-button').click();

    // Fill fields
    await page.getByTestId('user-username-input').fill(testUsername);
    await page.getByTestId('user-displayname-input').fill('E2E Testarbeiter');
    await page.getByTestId('user-password-input').fill(testPassword);
    await page.getByTestId('user-password-confirm-input').fill(testPassword);
    await page.getByTestId('user-role-worker').check();

    // Submit
    await page.getByTestId('user-submit').click();

    // Verify the user appears in the table — anchor on the unique
    // username so the row-lookup doesn't depend on the display-name
    // copy (which is brittle if a future test reuses similar labels).
    await expect(page.getByText(testUsername)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 23: Deactivate user — verify can't log in
  // AC-65, AC-84
  // ---------------------------------------------------------------
  test('step 23: deactivate user and verify login is blocked', async ({ page, browser }) => {
    // Navigate to User Management
    await clickView(page, 'benutzer');
    await expect(page.getByTestId('user-table')).toBeVisible();

    // Find and deactivate the test user
    const userRow = page.getByText('E2E Testarbeiter');
    await userRow.click();
    await page.getByTestId('user-deactivate-button').click();

    // Confirm deactivation — wait for the API response so the DB state
    // is settled before we verify login behavior in a fresh context.
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/deactivate') && resp.ok()),
      page.getByTestId('confirm-ok').click(),
    ]);

    // Verify the user is shown as deactivated
    await expect(page.getByText('E2E Testarbeiter')).toBeVisible();
    // Deactivated users should be visually distinct (e.g., grayed out, badge)

    // Verify in a separate browser context that the deactivated user can't log in
    const freshContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 1920, height: 1080 },
    });
    const freshPage = await freshContext.newPage();
    try {
      await freshPage.goto('/');
      await freshPage.getByTestId('login-username').fill(testUsername);
      await freshPage.getByTestId('login-password').fill(testPassword);
      await freshPage.getByTestId('login-submit').click();

      // Should see error, NOT the Kanban board
      await expect(freshPage.getByTestId('login-error')).toBeVisible();
      await expect(freshPage.getByTestId('kanban-board')).not.toBeVisible();
    } finally {
      await freshContext.close();
    }
  });

  // ---------------------------------------------------------------
  // Step 24: Reactivate user — verify can log in again
  // AC-66
  // ---------------------------------------------------------------
  test('step 24: reactivate user and verify login works', async ({ page, browser }) => {
    // Navigate to User Management
    await clickView(page, 'benutzer');
    await expect(page.getByTestId('user-table')).toBeVisible();

    // Find and reactivate the test user
    const userRow = page.getByText('E2E Testarbeiter');
    await userRow.click();
    await page.getByTestId('user-reactivate-button').click();

    // Confirm reactivation
    const confirmDialog = page.getByTestId('confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    // Wait for the reactivation API to complete before verifying login —
    // without this, the fresh context can race the async handler and
    // attempt login while the user is still deactivated in the DB.
    const [reactivateResponse] = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/reactivate') && resp.ok()),
      page.getByTestId('confirm-ok').click(),
    ]);
    expect(reactivateResponse.ok()).toBe(true);

    // Verify the user can log in from a separate browser context
    const freshContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 1920, height: 1080 },
    });
    const freshPage = await freshContext.newPage();
    try {
      await freshPage.goto('/');
      await freshPage.getByTestId('login-username').fill(testUsername);
      await freshPage.getByTestId('login-password').fill(testPassword);
      await freshPage.getByTestId('login-submit').click();

      // Worker landing is /meine-projekte (the personal list).
      await expect(freshPage.getByTestId('my-projects-view')).toBeVisible();
    } finally {
      await freshContext.close();
    }
  });

  // ---------------------------------------------------------------
  // AC-122: Modal keyboard contract — Esc closes, Enter submits the
  // primary action when focus is in the form. These tests reuse the
  // customer created in step 18 and the user created in step 22, but
  // make no DB changes — Esc cancels the create form, Enter on the
  // password change modal submits but rejects (wrong current pw).
  // ---------------------------------------------------------------
  test('AC-122: Esc closes the customer create modal without saving', async ({ page }) => {
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    await page.getByTestId('customer-create-button').click();
    const nameInput = page.getByTestId('customer-name-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Esc-Test (should not persist)');

    await page.keyboard.press('Escape');

    // Modal closed — name input no longer in the DOM.
    await expect(nameInput).toBeHidden();
    // The not-yet-saved customer must not appear in the table.
    await expect(page.getByText('Esc-Test (should not persist)')).toHaveCount(0);
  });

  test('AC-122: Enter in the customer edit form submits the primary action', async ({ page }) => {
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    // Open the customer created in step 18 by clicking its row.
    await page.getByText(testCustomerName).click();

    const nameInput = page.getByTestId('customer-name-input');
    await expect(nameInput).toBeVisible();
    // Edit the name (this is reverted at the end of the test for net-zero).
    const editedName = `${testCustomerName} (Enter-Test)`;
    await nameInput.fill(editedName);

    // Press Enter while the input is focused — the form submits.
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/api/customers') && resp.ok()),
      nameInput.press('Enter'),
    ]);
    // Modal closes after a successful save.
    await expect(nameInput).toBeHidden();
    await expect(page.getByText(editedName)).toBeVisible();

    // Net-zero teardown: revert the name back so later assertions
    // referencing testCustomerName still resolve.
    await page.getByText(editedName).click();
    const reopenInput = page.getByTestId('customer-name-input');
    await reopenInput.fill(testCustomerName);
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/api/customers') && resp.ok()),
      reopenInput.press('Enter'),
    ]);
    await expect(reopenInput).toBeHidden();
    await expect(page.getByText(testCustomerName)).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Mitarbeiter (assignee) filter on the project management page.
  // Drives the popover that wraps GET /api/workers + the
  // assignedWorkerIds / includeUnassigned query params on
  // GET /api/projects. Three flows: (1) filter narrows to one
  // worker, (2) "Nicht zugewiesen" ORs in unassigned projects,
  // (3) clear chip restores the full list.
  //
  // Assertions are anchored on "every visible row matches the
  // selection" rather than on absolute counts — earlier serial
  // tests mutate the seed (create / edit / archive), so a fixed
  // count would be brittle. The seeded worker `Jan Nowak` is the
  // assignment anchor: stable across the suite because no test
  // touches his assignments.
  // ---------------------------------------------------------------
  test('Mitarbeiter filter narrows the list to the selected worker', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    await page.getByTestId('worker-filter-toggle').click();
    await expect(page.getByTestId('worker-filter-popover')).toBeVisible();

    // Pick Jan Nowak — the seed assigns him to several projects, so the
    // resulting list is non-empty even after earlier serial tests have
    // touched the seed.
    const janOption = page.getByTestId('worker-filter-popover').getByText('Jan Nowak');
    await janOption.click();

    // Toggle button label flips to "Mitarbeiter (1)" with the count.
    await expect(page.getByTestId('worker-filter-toggle')).toContainText('Mitarbeiter (1)');

    // Close the popover so the table is the only visible source of
    // worker-name text — otherwise the popover's option labels would
    // also satisfy the row-cell assertions below.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('worker-filter-popover')).toBeHidden();

    const rows = page.getByTestId('project-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible();

    // Every visible row must show Jan Nowak in the Mitarbeiter cell.
    // The cell is the 4th td (Nummer / Titel / Kunde / Mitarbeiter).
    const workerCells = rows.locator('td:nth-child(4)');
    const count = await workerCells.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(workerCells.nth(i)).toContainText('Jan Nowak');
    }
  });

  test('Mitarbeiter filter ORs in unassigned projects via "Nicht zugewiesen"', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    await page.getByTestId('worker-filter-toggle').click();
    await page.getByTestId('worker-filter-popover').getByText('Jan Nowak').click();
    // Capture the Jan-only count so we can assert the union grows.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('worker-filter-popover')).toBeHidden();
    const rows = page.getByTestId('project-table').locator('tbody tr');
    const janOnlyCount = await rows.count();

    // Re-open the popover and add the unassigned branch.
    await page.getByTestId('worker-filter-toggle').click();
    await page.getByTestId('worker-filter-option-unassigned').getByRole('checkbox').check();
    await expect(page.getByTestId('worker-filter-toggle')).toContainText('Mitarbeiter (2)');
    await page.keyboard.press('Escape');

    // `locator.count()` is a one-shot read with no auto-retry, and the
    // toggle's own label updates before the table re-renders — so a
    // bare count here races the re-render and returns the Jan-only rows
    // (both counts 4, union "not greater"). `expect.poll` retries the
    // read until the union lands. The Jan-only count above is shielded
    // by the `toBeHidden()` wait preceding it.
    await expect.poll(() => rows.count()).toBeGreaterThan(janOnlyCount);

    // Every row matches Jan Nowak OR has an empty workers cell ("—").
    const workerCells = rows.locator('td:nth-child(4)');
    const total = await workerCells.count();
    for (let i = 0; i < total; i++) {
      const text = (await workerCells.nth(i).textContent())?.trim() ?? '';
      expect(text === '—' || text.includes('Jan Nowak')).toBe(true);
    }
  });

  test('Mitarbeiter filter clear chip restores the full list', async ({ page }) => {
    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    const rows = page.getByTestId('project-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const fullCount = await rows.count();

    await page.getByTestId('worker-filter-toggle').click();
    await page.getByTestId('worker-filter-popover').getByText('Jan Nowak').click();
    await page.keyboard.press('Escape');

    const filteredCount = await rows.count();
    expect(filteredCount).toBeLessThan(fullCount);

    // Click the × adjacent to the toggle to wipe the selection.
    await page.getByTestId('worker-filter-clear').click();
    await expect(page.getByTestId('worker-filter-toggle')).toHaveText('Mitarbeiter filtern');
    await expect(rows).toHaveCount(fullCount);
  });

  // ---------------------------------------------------------------
  // AC-123: Backdrop click does not close form modals. Protects
  // against accidental loss of typed data.
  // ---------------------------------------------------------------
  test('AC-123: clicking the backdrop does not close the customer create modal', async ({
    page,
  }) => {
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    await page.getByTestId('customer-create-button').click();
    const nameInput = page.getByTestId('customer-name-input');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Backdrop-Test (must persist)');

    // Click on the overlay — the area outside the form panel. The
    // modal must remain open and the typed value must survive.
    const panel = page.locator('form', { has: page.getByTestId('customer-name-input') });
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Click 10px left of the panel's left edge — guaranteed outside.
    await page.mouse.click(box!.x - 10, box!.y + 20);

    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('Backdrop-Test (must persist)');

    // Clean teardown — close via Esc (AC-122).
    await page.keyboard.press('Escape');
    await expect(nameInput).toBeHidden();
  });
});
