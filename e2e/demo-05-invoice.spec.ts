/**
 * Demo segment 05 — Rechnung (invoice). The office worker closes the loop:
 * the job is done, so it gets invoiced, and the finished invoice is one
 * click away as a PDF (ZUGFeRD / EN16931 — XML embedded in a PDF/A-3).
 * Carries the "compliant paperwork without the paperwork" promise.
 *
 * office · desktop (1920×1080). Read-only walkthrough over the seeded
 * issued invoices — it does NOT issue a new one (that flow needs project
 * context and is multi-step). Recorded by the `demo` project; the numeric
 * filename prefix fixes its position in the concatenated master.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

test.use({ storageState: STORAGE_STATES.office });
test.setTimeout(60_000);

test('05 — Rechnung als PDF', async ({ page }) => {
  const demo = await startDemo(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  // First issued (status "Ausgestellt") row. The list orders by
  // `issueDate DESC NULLS LAST` (invoice-read.ts), so the newest issued
  // original sits at the top and drafts sink to the bottom. We still gate
  // on the status badge rather than trusting position: only an *issued*
  // invoice carries the ZUGFeRD profile and the per-row PDF download, so
  // this guarantees the detail we open shows the ZUGFeRD payoff regardless
  // of seed/order drift. (Draft rows have no `invoice-download-pdf`.)
  const issuedRow = page
    .locator('[data-testid^="invoice-row-"]')
    .filter({ has: page.getByTestId('invoice-status-badge').getByText('Ausgestellt', { exact: true }) })
    .first();

  await demo.step(
    'Arbeit erledigt – Zeit für die Rechnung.',
    async () => {
      await clickView(page, 'rechnungen');
      await expect(page.getByTestId('invoice-list-view')).toBeVisible();
    },
    { settleMs: 800, holdMs: 1800 },
  );

  await demo.step(
    'Jede Rechnung sauber dokumentiert.',
    async () => {
      await demo.click(issuedRow);
      await expect(page.getByTestId('invoice-detail-view')).toBeVisible();
    },
    { settleMs: 1000, holdMs: 2200 },
  );

  await demo.step(
    'Ein Klick: als PDF – oder ZUGFeRD fürs Finanzamt.',
    async () => {
      // The download button triggers a real browser download (no on-screen
      // PDF). Arm the download wait BEFORE the click, then swallow it, so
      // the click does not hang on an unhandled download event. The visual
      // payoff is the formatted invoice page + the click itself.
      const download = page.waitForEvent('download');
      await demo.click(page.getByTestId('invoice-detail-download-pdf'));
      await download.catch(() => {});
    },
    { note: 'ZUGFeRD / EN16931 – XML im PDF/A-3 eingebettet', holdMs: 3000 },
  );
});
