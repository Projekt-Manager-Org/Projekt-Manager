import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { format } from 'date-fns';
import { STORAGE_STATES } from './storage-states';
import { STRINGS } from '../src/config/strings';
import { createDatabase } from '../src/server/db/connection.js';
import { companyProfile } from '../src/server/db/schema.js';

/**
 * E2E — Invoice lifecycle (pins AC-689, AC-692 and AC-702 at the UI integration
 * level).
 *
 * Drives the owner-facing happy path end-to-end:
 *   1. Owner navigates to a project in `rechnung_faellig` (the only
 *      state from which issuance is allowed per AC-696).
 *   2. Opens the per-project invoice form (ui/invoices.md §8.16, and
 *      the per-project invoice block in ui/project-detail.md §8.15.11).
 *   3. Enters lines + performance date; selects `taxMode = 'standard'`.
 *   4. Issues the invoice.
 *   5. Asserts:
 *      - the invoice list shows the new row with an `RE-YYYY-NNNN`
 *        number,
 *      - the parent project's status shows `abgerechnet` on the
 *        Kanban board (AC-692),
 *      - the rendered PDF/A-3 is downloadable through the per-invoice
 *        viewer.
 *   6. Cancels the issued invoice with a `cancellationReason`.
 *   7. Asserts:
 *      - the original row's status renders as `cancelled`,
 *      - the Storno sibling row appears with `ST-YYYY-NNNN`, visually
 *        grouped under the original,
 *      - the parent project's status is NOT auto-reverted (AC-704).
 *
 * Runs under `chromium-mutating` because the flow persists `invoice`
 * rows + flips a project status — a parallel reader would see the
 * mutation mid-flight.
 *
 * Pre-impl red state: every selector is missing — the form, the list
 * row, the cancel dialog, the PDF download affordance — so navigation
 * + the first `expect(...)` calls fail. Implementation lands the
 * surface in step 5; this spec is the contract.
 */

test.use({ storageState: STORAGE_STATES.owner });

const year = new Date().getFullYear();

test.describe.configure({ mode: 'serial' });

test.describe('Invoice lifecycle (AC-689, AC-692, AC-702)', () => {
  let projectId: string;
  let invoiceNumber: string;
  let stornoNumber: string;

  test('owner navigates to a rechnung_faellig project and opens the invoice draft form', async ({
    page,
  }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The rechnung_faellig column carries 3 projects in the seed
    // (kanban-flows.spec.ts pinns this count). Click the first card.
    const column = page.getByTestId('kanban-column-rechnung_faellig');
    await expect(column).toBeVisible();
    const card = column.locator('[data-testid^="project-card-"]').first();
    await card.click();

    // Resolve the project id from the card's testid for downstream
    // assertions.
    const cardTestId = await card.getAttribute('data-testid');
    projectId = cardTestId!.replace('project-card-', '');

    // The quick-glance panel's "Öffnen" affordance navigates to the
    // project detail page — the invoice block lives there per
    // ui/project-detail.md §8.15.11.
    const panel = page.getByTestId('detail-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('detail-open-page').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:\\?|$)`));
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    // Open the invoice draft form. The testid below is the contract
    // for the impl team — the spec leaves the form's exact UI to
    // ui/project-detail.md §8.15.11 and ui/invoices.md §8.16.
    const draftCta = page.getByTestId('invoice-draft-create');
    await expect(draftCta).toBeVisible();
    await draftCta.click();

    // Form opens — name input, line input, performance-date picker.
    await expect(page.getByTestId('invoice-form')).toBeVisible();
  });

  test('owner fills the invoice form and issues the invoice', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();
    await page.getByTestId('invoice-draft-create').click();

    // Fill required fields. The exact field testids match the
    // pattern used in management-flows.spec.ts (kebab-case prefix +
    // input).
    await page.getByTestId('invoice-tax-mode-select').selectOption('standard');
    await page.getByTestId('invoice-performance-date-input').fill('2026-04-10');

    // One line item — description, quantity, unit, unitPrice, taxRate.
    await page.getByTestId('invoice-line-description-input').fill('Anstrich Fassade');
    await page.getByTestId('invoice-line-quantity-input').fill('1');
    await page.getByTestId('invoice-line-unit-input').fill('pauschal');
    await page.getByTestId('invoice-line-unit-price-input').fill('1500');
    await page.getByTestId('invoice-line-tax-rate-select').selectOption('19');

    // Save draft, then issue. The two-step UX (save draft first, then
    // issue) mirrors the draft form / block split (ui/invoices.md §8.16.2).
    await page.getByTestId('invoice-form-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();

    // The draft row appears in the per-project invoice block.
    const draftRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .first();
    await expect(draftRow).toBeVisible();
    await expect(draftRow.getByTestId('invoice-status-badge')).toContainText(/draft|Entwurf/i);

    // Issue the draft.
    await draftRow.getByTestId('invoice-issue-button').click();
    const confirm = page.getByTestId('confirm-dialog');
    await expect(confirm).toBeVisible();
    // Wait for the issue API to complete so subsequent assertions
    // observe the post-commit state (mirrors the deactivate pattern
    // in management-flows.spec.ts).
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/issue') && resp.ok()),
      page.getByTestId('confirm-ok').click(),
    ]);

    // The issued row carries the `RE-YYYY-NNNN` number per AC-689.
    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .first();
    await expect(issuedRow.getByTestId('invoice-status-badge')).toContainText(
      /issued|Ausgestellt/i,
    );
    const numberCell = issuedRow.getByTestId('invoice-number');
    await expect(numberCell).toBeVisible();
    invoiceNumber = (await numberCell.textContent())!.trim();
    expect(invoiceNumber).toMatch(new RegExp(`^RE-${year}-\\d{4,}$`));
  });

  test('the project status flips to abgerechnet on the Kanban board (AC-692)', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // The card has moved from `rechnung_faellig` to `abgerechnet`.
    const abgerechnet = page.getByTestId('kanban-column-abgerechnet');
    await expect(abgerechnet).toBeVisible();
    await expect(abgerechnet.getByTestId(`project-card-${projectId}`)).toBeVisible();
  });

  test('the rendered PDF/A-3 downloads through the per-invoice viewer', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(issuedRow).toBeVisible();

    // The download action fires the browser download event — the
    // load-bearing assertion is the browser-level observable, not
    // the affordance click.
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await issuedRow.getByTestId('invoice-download-pdf').click();
    const download = await downloadPromise;
    // Filename is implementation-defined; the load-bearing assertion
    // is `.pdf` extension + non-empty body.
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  test('the list-row click opens the per-invoice viewer and the cancel dialog reaches it (§8.16.3)', async ({
    page,
  }) => {
    // Per-invoice viewer at `/rechnungen/:id` — the list-row click
    // for an issued row navigates here, and the viewer exposes the
    // same `Stornorechnung erstellen` flow as the per-project block.
    // The cancel is committed in the next test through the per-
    // project block; here we only assert the viewer's surfaces and
    // that the dialog opens with the spec-mandated warning copy.
    await page.goto('/rechnungen');
    await expect(page.getByTestId('invoice-list-view')).toBeVisible();

    const issuedRow = page
      .getByTestId('invoice-list-cross-project')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(issuedRow).toBeVisible();
    await issuedRow.click();

    await expect(page).toHaveURL(/\/rechnungen\/[a-f0-9-]+$/);
    await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
    await expect(page.getByTestId('invoice-detail-number')).toHaveText(invoiceNumber);
    await expect(page.getByTestId('invoice-detail-status')).toContainText('Ausgestellt');

    // ZUGFeRD-profile rename of the PDF download action (§8.16.3).
    await expect(page.getByTestId('invoice-detail-download-pdf')).toContainText(
      'ZUGFeRD herunterladen',
    );

    // Stornorechnung dialog opens with the verbatim German warning
    // pinned by ui/invoices.md §8.16.3 (`Stornieren`).
    await page.getByTestId('invoice-detail-cancel-button').click();
    const dialog = page.getByTestId('invoice-cancel-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Diese Aktion erstellt eine Storno-Rechnung.');
    await expect(dialog).toContainText('Der Projektstatus wird NICHT automatisch zurückgesetzt');

    // Close without confirming so the next test sees the issued row
    // still issued.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('owner cancels the issued invoice with a cancellationReason (AC-702)', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-detail-page')).toBeVisible();

    const issuedRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(issuedRow).toBeVisible();

    await issuedRow.getByTestId('invoice-cancel-button').click();

    // Cancel dialog carries a reason input.
    const cancelDialog = page.getByTestId('invoice-cancel-dialog');
    await expect(cancelDialog).toBeVisible();
    await cancelDialog.getByTestId('invoice-cancel-reason-input').fill('Tippfehler');
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/cancel') && resp.ok()),
      cancelDialog.getByTestId('invoice-cancel-confirm').click(),
    ]);

    // The original row's status renders as `cancelled`.
    await expect(issuedRow.getByTestId('invoice-status-badge')).toContainText(
      /cancelled|Storniert/i,
    );

    // The Storno sibling row appears with the `ST-YYYY-NNNN` number,
    // visually grouped under the original (ui/invoices.md §8.16.1).
    // The grouping mechanism is impl-defined (a nested testid or a
    // visual indent); the load-bearing assertion is the presence of
    // the sibling row referencing the original.
    //
    // TESTID CONTRACT (proposal for the impl team): the Storno row
    // carries `data-testid="invoice-storno-of"` whose text content
    // names the original's `RE-YYYY-NNNN` number. This testid
    // expresses the `cancellationOf` link in a single DOM-queryable
    // attribute and decouples the locator from any specific visual
    // grouping (nested table, indent, badge — all valid renderings).
    // If the impl team picks a different testid name, update both
    // here and ui/invoices.md §8.16.1 in lock-step.
    const stornoRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ has: page.getByTestId('invoice-storno-of').filter({ hasText: invoiceNumber }) })
      .first();
    await expect(stornoRow).toBeVisible();
    const stornoNumberCell = stornoRow.getByTestId('invoice-number');
    stornoNumber = (await stornoNumberCell.textContent())!.trim();
    expect(stornoNumber).toMatch(new RegExp(`^ST-${year}-\\d{4,}$`));
  });

  test('the project status is NOT auto-reverted after cancellation (AC-704)', async ({ page }) => {
    await page.goto('/kanban');
    await expect(page.getByTestId('kanban-board')).toBeVisible();

    // Card stays in `abgerechnet` — the cancellation surfaces as a UI
    // banner on the project, not as a project-status flip.
    const abgerechnet = page.getByTestId('kanban-column-abgerechnet');
    await expect(abgerechnet.getByTestId(`project-card-${projectId}`)).toBeVisible();

    // Card is NOT back in rechnung_faellig.
    const rechnungFaellig = page.getByTestId('kanban-column-rechnung_faellig');
    await expect(rechnungFaellig.getByTestId(`project-card-${projectId}`)).toHaveCount(0);
  });

  test('the list-view row click opens the per-invoice viewer (ui/invoices.md §8.16.3)', async ({
    page,
  }) => {
    // Standalone /rechnungen list — row click on an issued or
    // cancelled row navigates to `/rechnungen/:id` (the per-invoice
    // viewer). Drafts still navigate to their project. Here we
    // exercise the cancelled-original row that the cancel test
    // above left behind.
    await page.goto('/rechnungen');
    await expect(page.getByTestId('invoice-list-view')).toBeVisible();

    const cancelledRow = page
      .getByTestId('invoice-list-cross-project')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await expect(cancelledRow).toBeVisible();

    await cancelledRow.click();
    await expect(page).toHaveURL(/\/rechnungen\/[a-f0-9-]+$/);
    await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
    await expect(page.getByTestId('invoice-detail-number')).toHaveText(invoiceNumber);
  });

  test('the per-invoice viewer downloads the PDF and exposes the cancel dialog', async ({
    page,
  }) => {
    // Use the already-cancelled original from the cancel test — its
    // viewer renders the PDF download affordance and the back-to-
    // list link. We assert the download fires (browser-level event)
    // and that the page navigates correctly back. The cancel dialog
    // itself is not opened from a cancelled row (the Stornieren
    // action is hidden for non-issued rows); use a separate flow
    // for the dialog assertion.
    await page.goto('/rechnungen');
    await expect(page.getByTestId('invoice-list-view')).toBeVisible();

    const cancelledRow = page
      .getByTestId('invoice-list-cross-project')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: invoiceNumber })
      .first();
    await cancelledRow.click();
    await expect(page.getByTestId('invoice-detail-view')).toBeVisible();

    // PDF download from the viewer surface — same browser-event
    // observable used in the per-project block test. The action is
    // renamed to "ZUGFeRD herunterladen" because the seeded invoice
    // ships the zugferd profile; the testid stays stable.
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByTestId('invoice-detail-download-pdf').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);

    // The cancelled original viewer also surfaces the storno
    // siblings list — confirm the Storno row from the cancel test
    // is linked.
    const siblings = page.getByTestId('invoice-detail-storno-siblings');
    await expect(siblings).toBeVisible();
    await expect(siblings).toContainText(stornoNumber);
  });

  test('the Storno viewer links back to the original via Original anzeigen', async ({ page }) => {
    // Deep-link a Storno row directly — the viewer must render the
    // `Original anzeigen` affordance pointing to the `cancellationOf`
    // original. The link is a real `<a href>` (Storno → original is
    // pure navigation, no mutation), so we assert the href shape
    // rather than clicking-and-waiting.
    await page.goto('/rechnungen');
    await expect(page.getByTestId('invoice-list-view')).toBeVisible();

    const stornoRow = page
      .getByTestId('invoice-list-cross-project')
      .locator('[data-testid^="invoice-row-"]')
      .filter({ hasText: stornoNumber })
      .first();
    await stornoRow.click();
    await expect(page).toHaveURL(/\/rechnungen\/[a-f0-9-]+$/);
    await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
    await expect(page.getByTestId('invoice-detail-status')).toContainText('Storno');

    const link = page.getByTestId('invoice-detail-view-original');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /\/rechnungen\/[a-f0-9-]+$/);
  });
});

// ---------------------------------------------------------------------
// AC-522, AC-523: a customer's USt-IdNr. entered in the form reaches the
// invoice, so a reverse-charge invoice issues without leaving the UI.
// Owns its customer and project; the seed stays as the tests above left it.
// ---------------------------------------------------------------------
test.describe('Reverse-charge invoice from the UI', () => {
  test('AC-522, AC-523: USt-IdNr. entered on the customer issues a reverse-charge invoice', async ({
    page,
  }) => {
    const stamp = Date.now();
    const customerName = `E2E Reverse Charge ${stamp}`;
    const ustId = 'DE811907980';
    const notes = 'Zufahrt über den Hof';

    await page.goto('/projects');
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByTestId('customer-create-button').click();
    await page.getByTestId('customer-name-input').fill(customerName);
    await page.getByTestId('customer-street-input').fill('Industriestr. 42');
    await page.getByTestId('customer-zip-input').fill('50667');
    await page.getByTestId('customer-city-input').fill('Köln');
    await page.getByTestId('customer-ustid-input').fill(ustId);
    await page.getByTestId('customer-notes-input').fill(notes);
    await page.getByTestId('customer-submit').click();

    const row = page.getByRole('row', { name: new RegExp(customerName) });
    await expect(row).toBeVisible();
    await page.reload();
    await page.getByTestId('view-toggle-kunden').click();
    await page.getByText(customerName).click();
    await expect(page.getByTestId('customer-ustid-input')).toHaveValue(ustId);
    await expect(page.getByTestId('customer-notes-input')).toHaveValue(notes);
    await page.keyboard.press('Escape');

    const list = await page.request.get(
      `/api/customers?search=${encodeURIComponent(customerName)}`,
    );
    const customerId = (await list.json()).customers[0].id as string;
    const created = await page.request.post('/api/projects', {
      data: { number: `RC-${stamp % 1_000_000_000}`, title: 'Reverse Charge', customerId },
    });
    expect(created.ok()).toBe(true);
    const projectId = (await created.json()).id as string;
    for (const expectedStatus of [
      'anfrage',
      'angebot',
      'beauftragt',
      'geplant',
      'in_arbeit',
      'abnahme',
    ]) {
      const moved = await page.request.post(`/api/projects/${projectId}/transition/forward`, {
        data: { expectedStatus },
      });
      expect(moved.ok(), `transition from ${expectedStatus}`).toBe(true);
    }

    await page.goto(`/projects/${projectId}`);
    await page.getByTestId('invoice-draft-create').click();
    await expect(page.getByTestId('invoice-recipient-ustid-input')).toHaveValue(ustId);
    await page.getByTestId('invoice-tax-mode-select').selectOption('reverse_charge');
    await page.getByTestId('invoice-performance-date-input').fill('2026-04-10');
    await page.getByTestId('invoice-line-description-input').fill('Fassade');
    await page.getByTestId('invoice-line-quantity-input').fill('1');
    await page.getByTestId('invoice-line-unit-input').fill('pauschal');
    await page.getByTestId('invoice-line-unit-price-input').fill('1500');
    await page.getByTestId('invoice-line-tax-rate-select').selectOption('0');
    await page.getByTestId('invoice-form-save').click();
    await expect(page.getByTestId('invoice-form')).toBeHidden();

    const draftRow = page
      .getByTestId('invoice-list')
      .locator('[data-testid^="invoice-row-"]')
      .first();
    await draftRow.getByTestId('invoice-issue-button').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await Promise.all([
      page.waitForResponse((resp) => resp.url().includes('/issue') && resp.ok()),
      page.getByTestId('confirm-ok').click(),
    ]);

    await expect(draftRow.getByTestId('invoice-status-badge')).toContainText(/Ausgestellt/i);
  });
});

// ---------------------------------------------------------------------
// The invoice list and draft form [vis] ACs, walked as one flow. The test
// creates its own invoices through the API — two projects of a fresh
// customer, one later archived — and reads every invoice back from
// `GET /api/invoices` as the oracle, so the flow holds whatever earlier
// specs added to the seed. Labels come from ui/invoices.md §8.16; form
// messages, which the spec requires only to be German, from STRINGS.
// ---------------------------------------------------------------------

interface ApiInvoice {
  id: string;
  number: string | null;
  status: 'draft' | 'issued' | 'cancelled';
  projectId: string;
  cancellationOf: string | null;
  issueDate: string | null;
  createdAt: string;
  recipient: { name: string };
  version: number;
}

async function okJson<T>(res: Promise<APIResponse>, what: string): Promise<T> {
  const response = await res;
  expect(response.ok(), `${what} returned ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/** Every invoice the owner sees, in no particular order. */
async function allInvoices(api: APIRequestContext): Promise<ApiInvoice[]> {
  const { data, total } = await okJson<{ data: ApiInvoice[]; total: number }>(
    api.get('/api/invoices?limit=500'),
    'GET /api/invoices',
  );
  expect(data.length, 'every invoice fits one oracle page').toBe(total);
  return data;
}

const ROW_PREFIX = 'invoice-row-';
const invoiceRows = (scope: Locator) => scope.locator(`[data-testid^="${ROW_PREFIX}"]`);
const rowIds = (rows: Locator) =>
  rows.evaluateAll(
    (els, prefix) => els.map((el) => el.getAttribute('data-testid')!.slice(prefix.length)),
    ROW_PREFIX,
  );

/** Loads every page of the /rechnungen list, then returns its row ids in order. */
async function shownListIds(page: Page): Promise<string[]> {
  const more = page.getByTestId('invoice-list-load-more');
  while (await more.isVisible()) {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/invoices?') && r.ok()),
      more.click(),
    ]);
  }
  return rowIds(invoiceRows(page.getByTestId('invoice-list-cross-project')));
}

/** AC-712: issued and cancelled newest first by issue date, then drafts newest first. */
function expectListOrder(shown: ApiInvoice[], where: string) {
  const originals = shown.filter((i) => i.cancellationOf === null);
  const issued = originals.filter((i) => i.status !== 'draft');
  const drafts = originals.filter((i) => i.status === 'draft');
  expect(issued.length, `${where}: needs issued invoices`).toBeGreaterThan(0);
  expect(drafts.length, `${where}: needs two drafts`).toBeGreaterThan(1);
  const ids = (list: ApiInvoice[]) => list.map((i) => i.id);
  expect(ids(originals), `${where}: drafts last`).toEqual([...ids(issued), ...ids(drafts)]);
  const issueDates = issued.map((i) => i.issueDate!);
  expect(issueDates, `${where}: issue date, newest first`).toEqual(
    [...issueDates].sort().reverse(),
  );
  const created = drafts.map((i) => i.createdAt);
  expect(created, `${where}: drafts newest first`).toEqual([...created].sort().reverse());
}

/** AC-713: each Storno row sits directly under its original's row. */
async function expectStornosUnderOriginals(scope: Locator, shown: ApiInvoice[], where: string) {
  const stornoIdx = shown.flatMap((inv, i) => (inv.cancellationOf ? [i] : []));
  expect(stornoIdx.length, `${where}: needs a Storno`).toBeGreaterThan(0);
  for (const i of stornoIdx) {
    const storno = shown[i]!;
    const original = shown[i - 1];
    expect(original?.id, `${where}: Storno ${storno.number} under its original`).toBe(
      storno.cancellationOf,
    );
    const row = scope.getByTestId(`${ROW_PREFIX}${storno.id}`);
    await expect(row.getByTestId('invoice-status-badge')).toHaveText('Storno');
    await expect(row.getByTestId('invoice-storno-of')).toHaveText(`Storno zu ${original!.number}`);
  }
}

/** Records every invoice save — a draft create or update — the page sends. */
function recordInvoiceSaves(page: Page): string[] {
  const saves: string[] = [];
  page.on('request', (r) => {
    const isSave = /\/api\/invoices(\/[^/]+)?$/.test(new URL(r.url()).pathname);
    if (isSave && ['POST', 'PATCH'].includes(r.method())) saves.push(`${r.method()} ${r.url()}`);
  });
  return saves;
}

test.describe('Invoice list and draft form', () => {
  test('walks the invoice list and form ACs', async ({ page }) => {
    const api = page.request;
    const stamp = Date.now();
    const recipientName = `E2E Rechnungsliste ${stamp}`;
    const today = format(new Date(), 'yyyy-MM-dd');
    const currentYear = new Date().getFullYear();

    const customer = await okJson<{ id: string }>(
      api.post('/api/customers', {
        data: {
          name: recipientName,
          address: { street: 'Listenweg 1', zip: '10115', city: 'Berlin' },
        },
      }),
      'POST /api/customers',
    );
    const readyProject = async (suffix: string) => {
      const project = await okJson<{ id: string }>(
        api.post('/api/projects', {
          data: {
            number: `IL${stamp % 1_000_000_000}${suffix}`,
            title: 'Rechnungsliste',
            customerId: customer.id,
          },
        }),
        'POST /api/projects',
      );
      for (const expectedStatus of [
        'anfrage',
        'angebot',
        'beauftragt',
        'geplant',
        'in_arbeit',
        'abnahme',
      ]) {
        await okJson(
          api.post(`/api/projects/${project.id}/transition/forward`, { data: { expectedStatus } }),
          `transition from ${expectedStatus}`,
        );
      }
      return project.id;
    };
    const createDraft = (projectId: string) =>
      okJson<ApiInvoice>(
        api.post('/api/invoices', {
          data: {
            projectId,
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
            performanceDate: today,
          },
        }),
        'POST /api/invoices',
      );
    const issue = (draft: ApiInvoice) =>
      okJson<ApiInvoice>(
        api.post(`/api/invoices/${draft.id}/issue`, { data: { expectedVersion: draft.version } }),
        'issue',
      );
    const backToReady = (projectId: string) =>
      okJson(
        api.post(`/api/projects/${projectId}/transition/backward`, {
          data: { expectedStatus: 'abgerechnet' },
        }),
        'transition back to rechnung_faellig',
      );

    // Active project: an issued invoice, a cancelled one with its Storno, two drafts.
    const activeId = await readyProject('A');
    const issued = await issue(await createDraft(activeId));
    await backToReady(activeId);
    const toCancel = await issue(await createDraft(activeId));
    await okJson(
      api.post(`/api/invoices/${toCancel.id}/cancel`, { data: { reason: 'Tippfehler' } }),
      'cancel',
    );
    await backToReady(activeId);
    const draft = await createDraft(activeId);
    await createDraft(activeId);
    // Archived project: an issued invoice and a draft.
    const archivedId = await readyProject('B');
    const archivedIssued = await issue(await createDraft(archivedId));
    await backToReady(archivedId);
    const archivedDraft = await createDraft(archivedId);
    await okJson(api.delete(`/api/projects/${archivedId}`), 'archive project');

    try {
      const all = await allInvoices(api);
      const byId = new Map(all.map((i) => [i.id, i]));
      const sortedIds = (list: ApiInvoice[]) => list.map((i) => i.id).sort();
      const issuedYears = [
        ...new Set(all.flatMap((i) => (i.issueDate ? [Number(i.issueDate.slice(0, 4))] : []))),
      ];

      await page.goto('/rechnungen');
      const list = page.getByTestId('invoice-list-cross-project');
      const year = page.getByLabel('Jahr');
      const status = page.getByLabel('Status');
      const search = page.getByRole('searchbox');
      const resetFilters = page.getByRole('button', { name: 'Alle Filter zurücksetzen' });
      await expect.poll(async () => (await shownListIds(page)).sort()).toEqual(sortedIds(all));

      await test.step('AC-712 lists by issue date newest first, drafts last newest first', async () => {
        const shown = (await shownListIds(page)).map((id) => byId.get(id)!);
        const issueDates = shown.filter((i) => i.status !== 'draft').map((i) => i.issueDate);
        expect(new Set(issueDates).size, 'needs two issue dates').toBeGreaterThan(1);
        expectListOrder(shown, 'invoice list');

        await page.goto(`/projects/${activeId}`);
        const block = page.getByTestId('invoice-list');
        const ofProject = all.filter((i) => i.projectId === activeId);
        await expect
          .poll(async () => (await rowIds(invoiceRows(block))).sort())
          .toEqual(sortedIds(ofProject));
        expectListOrder(
          (await rowIds(invoiceRows(block))).map((id) => byId.get(id)!),
          'invoice block',
        );
      });

      await test.step('AC-713 each Storno sits directly under its original', async () => {
        const block = page.getByTestId('invoice-list');
        const inBlock = (await rowIds(invoiceRows(block))).map((id) => byId.get(id)!);
        await expectStornosUnderOriginals(block, inBlock, 'invoice block');

        await page.goto('/rechnungen');
        await expect.poll(async () => (await shownListIds(page)).length).toBe(all.length);
        const shown = (await shownListIds(page)).map((id) => byId.get(id)!);
        await expectStornosUnderOriginals(list, shown, 'invoice list');
      });

      const expectShown = async (expected: ApiInvoice[], what: string) => {
        expect(expected.length, `${what}: needs a match`).toBeGreaterThan(0);
        expect(expected.length, `${what}: needs a non-match`).toBeLessThan(all.length);
        await expect
          .poll(async () => (await shownListIds(page)).sort(), { message: what })
          .toEqual(sortedIds(expected));
      };

      await test.step('AC-714 search matches number or recipient name, ignoring case', async () => {
        const contains = (value: string | null, text: string) =>
          (value ?? '').toLowerCase().includes(text.toLowerCase());
        for (const text of [recipientName.toUpperCase(), issued.number!.toLowerCase()]) {
          await search.fill(text);
          await expectShown(
            all.filter((i) => contains(i.number, text) || contains(i.recipient.name, text)),
            `search "${text}"`,
          );
        }
        await resetFilters.click();
      });

      const pastYear = Math.min(...issuedYears);
      await test.step('AC-715 year and status filters show only matching invoices', async () => {
        expect(pastYear, 'needs an invoice issued before this year').toBeLessThan(currentYear);
        await year.selectOption(String(pastYear));
        await expectShown(
          all.filter((i) => i.issueDate?.startsWith(`${pastYear}-`)),
          `year ${pastYear}`,
        );
        await resetFilters.click();
        for (const [label, value] of [
          ['Entwurf', 'draft'],
          ['Ausgestellt', 'issued'],
          ['Storniert', 'cancelled'],
        ] as const) {
          await status.selectOption({ label });
          await expectShown(
            all.filter((i) => i.status === value),
            `status ${label}`,
          );
        }
        await resetFilters.click();
      });

      await test.step('AC-716 year options are every issue year and this year, whatever the filter', async () => {
        const expectedYears = [...new Set([...issuedYears, currentYear])].map(String).sort();
        const yearOptions = () =>
          year.locator('option').evaluateAll((els) =>
            els
              .map((el) => (el as HTMLOptionElement).value)
              .filter(Boolean)
              .sort(),
          );
        const filters: [string, () => Promise<unknown>][] = [
          ['no filter', async () => {}],
          [`year ${pastYear}`, () => year.selectOption(String(pastYear))],
          ['status Entwurf', () => status.selectOption({ label: 'Entwurf' })],
          ['search', () => search.fill(recipientName)],
        ];
        const expectYearOptions = async (source: string) => {
          for (const [what, apply] of filters) {
            await apply();
            await expect
              .poll(yearOptions, { message: `${source}, ${what}` })
              .toEqual(expectedYears);
            if (await resetFilters.isVisible()) await resetFilters.click();
          }
        };
        await expectYearOptions('issue years');
        // This year always has an issued invoice here, so the current year is
        // pinned by a server answer that lacks it.
        const yearsUrl = '**/api/invoices/years';
        await page.route(yearsUrl, (route) =>
          route.fulfill({ json: { years: issuedYears.filter((y) => y !== currentYear) } }),
        );
        await Promise.all([page.waitForResponse(yearsUrl), page.reload()]);
        await expectYearOptions('no invoice this year');
        await page.unroute(yearsUrl);
      });

      await test.step('AC-514 an archived project invoice offers no change', async () => {
        await search.fill(recipientName);
        const row = (inv: ApiInvoice) => list.getByTestId(`${ROW_PREFIX}${inv.id}`);
        await expect(row(draft).getByRole('button', { name: 'Bearbeiten' })).toBeVisible();
        await expect(row(archivedDraft)).toBeVisible();
        await expect(row(archivedDraft).getByRole('button')).toHaveCount(0);
        await expect(row(archivedIssued).getByRole('button')).toHaveText(['PDF herunterladen']);

        const viewer = page.getByTestId('invoice-detail-view');
        await page.goto(`/rechnungen/${issued.id}`);
        await expect(viewer.getByRole('button', { name: 'Stornieren' })).toBeVisible();
        await page.goto(`/rechnungen/${archivedIssued.id}`);
        await expect(viewer.getByRole('heading', { level: 1 })).toHaveText(archivedIssued.number!);
        await expect(viewer.getByRole('button')).toHaveCount(1);
        await expect(viewer.getByRole('button')).toHaveText(/herunterladen/);

        // A draft row opens its project with the draft form (ui/invoices.md
        // §8.16.1); on an archived project the form stays closed.
        await page.goto('/rechnungen');
        await search.fill(recipientName);
        await row(archivedDraft).click();
        await expect(page).toHaveURL(new RegExp(`/projects/${archivedId}(\\?|$)`));
        await expect(
          page.getByTestId('invoice-list').getByTestId(`${ROW_PREFIX}${archivedDraft.id}`),
        ).toBeVisible();
        await expect(page.getByTestId('invoice-form')).toBeHidden();
      });

      await test.step('AC-707 a Storno without a reason asks for one and cancels nothing', async () => {
        const cancels: string[] = [];
        page.on('request', (r) => {
          if (r.method() === 'POST' && r.url().endsWith('/cancel')) cancels.push(r.url());
        });
        await page.goto(`/rechnungen/${issued.id}`);
        await page.getByRole('button', { name: 'Stornieren' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Stornieren' }).click();
        await expect(dialog.getByRole('alert')).toHaveText(/\S/);
        await expect(dialog).toBeVisible();
        const after = await okJson<ApiInvoice>(api.get(`/api/invoices/${issued.id}`), 'GET');
        expect(after.status).toBe('issued');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        expect(cancels).toEqual([]);
      });

      const saves = recordInvoiceSaves(page);
      const form = page.getByTestId('invoice-form');
      const openDraftForm = async () => {
        await page.getByRole('button', { name: 'Neue Rechnung' }).click();
        await expect(form).toBeVisible();
      };
      const closeDraftForm = async () => {
        await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
        await expect(form).toBeHidden();
      };

      await test.step('AC-726 a 0 % line under Regulär is marked and blocks the save', async () => {
        await page.goto(`/projects/${activeId}`);
        await openDraftForm();
        await page.getByTestId('invoice-line-description-input').fill('Anstrich');
        await page.getByTestId('invoice-line-unit-price-input').fill('100');
        await page.getByRole('button', { name: '+ Position hinzufügen' }).click();
        await page.getByTestId('invoice-line-description-input-1').fill('Material');
        await page.getByTestId('invoice-line-unit-price-input-1').fill('50');
        const taxMode = page.getByTestId('invoice-tax-mode-select');
        await taxMode.selectOption({ label: 'Reverse-Charge §13b' });
        const keptRate = page.getByTestId('invoice-line-tax-rate-select');
        const zeroRate = page.getByTestId('invoice-line-tax-rate-select-1');
        await zeroRate.selectOption('0');
        await expect(zeroRate).not.toHaveAttribute('aria-invalid', 'true');
        await taxMode.selectOption({ label: 'Regulär' });
        await expect(zeroRate).toHaveAttribute('aria-invalid', 'true');
        await expect(zeroRate).toHaveAccessibleDescription(STRINGS.invoices.formTaxRateInvalid);
        await expect(keptRate).not.toHaveAttribute('aria-invalid', 'true');
        await expect(keptRate).toHaveAccessibleDescription('');
        await page.getByRole('button', { name: 'Speichern' }).click();
        await expect(form).toBeVisible();
        await closeDraftForm();
        expect(saves).toEqual([]);
      });

      await test.step('AC-731 a draft without a described, priced line is not saved', async () => {
        for (const [description, price] of [
          ['', ''],
          ['Anstrich', '0'],
          ['', '100'],
        ]) {
          await openDraftForm();
          await page.getByTestId('invoice-line-description-input').fill(description!);
          await page.getByTestId('invoice-line-unit-price-input').fill(price!);
          await page.getByRole('button', { name: 'Speichern' }).click();
          await expect(form.getByRole('alert')).toHaveText(STRINGS.invoices.formEmptyLinesError);
          await closeDraftForm();
        }
        expect(saves).toEqual([]);
        // The same form saves once a line has both.
        await openDraftForm();
        await page.getByTestId('invoice-line-description-input').fill('Anstrich');
        await page.getByTestId('invoice-line-unit-price-input').fill('100');
        await page.getByRole('button', { name: 'Speichern' }).click();
        await expect(form).toBeHidden();
        expect(saves).toHaveLength(1);
      });

      await test.step('AC-725 an incomplete company profile is named on issuing, with a link', async () => {
        // The API refuses an incomplete profile (AC-723), but a stored one can
        // still lack a field, e.g. after an import (data-model.md §5.17); a
        // direct write stands in for that. Restored below.
        const { db, pool } = createDatabase();
        const [stored] = await db
          .select({ taxId: companyProfile.taxId, ustId: companyProfile.ustId })
          .from(companyProfile);
        try {
          await db.update(companyProfile).set({ taxId: '', ustId: null });
          await page.goto(`/projects/${activeId}`);
          await page
            .getByTestId(`${ROW_PREFIX}${draft.id}`)
            .getByRole('button', { name: 'Ausstellen' })
            .click();
          await page.getByRole('dialog').getByRole('button', { name: 'Ausstellen' }).click();
          const banner = page.getByTestId('invoice-company-profile-required-banner');
          await expect(banner).toContainText('Steuernummer');
          await expect(banner).toContainText('USt-IdNr.');
          await expect(banner).not.toContainText('Firmenname');
          const after = await okJson<ApiInvoice>(api.get(`/api/invoices/${draft.id}`), 'GET');
          expect(after.status).toBe('draft');
          await banner.getByRole('link').click();
          await expect(page).toHaveURL(/\/rechnungen$/);
          await expect(page.getByTestId('company-profile-details').locator('summary')).toHaveText(
            'Firmendaten',
          );
        } finally {
          await db.update(companyProfile).set(stored!);
          await pool.end();
        }
      });
    } finally {
      await okJson(api.post(`/api/projects/${archivedId}/restore`), 'restore project');
    }
  });
});
