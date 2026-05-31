/**
 * Demo segment 01 — Anfrage (intake). The office worker turns an inbound
 * customer email into a customer + project via LLM extraction. Carries the
 * "built around how you already work" promise: paste, review, done — no
 * double typing.
 *
 * office · desktop (1920×1080). Hits the real extraction API
 * (OPENROUTER_API_KEY in .env). Recorded by the `demo` project; the
 * numeric filename prefix fixes its position in the concatenated master.
 */
import { test, expect } from '@playwright/test';
import { startDemo } from './demo-helpers';
import { STORAGE_STATES } from './storage-states';

test.use({ storageState: STORAGE_STATES.office });
test.setTimeout(120_000);

/** A believable local Handwerker inquiry — a Fassade job (matches the
 *  exterior site photos used later in the field segment). Deliberately
 *  more than the bare minimum: a referral opener, building details, the
 *  actual problem, a rough timeline and a callback preference — the kind
 *  of real, slightly rambling email the LLM has to distil a clean
 *  customer + project out of. No competing person-name (the referral is
 *  anonymous) so the extraction lands on "Familie Brandt" unambiguously. */
const INQUIRY = [
  'Sehr geehrte Damen und Herren,',
  '',
  'auf Empfehlung eines Nachbarn wende ich mich an Sie. Die Fassade unseres',
  'Einfamilienhauses (Baujahr 1998, zweigeschossig, ca. 140 m²) ist an der',
  'Wetterseite stark verwittert – der Putz blättert stellenweise ab.',
  '',
  'Wir möchten die Fassade im Frühjahr neu streichen lassen, gerne inklusive',
  'kleinerer Ausbesserungen am Putz. Könnten Sie sich das vor Ort ansehen und',
  'uns ein Angebot erstellen? Vormittags sind wir am besten erreichbar.',
  '',
  'Mit freundlichen Grüßen',
  'Familie Brandt',
  'Lindenweg 9',
  '51427 Bergisch Gladbach',
  'Tel.: +49 2202 445566',
  'E-Mail: brandt.familie@example.de',
].join('\n');

test('01 — Anfrage per E-Mail', async ({ page }) => {
  const demo = await startDemo(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await demo.scene({ name: 'Maria Schmidt', role: 'Büro', device: 'Desktop' });

  await demo.step('Eine neue Kundenanfrage – per E-Mail.', async () => {
    await demo.click(page.getByTestId('extract-button'));
    await expect(page.getByTestId('extract-email-input')).toBeVisible();
    // Enlarge the resizable textarea so more of the pasted email is visible.
    await page.getByTestId('extract-email-input').evaluate((el) => {
      (el as HTMLElement).style.height = '440px';
    });
  });

  await demo.step('Einfügen genügt – den Rest erledigt die App.', async () => {
    await demo.fill(page.getByTestId('extract-email-input'), INQUIRY);
  });

  await demo.step(
    'Die KI erkennt Kunde und Projekt im Text.',
    async () => {
      await demo.click(page.getByTestId('extract-submit'));
      // The review stage (and the customer-name field) appears only once
      // extraction succeeds — use it as the completion signal.
      await expect(page.getByTestId('extract-customer-name')).toBeVisible({ timeout: 60_000 });
    },
    { holdMs: 0 },
  );

  await demo.step(
    'Erkannte Daten kurz prüfen.',
    async () => {
      // Let the viewer read the auto-filled customer + project fields.
    },
    { settleMs: 1200, holdMs: 2500 },
  );

  await demo.step(
    'Übernehmen – fertig.',
    async () => {
      await demo.click(page.getByTestId('extract-save'));
      // Save closes the modal; the review field disappearing signals success.
      await expect(page.getByTestId('extract-customer-name')).toBeHidden({ timeout: 15_000 });
    },
    { holdMs: 600 },
  );

  await demo.step(
    'Das neue Projekt steht auf dem Board.',
    async () => {
      // The freshly created project lands on the board; glide the cursor
      // onto its card so the viewer's eye follows the import to where it
      // came to rest. Located by the customer name from the email —
      // deterministic, unlike the LLM-derived project title.
      const newCard = page
        .locator('[data-testid^="project-card-"]')
        .filter({ hasText: 'Brandt' })
        .first();
      await expect(newCard).toBeVisible({ timeout: 10_000 });
      await demo.moveTo(newCard);
    },
    { holdMs: 3000 },
  );
});
