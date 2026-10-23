import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { STATE_KEYS, type WorkflowState } from '../src/config/stateConfig';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — stale-write recovery (ui/behavior.md §9.5, data-model.md §6.4).
 *
 *   - AC-379: an invoice draft form whose draft another session changes
 *     is rejected with the stale-write message and shows the refetched
 *     draft — a background refresh while the form is open does not
 *     advance the version it sends.
 *   - AC-382: the `Ausstellen` / `Verwerfen` dialogs preview the draft and
 *     send the previewed version — a background refresh while the dialog
 *     is open does not advance it.
 *
 * The owner drives the browser; a separate office request context plays
 * the other session. Each test mints its own fixtures, so the seed stays
 * untouched. Runs under `chromium-mutating`.
 */

test.use({ storageState: STORAGE_STATES.owner });

const STALE_MESSAGE =
  'Inzwischen geändert. Die aktuelle Fassung wurde geladen – bitte erneut versuchen.';

/** Budget for a `*_changed` SSE frame to reach the owner page (AC-277 parity). */
const SSE_PROPAGATION_TIMEOUT_MS = 2_000;

const LINE = {
  description: 'Anstrich Fassade',
  quantity: 1,
  unit: 'pauschal',
  unitPrice: 1500,
  lineTotal: 1500,
  taxRate: 19,
};

const officeContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(officeContexts.splice(0).map((c) => c.close()));
});

function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function officeRequest(browser: Browser): Promise<APIRequestContext> {
  const context = await browser.newContext({ storageState: STORAGE_STATES.office });
  officeContexts.push(context);
  return context.request;
}

async function mintProject(
  request: APIRequestContext,
  status: WorkflowState,
): Promise<{ projectId: string; customerName: string }> {
  const customerName = `Stale-Kunde ${suffix()}`;
  // A billing address makes drafts on the project issuable (AC-289).
  const customer = await request.post('/api/customers', {
    data: {
      name: customerName,
      address: { street: 'Hauptstr. 12', zip: '51465', city: 'Bergisch Gladbach' },
    },
  });
  expect(customer.status(), await customer.text()).toBe(201);
  const project = await request.post('/api/projects', {
    data: {
      number: `SW-${suffix()}`,
      title: `Stale-write ${suffix()}`,
      customerId: (await customer.json()).id,
    },
  });
  expect(project.status(), await project.text()).toBe(201);
  const projectId = (await project.json()).id as string;
  // A project starts in the first state (AC-475); walk it forward.
  for (const expectedStatus of STATE_KEYS.slice(0, STATE_KEYS.indexOf(status))) {
    const step = await request.post(`/api/projects/${projectId}/transition/forward`, {
      data: { expectedStatus },
    });
    expect(step.status(), await step.text()).toBe(200);
  }
  return { projectId, customerName };
}

async function mintDraft(
  office: APIRequestContext,
): Promise<{ projectId: string; invoiceId: string; customerName: string }> {
  const { projectId, customerName } = await mintProject(office, 'rechnung_faellig');
  const draft = await office.post('/api/invoices', {
    data: { projectId, lines: [LINE], taxMode: 'standard', performanceDate: '2026-04-10' },
  });
  expect(draft.status(), await draft.text()).toBe(201);
  return { projectId, invoiceId: (await draft.json()).id, customerName };
}

async function version(request: APIRequestContext, url: string): Promise<number> {
  const res = await request.get(url);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).version;
}

/** Office edits the draft's line price: 2.000,00 net → 2.380,00 gross. */
async function officeRepricesDraft(office: APIRequestContext, invoiceId: string): Promise<void> {
  const edit = await office.patch(`/api/invoices/${invoiceId}`, {
    data: {
      lines: [{ ...LINE, unitPrice: 2000, lineTotal: 2000 }],
      expectedVersion: await version(office, `/api/invoices/${invoiceId}`),
    },
  });
  expect(edit.ok(), await edit.text()).toBe(true);
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByTestId('project-detail-page')).toBeVisible();
}

test.describe('AC-379: edits recover from a stale write', () => {
  test('the draft form sends the version it opened with and resets to the refetched draft', async ({
    page,
    browser,
  }) => {
    const office = await officeRequest(browser);
    const { projectId, invoiceId } = await mintDraft(office);
    await openProject(page, projectId);

    const row = page.getByTestId(`invoice-row-${invoiceId}`);
    await row.getByTestId('invoice-draft-edit').click();
    const form = page.getByTestId('invoice-form');
    await expect(form).toBeVisible();
    await page.getByTestId('invoice-line-description-input').fill('Vom Inhaber geändert');

    await officeRepricesDraft(office, invoiceId);
    await expect(row).toContainText(/2\.380,00/, { timeout: SSE_PROPAGATION_TIMEOUT_MS });

    const save = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        new URL(res.url()).pathname === `/api/invoices/${invoiceId}`,
    );
    await page.getByTestId('invoice-form-save').click();
    expect((await save).status()).toBe(409);
    await expect(page.getByText(STALE_MESSAGE)).toBeVisible();
    await expect(form).toBeVisible();
    await expect(page.getByTestId('invoice-line-description-input')).toHaveValue(LINE.description);
    await expect(page.getByTestId('invoice-line-unit-price-input')).toHaveValue(/^2\.?000(,00)?$/);

    const stored = await (await office.get(`/api/invoices/${invoiceId}`)).json();
    expect(stored.lines[0].description).toBe(LINE.description);
  });
});

test.describe('AC-382: issue / discard dialogs preview and pin the draft', () => {
  for (const action of [
    { name: 'Ausstellen', button: 'invoice-issue-button', path: '/issue', method: 'POST' },
    { name: 'Verwerfen', button: 'invoice-draft-delete', path: '', method: 'DELETE' },
  ] as const) {
    test(`${action.name}: the dialog previews the draft and a change behind it is rejected`, async ({
      page,
      browser,
    }) => {
      const office = await officeRequest(browser);
      const { projectId, invoiceId, customerName } = await mintDraft(office);
      await openProject(page, projectId);

      const row = page.getByTestId(`invoice-row-${invoiceId}`);
      await expect(row).toBeVisible();
      await row.getByTestId(action.button).click();

      const dialog = page.getByTestId('confirm-dialog');
      await expect(dialog).toBeVisible();
      // What will be frozen or discarded: recipient, lines, taxMode,
      // performanceDate, totals (1 × 1.500,00 net + 19 % = 1.785,00 gross).
      await expect(dialog).toContainText(customerName);
      await expect(dialog).toContainText(LINE.description);
      await expect(dialog).toContainText('Regulär');
      await expect(dialog).toContainText('10.04.2026');
      await expect(dialog).toContainText(/1\.785,00/);

      // Office changes the draft while the dialog is open. The row behind
      // the dialog refreshes; the dialog keeps what the user is confirming.
      await officeRepricesDraft(office, invoiceId);
      await expect(row).toContainText(/2\.380,00/, { timeout: SSE_PROPAGATION_TIMEOUT_MS });
      await expect(dialog).toContainText(/1\.785,00/);

      const response = page.waitForResponse(
        (res) =>
          res.request().method() === action.method &&
          new URL(res.url()).pathname === `/api/invoices/${invoiceId}${action.path}`,
      );
      await page.getByTestId('confirm-ok').click();
      expect((await response).status()).toBe(409);
      await expect(page.getByText(STALE_MESSAGE)).toBeVisible();

      const stored = await office.get(`/api/invoices/${invoiceId}`);
      expect(stored.ok()).toBe(true);
      const body = await stored.json();
      expect(body.status).toBe('draft');
      expect(body.lines[0].unitPrice).toBe(2000);
    });
  }
});
