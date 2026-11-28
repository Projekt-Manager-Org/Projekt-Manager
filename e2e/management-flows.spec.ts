import { test, expect, type Page } from '@playwright/test';
import { clickView } from './nav-helpers';
import { STRINGS } from '../src/config/strings';

/**
 * E2E Management flows
 *
 * Covers customer CRUD, project CRUD, user management.
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

interface ApiAddress {
  street: string;
  zip: string;
  city: string;
}

interface ApiCustomer {
  id: string;
  name: string;
  address: ApiAddress | null;
}

interface ApiProject {
  id: string;
  number: string;
  title: string;
  siteAddress: ApiAddress | null;
}

/** The Baustelle toggle's label (ui/management.md §8.8.2). */
const SITE_TOGGLE = 'Identisch mit Kundenadresse';

/** The Baustelle group's address inputs, in street, zip, city order. */
const SITE_FIELDS = ['street', 'zip', 'city'] as const;

async function apiPost<T>(page: Page, url: string, data: object): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `POST ${url} returned ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function apiGet<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(url);
  expect(res.ok(), `GET ${url} returned ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

async function allCustomers(page: Page): Promise<ApiCustomer[]> {
  return (await apiGet<{ customers: ApiCustomer[] }>(page, '/api/customers')).customers;
}

/**
 * Lets the next create POST to `path` reach the server, then drops its
 * response, as a lost connection would: the server stores the row and the
 * form, seeing a failure, stays open with its client-supplied id. Resolves
 * with that id once the browser has seen the failure.
 */
async function loseNextCreateResponse(page: Page, path: string, submit: () => Promise<void>) {
  let createId: string | undefined;
  const matcher = (url: URL) => url.pathname === path;
  await page.route(matcher, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    createId = (route.request().postDataJSON() as { id: string }).id;
    await route.fetch();
    await route.abort('failed');
  });
  const failed = page.waitForEvent(
    'requestfailed',
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === path,
  );
  await submit();
  await failed;
  await page.unroute(matcher);
  expect(createId, 'the create carried a client-supplied id').toBeDefined();
  return createId!;
}

test.describe('Management flows', () => {
  /** Customer name created in step 18, referenced in step 19. */
  const testCustomerName = 'E2E Testkunde GmbH';

  /** Project number created in step 19, used for search in step 21. */
  const testProjectNumber = 'E2E-001';
  const testProjectTitle = 'Fassadenreinigung E2E-Test';

  /** Username created in step 22, used by the later user steps. */
  const testUsername = 'e2e_worker';
  const testPassword = 'E2eSecure123!';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Step 18: Create customer
  // AC-518, AC-539
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
  // AC-526, AC-519: a row opens the edit form; saving stores the values,
  // an emptied field as empty. Net-zero: the address goes and comes back.
  // ---------------------------------------------------------------
  test('AC-526, AC-519: edit a customer from its row, emptying and refilling the address', async ({
    page,
  }) => {
    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(testCustomerName) });
    await expect(row).toContainText('Köln');

    await page.getByText(testCustomerName).click();
    await expect(page.getByTestId('customer-name-input')).toHaveValue(testCustomerName);
    await page.getByTestId('customer-street-input').fill('');
    await page.getByTestId('customer-zip-input').fill('');
    await page.getByTestId('customer-city-input').fill('');
    await page.getByTestId('customer-save').click();
    await expect(page.getByTestId('customer-save')).toBeHidden();
    await expect(row).not.toContainText('Köln');

    await page.reload();
    await page.getByTestId('view-toggle-kunden').click();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('Köln');

    await page.getByText(testCustomerName).click();
    await page.getByTestId('customer-street-input').fill('Industriestr. 42');
    await page.getByTestId('customer-zip-input').fill('50667');
    await page.getByTestId('customer-city-input').fill('Köln');
    await page.getByTestId('customer-save').click();
    await expect(page.getByTestId('customer-save')).toBeHidden();
    await expect(row).toContainText('Köln');
  });

  // ---------------------------------------------------------------
  // AC-85: no page load between creating the customer and its project.
  // ---------------------------------------------------------------
  test('AC-85: create a project for a new customer without a page reload', async ({ page }) => {
    const stamp = Date.now();
    const name = `E2E Ohne Reload ${stamp}`;
    const number = `E2E-${stamp % 1_000_000_000}`;
    await page.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });

    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill(name);
    await page.getByTestId('customer-submit').click();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();

    await page.getByTestId('view-toggle-projekte').click();
    await page.getByTestId('project-create-button').click();
    await page.getByTestId('project-number-input').fill(number);
    await page.getByTestId('project-title-input').fill('Ohne Reload');
    await page.getByTestId('project-customer-select').click();
    await page.getByText(name).click();
    await page.getByTestId('project-submit').click();
    await expect(page.getByText(number)).toBeVisible();

    const sameDocument = await page.evaluate(
      () => (window as unknown as { __sameDocument?: boolean }).__sameDocument,
    );
    expect(sameDocument).toBe(true);
  });

  // ---------------------------------------------------------------
  // AC-524, AC-525: the customer list searches and sorts.
  // ---------------------------------------------------------------
  test('AC-524, AC-525: search narrows the customer list; a header click reverses it', async ({
    page,
  }) => {
    await page.getByTestId('view-toggle-kunden').click();
    const rows = page.getByTestId('customer-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const firstBySortedName = await rows.first().locator('td').first().innerText();
    expect(await rows.count()).toBeGreaterThan(1);

    await page.getByTestId('customer-sort-name').click();
    await expect(rows.first().locator('td').first()).not.toHaveText(firstBySortedName);

    await page.getByTestId('customer-search').fill(testCustomerName.toLowerCase());
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(testCustomerName);
    await page.getByTestId('customer-search').fill('');
  });

  // ---------------------------------------------------------------
  // AC-535, AC-530: a customer without archived projects is confirmed by
  // name and removed. Net-zero: the customer exists only for this test.
  // ---------------------------------------------------------------
  test('AC-535, AC-530: delete a customer without archived projects', async ({ page }) => {
    const name = `E2E Zum Loeschen ${Date.now()}`;
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill(name);
    await page.getByTestId('customer-submit').click();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: STRINGS.ui.delete }).click();
    await expect(page.getByTestId('confirm-dialog')).toContainText(name);
    await page.getByTestId('confirm-ok').click();
    await expect(row).toHaveCount(0);
  });

  // ---------------------------------------------------------------
  // Step 19: Create project referencing the new customer
  // AC-475
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
  // AC-475
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
  // AC-493, AC-496, AC-480
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
  // AC-63
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
  // AC-555, AC-563, AC-571
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

    // Verify a fresh fetch still lists the user, shown as deactivated
    await page.reload();
    await expect(page.getByText('E2E Testarbeiter')).toBeVisible();
    await expect(page.locator('tr.deactivated', { hasText: 'E2E Testarbeiter' })).toBeVisible();

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

  test('AC-554: change display name and roles from the user panel', async ({ page }) => {
    await clickView(page, 'benutzer');
    await page.getByText(testUsername).click();

    const nameInput = page.getByTestId('user-panel-displayname-input');
    await nameInput.fill('E2E Bürokraft');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/users/') && r.request().method() === 'PATCH' && r.ok(),
      ),
      nameInput.blur(),
    ]);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/users/') && r.request().method() === 'PATCH' && r.ok(),
      ),
      page.getByTestId('user-panel-role-office').check(),
    ]);
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/users/') && r.request().method() === 'PATCH' && r.ok(),
      ),
      page.getByTestId('user-panel-role-worker').uncheck(),
    ]);

    await page.reload();
    await clickView(page, 'benutzer');
    await page.getByText(testUsername).click();
    await expect(page.getByTestId('user-panel-displayname-input')).toHaveValue('E2E Bürokraft');
    await expect(page.getByTestId('user-panel-role-office')).toBeChecked();
    await expect(page.getByTestId('user-panel-role-worker')).not.toBeChecked();
  });

  // ---------------------------------------------------------------
  // AC-758, AC-759: Esc closes a dialog, Enter in a single-line field
  // submits it. Esc cancels a customer create form (nothing saved);
  // Enter saves an edit to the customer created in step 18, which the
  // test then reverts.
  // ---------------------------------------------------------------
  test('AC-758: Esc closes the customer create modal without saving', async ({ page }) => {
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

  test('AC-759: Enter in the customer edit form submits the primary action', async ({ page }) => {
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
  test('AC-495: Mitarbeiter filter narrows the list to the selected worker', async ({ page }) => {
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

  test('AC-495: Mitarbeiter filter ORs in unassigned projects via "Nicht zugewiesen"', async ({
    page,
  }) => {
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

  test('AC-495: Mitarbeiter filter clear chip restores the full list', async ({ page }) => {
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
  // AC-760: Backdrop click does not close form modals. Protects
  // against accidental loss of typed data.
  // ---------------------------------------------------------------
  test('AC-760: clicking the backdrop does not close the customer create modal', async ({
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

    // Clean teardown — close via Esc (AC-758).
    await page.keyboard.press('Escape');
    await expect(nameInput).toBeHidden();
  });

  // ---------------------------------------------------------------
  // Project forms and the project list: a test.step per [vis] AC. The
  // fixtures are created here, so each case exists whatever earlier
  // tests did; the API is the oracle for what is stored.
  // ---------------------------------------------------------------
  test('walks the project form and list ACs', async ({ page }) => {
    const stamp = Date.now() % 1_000_000_000;
    const ownSite = { street: 'Hafenstraße 9', zip: '20457', city: 'Hamburg' };
    const customer = await apiPost<ApiCustomer>(page, '/api/customers', {
      name: `Baustellenkunde ${stamp}`,
      address: { street: 'Lindenweg 3', zip: '50667', city: 'Köln' },
    });
    const createProject = (suffix: string, extra: object = {}) =>
      apiPost<ApiProject>(page, '/api/projects', {
        number: `BS${stamp}-${suffix}`,
        title: `Baustelle ${suffix}`,
        customerId: customer.id,
        ...extra,
      });
    const withSite = await createProject('E', { siteAddress: ownSite });
    const atCustomer = await createProject('K');
    const switched = await createProject('S', { siteAddress: ownSite });
    const getProject = (id: string) => apiGet<ApiProject>(page, `/api/projects/${id}`);

    // AC-494: four projects in a different order for each sortable column
    // and direction. The planned start and the estimated value each leave
    // one empty, which sorts last both ways (ui/management.md §8.8.1).
    // `steps` forward transitions put a project at that workflow position
    // (spec index.md, the state table); Abnahme makes workflow order differ
    // from both key and label order.
    const sortTag = `SO${stamp}`;
    const sortFixtures = [
      { key: 'a', title: 'b', customer: 'b', steps: 1, plannedStart: null, estimatedValue: 100 },
      {
        key: 'd',
        title: 'a',
        customer: 'c',
        steps: 2,
        plannedStart: '2031-05-02',
        estimatedValue: 300,
      },
      {
        key: 'c',
        title: 'd',
        customer: 'd',
        steps: 0,
        plannedStart: '2031-05-04',
        estimatedValue: 200,
      },
      {
        key: 'b',
        title: 'c',
        customer: 'a',
        steps: 5,
        plannedStart: '2031-05-03',
        estimatedValue: null,
      },
    ].map((f) => ({
      ...f,
      number: `${sortTag}-${f.key}`,
      title: `Sortierung ${f.title}`,
      customer: `Sortkunde ${stamp} ${f.customer}`,
    }));
    const workflow = ['anfrage', 'angebot', 'beauftragt', 'geplant', 'in_arbeit'];
    for (const f of sortFixtures) {
      const c = await apiPost<ApiCustomer>(page, '/api/customers', { name: f.customer });
      const p = await apiPost<ApiProject>(page, '/api/projects', {
        number: f.number,
        title: f.title,
        customerId: c.id,
        plannedStart: f.plannedStart,
        estimatedValue: f.estimatedValue,
      });
      for (const expectedStatus of workflow.slice(0, f.steps)) {
        const res = await page.request.post(`/api/projects/${p.id}/transition/forward`, {
          data: { expectedStatus },
        });
        expect(res.ok(), `transition of ${f.number} ${res.status()}`).toBe(true);
      }
    }

    // Every write the page sends to projects or customers.
    const writes: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() !== 'GET' && /^\/api\/(projects|customers)\b/.test(path)) {
        writes.push(`${r.method()} ${path}`);
      }
    });

    const toggle = page.getByRole('checkbox', { name: SITE_TOGGLE });
    const siteInput = (field: (typeof SITE_FIELDS)[number]) =>
      page.getByTestId(`project-site-${field}-input`);
    const expectSiteInputs = async (address: ApiAddress, enabled: boolean) => {
      for (const field of SITE_FIELDS) {
        await expect(siteInput(field)).toHaveValue(address[field]);
        if (enabled) await expect(siteInput(field)).toBeEnabled();
        else await expect(siteInput(field)).toBeDisabled();
      }
    };
    const pickCustomer = async () => {
      await page.getByTestId('project-customer-select').click();
      await page
        .getByTestId('project-customer-options')
        .getByText(customer.name, { exact: true })
        .click();
    };
    const modal = page.getByTestId('site-address-modal');
    const openSiteDialog = async (projectId: string) => {
      await page.goto(`/projects/${projectId}`);
      await page.getByTestId('project-detail-site-address-edit').click();
      await expect(modal).toBeVisible();
    };
    const cancelSiteDialog = async () => {
      await modal.getByRole('button', { name: STRINGS.ui.cancel }).click();
      await expect(modal).toHaveCount(0);
    };

    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    await test.step("AC-486 the create form's Baustelle toggle starts on", async () => {
      await page.getByTestId('project-create-button').click();
      await expect(toggle).toBeChecked();
    });

    await test.step("AC-487 while the toggle is on, the address inputs are disabled and show the customer's", async () => {
      await pickCustomer();
      await expectSiteInputs(customer.address!, false);
    });

    await test.step('AC-488 switching the toggle stores nothing until the user saves', async () => {
      const draftNumber = `BS${stamp}-N`;
      const writesBefore = writes.length;
      // The create form: switching creates no project. A submit started by
      // a switch locks or closes the form, so each switch checks it is open.
      const createOpen = () => expect(page.getByTestId('project-submit')).toBeEnabled();
      await page.getByTestId('project-number-input').fill(draftNumber);
      await page.getByTestId('project-title-input').fill('Entwurf');
      await toggle.uncheck();
      await createOpen();
      for (const field of SITE_FIELDS) await siteInput(field).fill(ownSite[field]);
      await toggle.check();
      await createOpen();
      await toggle.uncheck();
      await createOpen();
      await page.getByRole('button', { name: STRINGS.ui.cancel }).click();
      await expect(page.getByTestId('project-submit')).toHaveCount(0);
      const numbers = (await apiGet<{ data: ApiProject[] }>(page, '/api/projects')).data.map(
        (p) => p.number,
      );
      expect(numbers).not.toContain(draftNumber);

      // The edit dialog: switching leaves the stored site address alone.
      const dialogOpen = async () => {
        await expect(modal).toBeVisible();
        await expect(modal.getByTestId('project-site-save')).toBeEnabled();
      };
      await openSiteDialog(switched.id);
      await toggle.check();
      await dialogOpen();
      await expectSiteInputs(customer.address!, false);
      await toggle.uncheck();
      await dialogOpen();
      await toggle.check();
      await dialogOpen();
      await cancelSiteDialog();
      expect((await getProject(switched.id)).siteAddress).toEqual(ownSite);
      expect(writes.slice(writesBefore)).toEqual([]);

      // Saving stores the switch.
      await openSiteDialog(switched.id);
      await toggle.check();
      const [patch] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === 'PATCH' &&
            new URL(r.url()).pathname === `/api/projects/${switched.id}`,
        ),
        modal.getByTestId('project-site-save').click(),
      ]);
      expect(patch.ok(), `PATCH ${patch.status()}`).toBe(true);
      await expect(modal).toHaveCount(0);
      expect((await getProject(switched.id)).siteAddress).toBeNull();
    });

    await test.step('AC-510 the edit toggle starts off, the address filled in, exactly for an own site address', async () => {
      expect((await getProject(withSite.id)).siteAddress).toEqual(ownSite);
      await openSiteDialog(withSite.id);
      await expect(toggle).not.toBeChecked();
      await expectSiteInputs(ownSite, true);
      await cancelSiteDialog();

      expect((await getProject(atCustomer.id)).siteAddress).toBeNull();
      await openSiteDialog(atCustomer.id);
      await expect(toggle).toBeChecked();
      await expectSiteInputs(customer.address!, false);
      await cancelSiteDialog();
    });

    await page.getByTestId('view-toggle-projekte').click();
    await expect(page.getByTestId('project-table')).toBeVisible();

    await test.step('AC-494 a header click sorts the project list by its column; a second click reverses it', async () => {
      type SortFixture = (typeof sortFixtures)[number];
      const columns: [string, (f: SortFixture) => string | number | null][] = [
        ['project-sort-number', (f) => f.number],
        ['project-sort-title', (f) => f.title],
        ['project-sort-customer', (f) => f.customer],
        ['project-sort-status', (f) => f.steps],
        ['project-sort-dates', (f) => f.plannedStart],
        ['project-sort-value', (f) => f.estimatedValue],
      ];
      const order = (value: (f: SortFixture) => string | number | null, dir: 1 | -1) => {
        const filled = sortFixtures.filter((f) => value(f) !== null);
        filled.sort((a, b) => {
          const x = value(a)!;
          const y = value(b)!;
          const cmp =
            typeof x === 'number' && typeof y === 'number'
              ? x - y
              : String(x).localeCompare(String(y));
          return cmp * dir;
        });
        return [...filled, ...sortFixtures.filter((f) => value(f) === null)].map((f) => f.number);
      };

      const stored = (await apiGet<{ data: ApiProject[] }>(page, '/api/projects')).data.filter(
        (p) => p.number.startsWith(sortTag),
      );
      expect(stored).toHaveLength(sortFixtures.length);
      await page.getByTestId('project-search').fill(sortTag);
      const numberCells = page.getByTestId('project-table').locator('tbody tr td:first-child');
      await expect(numberCells).toHaveCount(sortFixtures.length);
      const shown = async () => (await numberCells.allTextContents()).map((t) => t.trim());
      const same = (a: string[], b: string[]) => a.join('\n') === b.join('\n');
      for (const [testId, value] of columns) {
        // The spec leaves the first click's direction open; the second
        // click must reverse it.
        let first: 1 | -1 | undefined;
        await page.getByTestId(testId).click();
        await expect
          .poll(
            async () => {
              const rows = await shown();
              first = same(rows, order(value, 1))
                ? 1
                : same(rows, order(value, -1))
                  ? -1
                  : undefined;
              return first;
            },
            { message: `${testId}, first click sorts by the column` },
          )
          .toBeDefined();
        await page.getByTestId(testId).click();
        await expect(numberCells, `${testId}, second click reverses`).toHaveText(
          order(value, first === 1 ? -1 : 1),
        );
      }
    });

    await test.step('AC-762 a project create refused as an idempotency conflict closes the form and shows the list', async () => {
      // A fresh, unsearched list. Clearing a search instead would refetch
      // after a debounce, and a refetch starting after the refusal clears
      // its message.
      await page.reload();
      await expect(page.getByTestId('project-table')).toBeVisible();
      await expect(page.getByTestId('project-search')).toHaveValue('');
      const number = `IK${stamp}`;
      const title = page.getByTestId('project-title-input');
      await page.getByTestId('project-create-button').click();
      await page.getByTestId('project-number-input').fill(number);
      await title.fill('Erste Fassung');
      await pickCustomer();
      const createId = await loseNextCreateResponse(page, '/api/projects', () =>
        page.getByTestId('project-submit').click(),
      );
      const stored = await getProject(createId);
      expect(stored.title).toBe('Erste Fassung');
      await expect(title).toBeEnabled();
      // The stored create's live refresh lands before the retry, as it does
      // for a user; landing after the refusal, it would clear the message.
      const row = page.getByRole('row', { name: new RegExp(number) });
      await expect(row).toContainText(stored.title);

      // The retry reuses the id with another title.
      await title.fill('Zweite Fassung');
      const [refused] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/projects',
        ),
        page.getByTestId('project-submit').click(),
      ]);
      expect(refused.status()).toBe(409);
      expect((await refused.json()).code).toBe('IDEMPOTENCY_CONFLICT');
      await expect(page.getByTestId('project-submit')).toHaveCount(0);
      await expect(page.getByText(STRINGS.errors.idempotencyConflict)).toBeVisible();
      await expect(row).toContainText(stored.title);
    });
  });

  // ---------------------------------------------------------------
  // The customer create form: a test.step per [vis] AC, on customers
  // created here; the API is the oracle for what is stored.
  // ---------------------------------------------------------------
  test('walks the customer create form ACs', async ({ page }) => {
    const stamp = Date.now() % 1_000_000_000;
    const token = `Qx${stamp}`;
    const alpha = await apiPost<ApiCustomer>(page, '/api/customers', {
      name: `Kunde ${token} Alpha`,
      address: { street: 'Domplatz 1', zip: '50667', city: 'Köln' },
    });
    await apiPost(page, '/api/customers', { name: `Kunde ${token} Beta` });
    // A near miss the list must leave out.
    await apiPost(page, '/api/customers', { name: `Kunde Qy${stamp} Gamma` });

    const nameInput = page.getByTestId('customer-name-input');
    const dropdown = page.getByTestId('customer-match-dropdown');
    const listed = dropdown.locator('[data-testid^="customer-match-"]');
    const submit = page.getByTestId('customer-submit');
    const creates: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/customers') {
        creates.push(r.url());
      }
    });

    await page.getByTestId('view-toggle-kunden').click();
    await expect(page.getByTestId('customer-table')).toBeVisible();

    await test.step('AC-527 the create form lists the customers whose name contains the typed text, in any case', async () => {
      const typed = `qX${stamp}`;
      const expected = (await allCustomers(page)).filter((c) =>
        c.name.toLowerCase().includes(typed.toLowerCase()),
      );
      expect(expected.length, 'customers matching the text').toBeGreaterThan(0);
      await page.getByTestId('customer-create-button').click();
      await nameInput.fill(typed);
      await expect(listed).toHaveCount(expected.length);
      for (const c of expected)
        await expect(dropdown.getByTestId(`customer-match-${c.id}`)).toBeVisible();
    });

    await test.step("AC-528 picking a listed customer closes the create form and opens that customer's edit form", async () => {
      await dropdown.getByTestId(`customer-match-${alpha.id}`).click();
      await expect(submit).toHaveCount(0);
      await expect(page.getByTestId('customer-save')).toBeVisible();
      await expect(nameInput).toHaveValue(alpha.name);
      await expect(page.getByTestId('customer-street-input')).toHaveValue(alpha.address!.street);
      await expect(page.getByTestId('customer-city-input')).toHaveValue(alpha.address!.city);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('customer-save')).toHaveCount(0);
    });

    await test.step('AC-529 a failed name search lists nothing, shows no error, and the form keeps working', async () => {
      await page.getByTestId('customer-create-button').click();
      await nameInput.fill(`Kunde ${token}`);
      await expect(listed.first()).toBeVisible();

      let failures = 0;
      const isSearch = (url: URL) =>
        url.pathname === '/api/customers' && url.searchParams.has('search');
      await page.route(isSearch, (route) => {
        failures++;
        return route.fulfill({
          status: 500,
          json: { code: 'SERVER_ERROR', message: STRINGS.errors.serverError },
        });
      });
      try {
        const name = `Kunde ${token} Neu`;
        await nameInput.fill(name);
        await expect.poll(() => failures, 'the search failed').toBeGreaterThan(0);
        await expect(dropdown).toHaveCount(0);
        await expect(page.getByText(STRINGS.errors.serverError)).toHaveCount(0);
        await submit.click();
        await expect(submit).toHaveCount(0);
        const stored = (await allCustomers(page)).filter((c) => c.name === name);
        expect(stored).toHaveLength(1);
      } finally {
        await page.unroute(isSearch);
      }
    });

    await test.step('AC-536 a listed name is created only after "Trotzdem erstellen"; cancelling creates nothing', async () => {
      const sameName = async () =>
        (await allCustomers(page)).filter(
          (c) => c.name.trim().toLowerCase() === alpha.name.toLowerCase(),
        ).length;
      expect(await sameName()).toBe(1);
      const dialog = page.getByTestId('confirm-dialog');

      await page.getByTestId('customer-create-button').click();
      await nameInput.fill(`  ${alpha.name.toUpperCase()}  `);
      await expect(dropdown.getByTestId(`customer-match-${alpha.id}`)).toBeVisible();
      const createsBefore = creates.length;
      await nameInput.press('Enter');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('confirm-cancel').click();
      await expect(dialog).toHaveCount(0);
      await expect(submit).toBeEnabled();
      expect(creates.slice(createsBefore)).toEqual([]);
      expect(await sameName()).toBe(1);

      await nameInput.press('Enter');
      await expect(dialog.getByTestId('confirm-ok')).toHaveText('Trotzdem erstellen');
      await dialog.getByTestId('confirm-ok').click();
      await expect(submit).toHaveCount(0);
      expect(await sameName()).toBe(2);
    });

    await test.step('AC-762 a customer create refused as an idempotency conflict closes the form and shows the list', async () => {
      const name = `Konflikt ${token}`;
      const city = page.getByTestId('customer-city-input');
      await page.getByTestId('customer-create-button').click();
      // The name search settles before the first submit, so the retry
      // finds no listed duplicate (AC-536) to confirm.
      const searched = page.waitForResponse((r) => {
        const url = new URL(r.url());
        return url.pathname === '/api/customers' && url.searchParams.get('search') === name;
      });
      await nameInput.fill(name);
      await page.getByTestId('customer-street-input').fill('Am Markt 1');
      await page.getByTestId('customer-zip-input').fill('50667');
      await city.fill('Köln');
      await searched;
      const createId = await loseNextCreateResponse(page, '/api/customers', () => submit.click());
      const stored = await apiGet<ApiCustomer>(page, `/api/customers/${createId}`);
      expect(stored.address?.city).toBe('Köln');
      await expect(city).toBeEnabled();

      // The retry reuses the id with another city.
      await city.fill('Bonn');
      const [refused] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/customers',
        ),
        submit.click(),
      ]);
      expect(refused.status()).toBe(409);
      expect((await refused.json()).code).toBe('IDEMPOTENCY_CONFLICT');
      await expect(submit).toHaveCount(0);
      await expect(page.getByText(STRINGS.errors.idempotencyConflict)).toBeVisible();
      await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText(
        stored.address!.city,
      );
    });
  });
});
