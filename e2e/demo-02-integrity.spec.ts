/**
 * Demo segment 02 — Datenschutz (referential integrity). An administrator
 * tries to delete a customer that still has a live project; the app refuses.
 * Carries the "your data is safe — even from you" promise: integrity is
 * enforced server-side, in a transaction, not left to careful clicking.
 * (Only the owner role holds customer:delete, so the danger button renders.)
 *
 * owner · desktop (1920×1080). The seeded customer "Familie Müller" owns an
 * active project (2024-001, Fassadenanstrich), so the delete returns a 409 and
 * the inline refusal banner appears. Recorded by the `demo` project; the
 * numeric filename prefix fixes its position in the concatenated master.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';
import { clickView } from './nav-helpers';

test.use({ storageState: STORAGE_STATES.owner });
test.setTimeout(60_000);

test('02 — Datenschutz', async ({ page }) => {
  const demo = await startDemo(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await demo.step('Daten – das Herzstück des Betriebs.', async () => {
    await clickView(page, 'kunden');
    await expect(page.getByTestId('customer-table')).toBeVisible();
  });

  // The seeded "Familie Müller" row carries a live project, so its delete is
  // the one that gets refused. The danger button has no testid — locate it by
  // its role + label ("Löschen"), scoped to that row.
  const muellerRow = page
    .getByTestId('customer-table')
    .locator('tr', { hasText: 'Familie Müller' });

  await demo.step('Einen Kunden mit laufenden Projekten löschen?', async () => {
    await demo.click(muellerRow.getByRole('button', { name: 'Löschen' }));
    // The delete first fetches detail, then opens the shared confirm dialog.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  });

  await demo.step('Bestätigen.', async () => {
    await demo.click(page.getByTestId('confirm-ok'));
    // The dialog closes once the (doomed) delete request is in flight.
    await expect(page.getByTestId('confirm-dialog')).toBeHidden();
  });

  await demo.step(
    'Die App schützt die Daten – auch vor Ihnen.',
    async () => {
      // The 409 surfaces as the inline error banner. Assert on the
      // active-projects refusal specifically (not the broader invoice
      // refusal, which shares the "nicht gelöscht werden" prefix).
      await expect(page.getByText(/aktive Projekte zugeordnet/)).toBeVisible();
    },
    {
      note: 'referenzielle Integrität – serverseitig, in einer Transaktion geprüft',
      holdMs: 3500,
    },
  );
});
