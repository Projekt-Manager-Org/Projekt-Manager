import { test, expect } from '@playwright/test';
import { STORAGE_STATES } from './storage-states';

/**
 * Email intake Review step — the project number's free / taken verdict
 * (AC-478, AC-479), as on Create Project.
 *
 * The extraction service is external, so its answer is stubbed; the
 * verdict itself runs against the seeded project list.
 */

test.use({ storageState: STORAGE_STATES.owner });

test('AC-478: the review form checks the number it would save', async ({ page }) => {
  // The entry shows only while extraction is configured; e2e has no key.
  await page.route('**/api/extract/status', (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route('**/api/extract', (route) =>
    route.fulfill({
      json: {
        customer: {
          name: 'E2E Intake Kunde',
          phone: null,
          email: null,
          street: null,
          zip: null,
          city: null,
        },
        project: { title: 'Dachrinne erneuern', description: null, siteAddress: null },
      },
    }),
  );
  const listed = await page.request.get('/api/projects?limit=1&includeArchived=true');
  const takenNumber = ((await listed.json()) as { data: { number: string }[] }).data[0]!.number;

  await page.goto('/');
  await page.getByTestId('extract-button').click();
  await page.getByTestId('extract-email-input').fill('Bitte die Dachrinne erneuern.');
  await page.getByTestId('extract-submit').click();

  // Opening the review form checks the generated number it shows.
  const verdict = page
    .getByTestId('project-number-available')
    .or(page.getByTestId('project-number-taken'));
  await expect(verdict).toBeVisible();

  // Leaving the field checks the typed number.
  const numberInput = page.getByTestId('extract-project-number');
  await numberInput.fill(takenNumber);
  await expect(verdict).toHaveCount(0); // AC-479: an edit clears the old verdict
  await page.getByTestId('extract-project-title').focus();
  await expect(page.getByTestId('project-number-taken')).toContainText(takenNumber);
});

test('AC-478: a failed number check shows no verdict', async ({ page }) => {
  // The entry shows only while extraction is configured; e2e has no key.
  await page.route('**/api/extract/status', (route) =>
    route.fulfill({ json: { configured: true } }),
  );
  await page.route('**/api/extract', (route) =>
    route.fulfill({
      json: {
        customer: {
          name: 'E2E Intake Kunde',
          phone: null,
          email: null,
          street: null,
          zip: null,
          city: null,
        },
        project: { title: 'Dachrinne erneuern', description: null, siteAddress: null },
      },
    }),
  );
  const isNumberCheck = (url: URL) =>
    url.pathname === '/api/projects' && url.searchParams.has('search');
  await page.route(isNumberCheck, (route) =>
    route.fulfill({ status: 500, json: { code: 'SERVER_ERROR', message: 'Serverfehler' } }),
  );

  await page.goto('/');
  await page.getByTestId('extract-button').click();
  await page.getByTestId('extract-email-input').fill('Bitte die Dachrinne erneuern.');
  const check = page.waitForResponse((res) => isNumberCheck(new URL(res.url())));
  await page.getByTestId('extract-submit').click();
  await check;
  await expect(page.getByTestId('extract-project-number')).toBeVisible();

  await expect(page.getByTestId('project-number-available')).toHaveCount(0);
  await expect(page.getByTestId('project-number-taken')).toHaveCount(0);
});
