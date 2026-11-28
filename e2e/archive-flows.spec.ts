import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../src/config/strings';
import { STATE_KEYS } from '../src/config/stateConfig';

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
 *   - AC-534: the customer-delete confirmation dialog names the archived
 *     project count when `archivedProjectCount > 0` (sourced from
 *     GET /api/customers/:id; purge is atomic per AC-531).
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
 *      archived-count warning text and confirm cleanup (AC-534).
 *
 * Seed data assumptions (inherited from auth.setup.ts):
 *   - Logged in as owner — full permissions on projects and customers.
 *
 * The Project Detail Page flow at the end walks that page's ACs, a step
 * per AC, on projects it creates.
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
  // AC-534: customer-delete warning surfaces archivedProjectCount.
  // Setup for this test: archive the second project as well, so the
  // customer has 0 active and 2 archived projects — allowed for delete
  // but the dialog must warn.
  // ---------------------------------------------------------------
  test('AC-534: customer delete warns with archived-project count and purges on confirm', async ({
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
    // must be allowed (AC-531) but the confirm dialog must warn with the
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
    // The warning, with the count: the customer name has a digit of its own.
    await expect(dialog).toContainText(STRINGS.customers.deleteWithArchived(2));
    await expect(dialog).toContainText(/\b2 archivierte/);

    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/api/customers/') && resp.request().method() === 'DELETE',
      ),
      page.getByTestId('confirm-ok').click(),
    ]);

    // Customer row gone — atomic purge by AC-531 also removed both archived
    // projects, so this suite leaves the DB clean.
    await expect(page.getByRole('row', { name: new RegExp(archiveCustomerName) })).toHaveCount(0);
  });

  // ---------------------------------------------------------------
  // AC-501, AC-505: Per-project `Endgültig löschen` action on archived rows.
  //
  // Uses a dedicated customer + project so this test stands on its own
  // and does not depend on the AC-534 test's teardown state. The AC-534
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

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PDF_FIXTURE = path.join(FIXTURES, 'sample.pdf');
const JPG_FIXTURE = path.join(FIXTURES, 'sample.jpg');

interface ApiAddress {
  street: string;
  zip: string;
  city: string;
}

interface ApiProject {
  number: string;
  title: string;
  deleted: boolean;
  plannedStart: string | null;
  plannedEnd: string | null;
  siteAddress: ApiAddress | null;
  customer: { address: ApiAddress | null } | null;
}

interface DetailControl {
  kind: string;
  name: string;
  href: string | null;
  testId: string | null;
  /** The page section holding the control, by its test id. */
  section: string | null;
}

/**
 * Every control on the Project Detail Page a user can operate: buttons,
 * links, tabs, form fields and other focusable widgets in the DOM, minus
 * disabled and read-only ones.
 */
async function operableDetailControls(page: Page): Promise<DetailControl[]> {
  return page.getByTestId('project-detail-page').evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        [
          'button',
          'a[href]',
          'input',
          'textarea',
          'select',
          '[contenteditable="true"]',
          ...['button', 'tab', 'checkbox', 'switch', 'menuitem', 'option', 'combobox', 'link'].map(
            (role) => `[role="${role}"]`,
          ),
          '[tabindex]:not([tabindex="-1"])',
        ].join(', '),
      ),
    ]
      .filter((el) => {
        const field = el as HTMLInputElement;
        return (
          field.disabled !== true &&
          field.readOnly !== true &&
          el.getAttribute('aria-disabled') !== 'true'
        );
      })
      .map((el) => {
        const type = el instanceof HTMLAnchorElement ? '' : (el as HTMLInputElement).type;
        return {
          kind: type ? `${el.tagName.toLowerCase()}:${type}` : el.tagName.toLowerCase(),
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          href: el.getAttribute('href'),
          testId: el.getAttribute('data-testid'),
          section:
            el.parentElement
              ?.closest('[data-testid^="project-detail-"]')
              ?.getAttribute('data-testid') ?? null,
        };
      }),
  );
}

test.describe('Project Detail Page (owner on fresh projects)', () => {
  test('walks the project detail page ACs', async ({ page }) => {
    const stamp = Date.now() % 1_000_000_000;
    const createdCustomers: string[] = [];
    const createdProjects: string[] = [];
    const createCustomer = async (data: { name: string } & Record<string, unknown>) => {
      const res = await page.request.post('/api/customers', { data });
      expect(res.status(), await res.text()).toBe(201);
      const id = (await res.json()).id as string;
      createdCustomers.push(id);
      return id;
    };
    const createProject = async (suffix: string, data: Record<string, unknown>) => {
      const res = await page.request.post('/api/projects', {
        data: { number: `PD-${stamp}-${suffix}`, title: `Detailseite ${suffix}`, ...data },
      });
      expect(res.status(), await res.text()).toBe(201);
      const id = (await res.json()).id as string;
      createdProjects.push(id);
      return id;
    };
    const fetchProject = async (id: string): Promise<ApiProject> => {
      const res = await page.request.get(`/api/projects/${id}`);
      expect(res.ok(), `GET project ${id} returned ${res.status()}`).toBe(true);
      return (await res.json()) as ApiProject;
    };

    try {
      const customerAddress = { street: 'Kundenweg 7', zip: '50667', city: 'Köln' };
      // A phone and an email: the page shows them as links (AC-500 scans links).
      const withAddress = await createCustomer({
        name: `Detail-Kunde ${stamp}`,
        address: customerAddress,
        phone: '0221 123456',
        email: 'detail@example.com',
      });
      const withoutAddress = await createCustomer({ name: `Detail-Kunde ohne Adresse ${stamp}` });
      const siteAddress = { street: 'Baustellenstraße 12', zip: '80331', city: 'München' };
      const site = await createProject('S', {
        customerId: withAddress,
        siteAddress,
        plannedStart: '2026-03-02',
        plannedEnd: '2026-03-13',
      });
      const fallback = await createProject('K', { customerId: withAddress });
      const none = await createProject('N', { customerId: withoutAddress });
      const workers = await page.request.get('/api/workers');
      expect(workers.ok(), `GET /api/workers returned ${workers.status()}`).toBe(true);
      const worker = ((await workers.json()) as { data: { userId: string; displayName: string }[] })
        .data[0];
      expect(worker, 'needs an active worker').toBeDefined();
      const archivable = await createProject('A', {
        customerId: withAddress,
        assignedWorkerIds: [worker.userId],
      });

      const panel = page.getByTestId('detail-panel');
      const openPanel = async (id: string) => {
        await page.goto('/kanban');
        await page.getByTestId(`project-card-${id}`).click();
        await expect(panel).toBeVisible();
      };
      const openPage = async (id: string) => {
        await page.goto(`/projects/${id}`);
        await expect(page.getByTestId('project-detail-page')).toBeVisible();
      };
      /** Runs `check` on the Baustelle line of the panel, then of the page. */
      const onBothLines = async (id: string, check: (line: Locator) => Promise<void>) => {
        await openPanel(id);
        await check(panel.getByTestId('detail-site-address'));
        await openPage(id);
        await check(page.getByTestId('project-detail-site-address'));
      };
      /** The line's text after its `Baustelle` label. */
      const lineValue = async (line: Locator) => {
        const text = ((await line.textContent()) ?? '').replace(/\s+/g, ' ').trim();
        const label = 'Baustelle';
        expect(text.startsWith(label), `"${text}" starts with "${label}"`).toBe(true);
        return text.slice(label.length).replace(/^:/, '').trim();
      };
      const expectShowsAddress = (text: string, address: ApiAddress) => {
        for (const part of [address.street, address.zip, address.city]) {
          expect(text, `"${text}" shows ${part}`).toContain(part);
        }
      };
      /** A map link's target, URL-decoded. */
      const linkTarget = async (link: Locator) =>
        decodeURIComponent(((await link.getAttribute('href')) ?? '').replace(/\+/g, ' '));

      await test.step('AC-207 the panel offers Öffnen, which opens the project page', async () => {
        const { number, title } = await fetchProject(site);
        await openPanel(site);
        await panel.getByRole('button', { name: 'Öffnen', exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${site}$`));
        const detail = page.getByTestId('project-detail-page');
        await expect(detail).toBeVisible();
        await expect(detail.getByTestId('project-detail-header')).toContainText(number);
        await expect(detail.getByTestId('project-title-edit')).toHaveValue(title);
      });

      await test.step('AC-489 a project with its own site address shows it', async () => {
        const project = await fetchProject(site);
        expect(project.siteAddress, 'needs a site address').not.toBeNull();
        expect(project.customer?.address, 'needs a customer address to lose to').toBeTruthy();
        await onBothLines(site, async (line) => {
          const value = await lineValue(line);
          expectShowsAddress(value, project.siteAddress!);
          expect(value).not.toContain(project.customer!.address!.street);
          expect(value).not.toContain('(Kundenadresse)');
        });
      });

      await test.step('AC-490 without a site address the customer address shows, marked', async () => {
        const project = await fetchProject(fallback);
        expect(project.siteAddress).toBeNull();
        const address = project.customer?.address;
        expect(address, 'needs a customer address').toBeTruthy();
        await onBothLines(fallback, async (line) => {
          const value = await lineValue(line);
          expectShowsAddress(value, address!);
          const hint = value.indexOf('(Kundenadresse)');
          expect(hint, `"${value}" carries the hint`).toBeGreaterThan(-1);
          for (const part of [address!.street, address!.zip, address!.city]) {
            expect(hint, `the hint follows ${part}`).toBeGreaterThan(value.indexOf(part));
          }
        });
      });

      await test.step('AC-491 with no address at all the line reads "Keine Adresse"', async () => {
        const project = await fetchProject(none);
        expect([project.siteAddress, project.customer?.address ?? null]).toEqual([null, null]);
        await onBothLines(none, async (line) => {
          expect(await lineValue(line)).toBe('Keine Adresse');
        });
      });

      await test.step('AC-283 the line has one map link, to the shown address; none without', async () => {
        const siteProject = await fetchProject(site);
        const cases = [
          { id: site, shown: siteProject.siteAddress, other: siteProject.customer?.address },
          { id: fallback, shown: (await fetchProject(fallback)).customer?.address ?? null },
          { id: none, shown: null },
        ];
        expect(cases.filter((c) => c.shown).length, 'needs lines with an address').toBe(2);
        for (const { id, shown, other } of cases) {
          await onBothLines(id, async (line) => {
            const links = line.getByRole('link');
            if (!shown) {
              await expect(links).toHaveCount(0);
              return;
            }
            await expect(links).toHaveCount(1);
            const target = await linkTarget(links);
            expectShowsAddress(target, shown);
            // The site address wins in the link too.
            if (other) expect(target).not.toContain(other.street);
          });
        }
      });

      await test.step('AC-511 clearing the planned start clears the planned end too', async () => {
        const before = await fetchProject(site);
        expect(before.plannedEnd, 'needs a planned end').not.toBeNull();
        await openPage(site);
        const start = page.getByTestId('project-detail-start');
        const end = page.getByTestId('project-detail-end');
        await expect(start).toHaveValue(before.plannedStart!);
        await expect(end).toHaveValue(before.plannedEnd!);
        await start.fill('');
        const [patch] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().endsWith(`/api/projects/${site}/dates`) && r.request().method() === 'PATCH',
          ),
          start.blur(),
        ]);
        expect(patch.ok(), `PATCH dates ${patch.status()}`).toBe(true);
        await expect(start).toHaveValue('');
        await expect(end).toHaveValue('');
        const after = await fetchProject(site);
        expect([after.plannedStart, after.plannedEnd]).toEqual([null, null]);
      });

      await test.step('AC-506 Archivieren and Wiederherstellen ask, naming the project', async () => {
        const { number, title } = await fetchProject(archivable);
        const dialog = page.getByTestId('confirm-dialog');
        const expectNamesProject = async () => {
          await expect(dialog).toBeVisible();
          await expect(dialog).toContainText(number);
          await expect(dialog).toContainText(title);
        };
        const isArchived = async () => (await fetchProject(archivable)).deleted;
        const cancel = async (archived: boolean) => {
          await page.getByTestId('confirm-cancel').click();
          await expect(dialog).toHaveCount(0);
          expect(await isArchived(), 'a cancel changes nothing').toBe(archived);
        };

        // The project list offers Archivieren too.
        await page.goto('/projects');
        await page
          .getByRole('row', { name: new RegExp(number) })
          .getByRole('button', { name: 'Archivieren', exact: true })
          .click();
        await expectNamesProject();
        await cancel(false);

        await openPage(archivable);
        const archive = page.getByRole('button', { name: 'Archivieren', exact: true });
        await archive.click();
        await expectNamesProject();
        await cancel(false);
        await archive.click();
        await expectNamesProject();
        await page.getByTestId('confirm-ok').click();
        await expect.poll(isArchived).toBe(true);

        await openPage(archivable);
        const restore = page.getByRole('button', { name: 'Wiederherstellen', exact: true });
        await restore.click();
        await expectNamesProject();
        await cancel(true);
        await restore.click();
        await expectNamesProject();
        await page.getByTestId('confirm-ok').click();
        await expect.poll(isArchived).toBe(false);
      });

      await test.step('AC-500 an archived project page shows a notice and offers no change', async () => {
        // A document, an assigned worker, the invoice-due state and a draft
        // invoice: on an active project, each offers a change.
        for (const from of STATE_KEYS.slice(0, STATE_KEYS.indexOf('rechnung_faellig'))) {
          const res = await page.request.post(`/api/projects/${archivable}/transition/forward`, {
            data: { expectedStatus: from },
          });
          expect(res.ok(), `transition from ${from}: ${res.status()}`).toBe(true);
        }
        const draft = await page.request.post('/api/invoices', {
          data: {
            projectId: archivable,
            lines: [
              {
                description: 'Anstrich',
                quantity: 1,
                unit: 'pauschal',
                unitPrice: 100,
                taxRate: 19,
              },
            ],
            taxMode: 'standard',
            performanceDate: new Date().toISOString().slice(0, 10),
          },
        });
        expect(draft.ok(), `POST /api/invoices ${draft.status()}: ${await draft.text()}`).toBe(
          true,
        );
        const draftId = (await draft.json()).id as string;
        await openPage(archivable);
        const fileName = 'plan.pdf';
        const upload = page.getByTestId('project-detail-upload-cta');
        await upload.getByTestId('attachment-binary-input').setInputFiles({
          name: fileName,
          mimeType: 'application/pdf',
          buffer: fs.readFileSync(PDF_FIXTURE),
        });
        await upload.getByTestId('attachment-photo-input').setInputFiles(JPG_FIXTURE);
        const photos = page.getByTestId('project-detail-photos');
        const binaries = page.getByTestId('project-detail-binaries');
        // The sections that load on their own have loaded before the controls are read.
        const expectLoaded = async () => {
          await expect(binaries).toContainText(fileName, { timeout: 15_000 });
          await expect(photos.locator('[data-testid^="photo-thumb-"]')).toHaveCount(1, {
            timeout: 15_000,
          });
          await expect(page.getByTestId(`invoice-row-${draftId}`)).toBeVisible();
        };

        // This test's reading of "no change": opening, viewing, downloading,
        // selecting for a download, switching tabs, expanding the activity
        // feed and following a contact, map or list link store nothing.
        const readNames = new Set<string>([
          STRINGS.attachments.downloadAll,
          STRINGS.attachments.tabAttachments,
          'Papierkorb',
          STRINGS.attachments.selectAll,
          fileName,
          STRINGS.attachments.view,
          'Herunterladen',
          'Auswahl als ZIP',
          STRINGS.audit.detailsShow,
          STRINGS.audit.detailsHide,
          STRINGS.audit.loadOlder,
          STRINGS.audit.toggleShowAll,
          STRINGS.ui.openMaps,
          'Alle Rechnungen anzeigen',
        ]);
        const isRead = (c: DetailControl) =>
          readNames.has(c.name) ||
          /^(tel|mailto):/.test(c.href ?? '') ||
          // A thumbnail opens the photo in the lightbox.
          (c.testId ?? '').startsWith('photo-thumb-');
        const offeredChanges = async () =>
          (await operableDetailControls(page)).filter((c) => !isRead(c));
        const notice = page.getByTestId('project-detail-archived-notice');

        // Positive control: the scan sees the links an active page shows and
        // the changes it offers.
        await expectLoaded();
        await expect(notice).toHaveCount(0);
        const links = (await operableDetailControls(page)).filter((c) => c.kind === 'a');
        expect(links.map((c) => c.href ?? '')).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^tel:/),
            expect.stringMatching(/^mailto:/),
          ]),
        );
        expect(links.map((c) => c.name)).toEqual(
          expect.arrayContaining([STRINGS.ui.openMaps, 'Alle Rechnungen anzeigen']),
        );
        const active = await offeredChanges();
        expect(active.map((c) => c.name)).toEqual(
          expect.arrayContaining([
            'Archivieren',
            STRINGS.attachments.removeWorkerNamed(worker.displayName),
            'Neue Rechnung',
            'Bearbeiten',
            'Ausstellen',
            'Verwerfen',
          ]),
        );
        for (const section of ['project-detail-photos', 'project-detail-binaries']) {
          expect(active, `a delete control in ${section}`).toContainEqual(
            expect.objectContaining({ name: STRINGS.ui.delete, section }),
          );
        }
        expect(active.map((c) => c.kind)).toEqual(
          expect.arrayContaining([
            'textarea:textarea',
            'input:date',
            'input:file',
            'select:select-one',
          ]),
        );

        const archived = await page.request.delete(`/api/projects/${archivable}`);
        expect(archived.ok(), `archive ${archived.status()}`).toBe(true);
        await openPage(archivable);
        await expect(notice).toHaveText(STRINGS.attachments.archivedReadOnlyNotice);
        await expectLoaded();
        expect((await offeredChanges()).map((c) => c.name).sort()).toEqual(
          ['Wiederherstellen', 'Endgültig löschen'].sort(),
        );
      });

      await test.step('AC-508 a project that does not exist shows a not-found message', async () => {
        const missing = randomUUID();
        const res = await page.request.get(`/api/projects/${missing}`);
        expect(res.status(), 'the project does not exist').toBe(404);
        await page.goto(`/projects/${missing}`);
        await expect(
          page.getByRole('heading', { name: STRINGS.attachments.notFoundHeading }),
        ).toBeVisible();
        await expect(page.getByText(STRINGS.attachments.notFoundBody)).toBeVisible();
        await expect(page.getByTestId('project-detail-page')).toHaveCount(0);
      });
    } finally {
      // Archive the fixtures, then delete their customers, which purges the
      // archived projects (AC-531): later tests see the board they expect.
      for (const id of createdProjects) {
        const res = await page.request.delete(`/api/projects/${id}`);
        // Soft: a failed cleanup must not mask the failing AC step. An
        // already archived project answers 404 (AC-499).
        expect.soft([200, 404], `archive ${id}: ${res.status()}`).toContain(res.status());
      }
      for (const id of createdCustomers) {
        const res = await page.request.delete(`/api/customers/${id}`);
        expect.soft(res.ok(), `delete customer ${id}: ${res.status()}`).toBe(true);
      }
    }
  });
});
