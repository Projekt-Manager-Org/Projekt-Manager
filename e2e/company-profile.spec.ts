import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * E2E — Company profile management (verification.md §16.3 "Company
 * profile management", pins AC-301, AC-303 at the UI layer).
 *
 * Lives on the Rechnungen tab (`/rechnungen`) inside a collapsible
 * `<details>` — the values are referenced by every invoice snapshot
 * (ADR-0026), so the form sits where invoices are managed. The block
 * is collapsed by default; each test opens it.
 *
 * Three flows:
 *   1. Owner opens Firmendaten, fills every required field plus
 *      `defaultTaxMode = 'standard'` with a `ustId`, saves. A
 *      subsequent `GET /api/company-profile` returns the persisted
 *      values.
 *   2. Owner attempts to save with `defaultTaxMode = 'reverse_charge'`
 *      and an empty `ustId`; the form blocks submit with a German
 *      validation message naming the missing field.
 *   3. Office user opens the section; it is read-only (no save button
 *      rendered) per AC-301.
 */

test.describe.configure({ mode: 'serial' });

test.describe('Company profile management (AC-301, AC-303)', () => {
  test.describe('Owner flow', () => {
    test.use({ storageState: STORAGE_STATES.owner });

    test('owner fills the form and saves; GET returns the persisted values', async ({ page }) => {
      await page.goto('/rechnungen');
      await expect(page.getByTestId('invoice-list-view')).toBeVisible();

      // Firmendaten lives inside a `<details>` collapsed by default; open it.
      const details = page.getByTestId('company-profile-details');
      await details.locator('summary').click();
      const form = page.getByTestId('company-profile-form');
      await expect(form).toBeVisible();

      const stamp = Date.now().toString(36);
      const companyName = `Berger Maler GmbH ${stamp}`;
      const ustId = 'DE123456789';

      await form.getByTestId('company-profile-companyName-input').fill(companyName);
      await form.getByTestId('company-profile-street-input').fill('Werkstr. 1');
      await form.getByTestId('company-profile-zip-input').fill('10115');
      await form.getByTestId('company-profile-city-input').fill('Berlin');
      await form.getByTestId('company-profile-taxId-input').fill('111/222/33333');
      await form.getByTestId('company-profile-ustId-input').fill(ustId);
      await form.getByTestId('company-profile-defaultTaxMode-select').selectOption('standard');

      await Promise.all([
        page.waitForResponse((resp) => resp.url().includes('/api/company-profile') && resp.ok()),
        form.getByTestId('company-profile-save').click(),
      ]);

      // Persistence assertion via a fresh GET — the page reload
      // ensures the read goes through the route, not the in-memory
      // form state.
      await page.reload();
      await page.getByTestId('company-profile-details').locator('summary').click();
      const formAfter = page.getByTestId('company-profile-form');
      await expect(formAfter).toBeVisible();
      await expect(formAfter.getByTestId('company-profile-companyName-input')).toHaveValue(
        companyName,
      );
      await expect(formAfter.getByTestId('company-profile-ustId-input')).toHaveValue(ustId);
    });

    test('reverse_charge with empty ustId blocks submit with a German validation message naming the field', async ({
      page,
    }) => {
      await page.goto('/rechnungen');
      await page.getByTestId('company-profile-details').locator('summary').click();
      const form = page.getByTestId('company-profile-form');
      await expect(form).toBeVisible();

      // Set reverse_charge and clear ustId.
      await form
        .getByTestId('company-profile-defaultTaxMode-select')
        .selectOption('reverse_charge');
      const ustIdInput = form.getByTestId('company-profile-ustId-input');
      await ustIdInput.fill('');

      // Submit. The form must NOT fire a save request — client-side
      // validation blocks. We watch the request stream for the PUT and
      // assert the validation message lands first; the network idle
      // wait closes the window without a flaky fixed timeout.
      let fired = false;
      page.on('request', (req) => {
        if (req.url().includes('/api/company-profile') && req.method() === 'PUT') fired = true;
      });
      await form.getByTestId('company-profile-save').click();
      // Wait for the error message to render — a successful regression
      // would fire the PUT immediately; the validation should land first.
      const error = form.getByTestId('company-profile-ustId-error');
      await expect(error).toBeVisible();
      // The German validation copy is `[C]`; pin the linguistic root.
      await expect(error).toContainText(/USt-IdNr|UStIdNr|ustId/i);
      // Give any sneak-through PUT a deterministic window to surface to
      // the request listener. `networkidle` is the wrong primitive in
      // this app — the auth-gated SSE connection (`/api/events`,
      // ADR-0025) keeps the network active for the lifetime of the
      // session, so it would never resolve. A short fixed wait is
      // enough: a regression-emitted PUT fires synchronously off the
      // click event and reaches the request listener within one
      // microtask. 300 ms catches that with margin.
      await page.waitForTimeout(300);
      expect(fired).toBe(false);
    });
  });

  test.describe('Office flow', () => {
    test.use({ storageState: STORAGE_STATES.office });

    test('office sees the company-profile section as read-only (no save button)', async ({
      page,
    }) => {
      await page.goto('/rechnungen');
      await expect(page.getByTestId('invoice-list-view')).toBeVisible();
      await page.getByTestId('company-profile-details').locator('summary').click();

      // The section renders (every authenticated role may read per
      // AC-301), but the save affordance is not rendered for office.
      const form = page.getByTestId('company-profile-form');
      await expect(form).toBeVisible();
      // The values are visible (read-only display).
      await expect(form.getByTestId('company-profile-companyName-input')).toBeVisible();
      // No save button — owner-only mutation surface per AC-301.
      await expect(form.getByTestId('company-profile-save')).toHaveCount(0);
    });
  });
});
