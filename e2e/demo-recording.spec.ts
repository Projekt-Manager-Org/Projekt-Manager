/**
 * Demo recording — LLM email-extraction walkthrough.
 *
 * This is NOT a regular test. It hits the real extraction API and is
 * paced for a viewer via `step()` captions + a visible cursor. It runs
 * under both the `demo` (desktop) and `demo-mobile` projects, so one
 * authored scenario yields a desktop and a mobile clip.
 *
 * Prerequisites:
 *   - `OPENROUTER_API_KEY` configured in `.env` (the extraction is real).
 *   - Nothing else: the `demo`/`demo-mobile` projects depend on `setup`,
 *     which boots the e2e stack and seeds the realistic snapshot.
 *
 * Run + encode to MP4:
 *   npm run demo
 *
 * Run only this scenario, headed:
 *   PLAYWRIGHT_RUN_DEMO=1 npx playwright test e2e/demo-recording.spec.ts \
 *     --project=demo --headed
 *
 * Output: `test-results/<folder>/video.webm` → `demo.mp4` (captions burned in).
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';

/* Fresh session — no saved auth, so the recording starts at the login screen. */
test.use({ storageState: { cookies: [], origins: [] } });

/* LLM extraction can take a while; generous timeout for a demo. */
test.setTimeout(120_000);

/** Sample email #1 from src/test/fixtures/sample-emails.ts — all fields present. */
const SAMPLE_EMAIL = [
  'Sehr geehrte Damen und Herren,',
  '',
  'wir möchten Sie bitten, uns ein Angebot für die Renovierung unserer Büroräume zu erstellen.',
  'Es handelt sich um ca. 200 qm Bürofläche. Die Arbeiten umfassen Malerarbeiten (Wände und Decken)',
  'sowie die Erneuerung des Bodenbelags in drei Büroräumen.',
  '',
  'Mit freundlichen Grüßen,',
  'Hans Meier',
  'Geschäftsführer',
  'Meier & Partner Steuerberatung GmbH',
  'Tel: +49 2202 98765',
  'E-Mail: h.meier@meier-partner.de',
  'Hauptstraße 42',
  '51465 Bergisch Gladbach',
].join('\n');

test('E-Mail-Extraktion per KI', async ({ page }) => {
  const demo = await startDemo(page);

  // toggled locally when recording the demo in a specific theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await demo.step('Anmeldung am System', async () => {
    await expect(page.getByTestId('login-form')).toBeVisible();
    await demo.type(page.getByTestId('login-username'), 'inhaber', { delay: 80 });
    await demo.type(page.getByTestId('login-password'), 'changeme', { delay: 80 });
    await demo.click(page.getByTestId('login-submit'));
    await expect(page.getByTestId('kanban-board')).toBeVisible();
  });

  await demo.step('Eingang einer Kundenanfrage per E-Mail', async () => {
    await demo.click(page.getByTestId('extract-button'));
    await expect(page.getByTestId('extract-email-input')).toBeVisible();
  });

  await demo.step('E-Mail-Text einfügen', async () => {
    await demo.fill(page.getByTestId('extract-email-input'), SAMPLE_EMAIL);
  });

  await demo.step(
    'Die KI extrahiert Kunden- und Projektdaten …',
    async () => {
      await demo.click(page.getByTestId('extract-submit'));
      // The review view appears once extraction succeeds; the customer-name
      // field is only present in that second stage, so it signals completion.
      await expect(page.getByTestId('extract-customer-name')).toBeVisible({ timeout: 60_000 });
    },
    { holdMs: 0 },
  );

  await demo.step(
    'Erkannte Daten prüfen und übernehmen',
    async () => {
      // Let the viewer read the populated fields.
    },
    { settleMs: 1500, holdMs: 4000 },
  );
});
